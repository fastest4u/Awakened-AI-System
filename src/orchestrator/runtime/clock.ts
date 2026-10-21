export const MAX_CANONICAL_TIMESTAMP_MS = 253_402_300_799_999n;

export interface Clock {
  nowMs(): bigint;
}
