export {};

declare module "node:sqlite" {
  interface DatabaseSync {
    /** Added to the Node.js 24 API before the supported 24.16.0 runtime floor. */
    deserialize(buffer: Uint8Array, options?: { dbName?: string }): void;
  }
}
