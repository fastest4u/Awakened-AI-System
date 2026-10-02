import { runVerifiedReadGate } from './run-v2-internal-verified-read.js';

const controller = new AbortController(); const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  if (process.argv.length !== 2) throw new Error('NATIVE_CONTENT_ARGUMENTS_INVALID');
  process.exitCode = await runVerifiedReadGate({ profile: 'native-content', signal: controller.signal });
} catch { process.stderr.write('NATIVE_CONTENT_GATE_FAILED\n'); process.exitCode = 1; }
finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
