import { createHash } from "node:crypto";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function uuidV5(namespace: string, name: Uint8Array): string {
  if (!LOWER_UUID.test(namespace) || !(name instanceof Uint8Array)) {
    throw new TypeError("UUID_V5_INPUT_INVALID");
  }
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const nameBytes = Buffer.from(name);
  let digest: Buffer | undefined;
  try {
    digest = createHash("sha1").update(namespaceBytes).update(nameBytes).digest();
    digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
    digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } finally {
    namespaceBytes.fill(0);
    nameBytes.fill(0);
    digest?.fill(0);
  }
}
