import { runV2Admin } from "./v2/admin.js";
import { diagnosticCode } from "./v2/config.js";

try { process.stdout.write(`${JSON.stringify(await runV2Admin(process.argv.slice(2)))}\n`); }
catch (error) { process.stderr.write(`${diagnosticCode(error)}\n`); process.exitCode = 1; }
