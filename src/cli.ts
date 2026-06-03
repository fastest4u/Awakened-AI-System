import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  loadFrontmatterConfig,
  projectConfigPath,
  projectConfigSchemaPath,
  sampleProjectConfig,
  sampleProjectConfigSchema,
} from "./config/frontmatter.config.js";
import { diagnoseMemoryConfig, loadMemoryConfig } from "./config/memory.config.js";
import { FrontmatterService } from "./services/frontmatter.service.js";
import { VaultService } from "./services/vault.service.js";

type Command = "validate" | "report" | "fix" | "migrate" | "init" | "diagnose" | "help";

interface CliOptions {
  command: Command;
  dryRun: boolean;
  backup: boolean;
  unsafe: boolean;
  confirm: boolean;
  rollback: boolean;
  format: "text" | "json" | "markdown";
  vault?: string;
  paths: string[];
}

const HELP = `memory-vault — frontmatter validator / fixer for the Memory Vault

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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "help",
    dryRun: true,
    backup: true,
    unsafe: false,
    confirm: false,
    rollback: false,
    format: "text",
    paths: [],
  };

  const positional = argv[0];
  if (positional && !positional.startsWith("-")) {
    if (["validate", "report", "fix", "migrate", "init", "diagnose", "help"].includes(positional)) {
      options.command = positional as Command;
    } else {
      options.command = "help";
    }
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
        options.vault = argv[++i];
        break;
      case "--path":
        if (argv[i + 1]) options.paths.push(argv[++i]);
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (options.command === "diagnose") {
    process.stdout.write(JSON.stringify(diagnoseMemoryConfig(process.env, process.cwd()), null, 2) + "\n");
    return;
  }

  const VALID_FORMATS = ["text", "json", "markdown"];
  if (!VALID_FORMATS.includes(options.format)) {
    process.stderr.write(`Invalid --format '${options.format}'. Use one of: ${VALID_FORMATS.join(", ")}.\n`);
    process.exitCode = 2;
    return;
  }
  // Backups are mandatory on any real write; surface that --no-backup is ignored.
  if (!options.backup && !options.dryRun && (options.command === "fix" || options.command === "migrate")) {
    process.stderr.write("Warning: --no-backup is ignored; a timestamped backup is always taken before writing.\n");
  }

  const vaultRoot = options.vault ?? loadMemoryConfig().vaultRoot;
  const vault = new VaultService(vaultRoot);
  const config = loadFrontmatterConfig(vaultRoot);
  const service = new FrontmatterService(vault, config.schema, config.sources, config.policy);
  const paths = options.paths.length ? options.paths : undefined;

  switch (options.command) {
    case "validate":
    case "report": {
      const summary = await service.validate(paths);
      process.stdout.write(service.report(summary, options.format) + "\n");
      if (summary.counts.error || summary.counts.critical) process.exitCode = 1;
      break;
    }
    case "fix": {
      const result = await service.fix({
        paths,
        dryRun: options.dryRun,
        backup: options.backup,
        unsafe: options.unsafe,
        confirm: options.confirm,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (result.requiresConfirm) {
        process.stderr.write("Note: --unsafe requires --confirm; only safe fixes were applied.\n");
      }
      // Non-zero exit so CI can gate on files that need manual attention.
      if (result.manual > 0) process.exitCode = 1;
      break;
    }
    case "migrate": {
      if (options.rollback) {
        const result = await service.rollback({ dryRun: options.dryRun });
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        break;
      }
      const result = await service.migrate({ paths, dryRun: options.dryRun, backup: options.backup });
      process.stdout.write(service.reportMigrate(result, options.format === "json" ? "json" : "text") + "\n");
      if (result.manual > 0) process.exitCode = 1;
      break;
    }
    case "init": {
      const path = projectConfigPath(vaultRoot);
      const schemaPath = projectConfigSchemaPath(vaultRoot);
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) {
        process.stdout.write(`Project frontmatter config already exists: ${path}\n`);
      } else {
        writeFileSync(path, sampleProjectConfig(), "utf8");
        process.stdout.write(`Created project frontmatter config: ${path}\n`);
      }
      if (existsSync(schemaPath)) {
        process.stdout.write(`Project frontmatter config schema already exists: ${schemaPath}\n`);
      } else {
        writeFileSync(schemaPath, sampleProjectConfigSchema(), "utf8");
        process.stdout.write(`Created project frontmatter config schema: ${schemaPath}\n`);
      }
      break;
    }
    default:
      process.stdout.write(HELP);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
