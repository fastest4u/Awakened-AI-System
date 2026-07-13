export type Command =
  | "validate"
  | "report"
  | "fix"
  | "migrate"
  | "init"
  | "diagnose"
  | "orchestrator-init"
  | "orchestrator-status"
  | "orchestrator-integrity"
  | "help";

export interface CliOptions {
  command: Command;
  dryRun: boolean;
  backup: boolean;
  unsafe: boolean;
  confirm: boolean;
  rollback: boolean;
  format: "text" | "json" | "markdown";
  vault?: string;
  projectRoot?: string;
  replicaDecision?: "initialize-local";
  fullIntegrity: boolean;
  paths: string[];
}

export const LEGACY_HELP = `memory-vault — frontmatter validator / fixer for the Memory Vault

Usage:
  memory-vault <command> [options]

Commands:
  validate     Scan and print frontmatter diagnostics (default format: text)
  report       Alias of validate (default format: markdown)
  fix          Apply safe auto-fixes (dry-run by default; use --apply to write)
  fix --unsafe --confirm   Also apply unsafe fixes (infer type, drop unknown fields)
  migrate      Migrate legacy frontmatter to the current schema version (dry-run by default)
  migrate --rollback       Restore notes from the most recent backup
  init         Create a project frontmatter config under .memory-mcp/
  diagnose     Print workspace/vault/runtime diagnostics as JSON
  help         Show this help

Options:
  --apply              Actually write changes (fix/migrate). Default is dry-run.
  --dry-run            Force dry-run (default for fix/migrate).
  --safe               Safe fixes only (the default).
  --unsafe             Enable unsafe fixes (requires --confirm).
  --confirm            Confirm unsafe fixes.
  --rollback           For migrate: restore from the most recent backup.
  --no-backup          Skip timestamped backups when writing.
  --format <fmt>       text | json | markdown (validate/report).
  --vault <path>       Override the vault root (else auto-detected).
  --path <file>        Limit to a specific note (repeatable).
  -h, --help           Show this help.
`;

const V2_HELP_SUFFIX = `
V2 event-store administration:
  orchestrator-init       Inspect or explicitly initialize V2 identity/store (--apply writes)
  orchestrator-status     Verify and print one explicitly bound V2 project/store
  orchestrator-integrity  Run quick integrity, or full integrity with --full

V2 options:
  --project-root <path>   Required literal project root.
  --vault <path>          Required literal vault root.
  --replica initialize-local  Explicitly initialize a local replica.
  --full                  Run full event-store integrity.
`;

export const HELP = LEGACY_HELP + V2_HELP_SUFFIX;

const COMMANDS = new Set<Command>([
  "validate",
  "report",
  "fix",
  "migrate",
  "init",
  "diagnose",
  "orchestrator-init",
  "orchestrator-status",
  "orchestrator-integrity",
  "help",
]);

const V2_COMMANDS = new Set<Command>([
  "orchestrator-init",
  "orchestrator-status",
  "orchestrator-integrity",
]);

export class CliUsageError extends Error {
  readonly exitCode = 2 as const;

  constructor(readonly code: string) {
    super(code);
    this.name = "CliUsageError";
  }
}

function requiredOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`MISSING_VALUE_${option.slice(2).replaceAll("-", "_").toUpperCase()}`);
  }
  return value;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "help",
    dryRun: true,
    backup: true,
    unsafe: false,
    confirm: false,
    rollback: false,
    format: "text",
    fullIntegrity: false,
    paths: [],
  };

  const positional = argv[0];
  if (positional && !positional.startsWith("-")) {
    options.command = COMMANDS.has(positional as Command)
      ? positional as Command
      : "help";
  }
  if (options.command === "report") options.format = "markdown";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-backup":
        options.backup = false;
        break;
      case "--safe":
        options.unsafe = false;
        break;
      case "--unsafe":
        options.unsafe = true;
        break;
      case "--confirm":
        options.confirm = true;
        break;
      case "--rollback":
        options.rollback = true;
        break;
      case "--format":
        options.format = (argv[++i] as CliOptions["format"]) ?? "text";
        break;
      case "--vault":
        if (V2_COMMANDS.has(options.command)) {
          options.vault = requiredOptionValue(argv, i, arg);
          i += 1;
        } else {
          options.vault = argv[++i];
        }
        break;
      case "--path":
        if (argv[i + 1]) options.paths.push(argv[++i]);
        break;
      case "--project-root":
        if (!V2_COMMANDS.has(options.command)) break;
        options.projectRoot = requiredOptionValue(argv, i, arg);
        i += 1;
        break;
      case "--replica": {
        if (!V2_COMMANDS.has(options.command)) break;
        const value = requiredOptionValue(argv, i, arg);
        if (value !== "initialize-local") {
          throw new CliUsageError("REPLICA_DECISION_INVALID");
        }
        options.replicaDecision = value;
        i += 1;
        break;
      }
      case "--full":
        if (V2_COMMANDS.has(options.command)) options.fullIntegrity = true;
        break;
      case "-h":
      case "--help":
        options.command = "help";
        break;
      default:
        break;
    }
  }

  return options;
}
