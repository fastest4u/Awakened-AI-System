import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class AuditService {
  constructor(private readonly rootDir: string) {}

  record(event: string, payload: Record<string, unknown>) {
    const dir = join(this.rootDir, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "mcp-audit.log"), `${new Date().toISOString()} ${event} ${JSON.stringify(payload)}\n`, "utf8");
  }
}
