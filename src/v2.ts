import { runV2Server } from "./v2/app.js";
import { diagnosticCode } from "./v2/config.js";

try { await runV2Server(); }
catch (error) { process.stderr.write(`${diagnosticCode(error)}\n`); process.exitCode = 1; }
