import { createHash } from "node:crypto";

import { canonicalJson } from "../serialization/canonical-json.js";
import type { ProjectionReaderLease } from "../projections/reader-lease.js";
import { isEligible } from "./eligibility.js";
import {
  validateInternalRetrievalRequest,
  type InternalRetrievalRequest,
  type RetrievalItem,
  type ValidatedInternalRetrievalRequest,
  type VectorCacheManifestRowV1,
  type VectorCacheManifestV1,
  type VectorCandidate,
  type VectorCandidateChannel,
  type VectorChannelResult,
} from "./contracts.js";
import { cosine } from "../../utils/vector.js";

export type {
  VectorCacheManifestRowV1,
  VectorCacheManifestV1,
  VectorCandidateChannel,
  VectorChannelResult,
} from "./contracts.js";

const HASH = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export const VECTOR_CACHE_LIMITS = Object.freeze({
  dimensions: 4_096,
  rowBytes: 32 * 1_024,
  rows: 512,
  totalBytes: 16 * 1024 * 1024,
  chunkBytes: 16 * 1024,
  providerIdBytes: 128,
  modelBytes: 256,
  chunkerVersionBytes: 128,
} as const);

export interface LocalVectorProvider {
  readonly providerId: string;
  readonly model: string;
  embed(text: string, signal?: AbortSignal): Promise<readonly number[]>;
}

/** `text` is already-redacted canonical content; sourceHash is its SHA-256. */
export interface RedactedCanonicalChunk {
  readonly sourceHash: string;
  readonly chunkerVersion: string;
  readonly text: string;
  readonly item: RetrievalItem;
}

export interface RedactedCanonicalChunkSource {
  load(
    request: ValidatedInternalRetrievalRequest,
    lease: ProjectionReaderLease,
    signal?: AbortSignal,
  ): Promise<readonly RedactedCanonicalChunk[]>;
}

export interface VectorCacheRowV1 extends VectorCacheManifestRowV1 {
  readonly vectorBytes: Uint8Array;
}

export interface VectorCacheLookup {
  readonly sourceHash: string;
  readonly providerId: string;
  readonly model: string;
  readonly chunkerVersion: string;
  readonly dimensions: number;
}

export interface LocalVectorCacheStore {
  find(lookup: VectorCacheLookup): VectorCacheRowV1 | undefined;
  put(row: VectorCacheRowV1): void;
  snapshot(): readonly VectorCacheRowV1[];
}

export interface SearchVectorChannelOptions {
  readonly chunks?: readonly RedactedCanonicalChunk[];
  readonly cache?: LocalVectorCacheStore;
  readonly signal?: AbortSignal;
}

export interface LocalVectorCandidateChannelOptions {
  readonly provider?: LocalVectorProvider;
  readonly chunks: RedactedCanonicalChunkSource;
  readonly cache?: LocalVectorCacheStore;
}

function invalid(): never {
  throw new TypeError("VECTOR_CACHE_INVALID");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("VECTOR_OPERATION_ABORTED");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

/** Bounds the complete optional operation even when a provider ignores cancellation. */
export async function withVectorDeadline<T>(
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const deadlineError = new Error("VECTOR_OPERATION_DEADLINE_EXCEEDED");
  if (parentSignal?.aborted === true) {
    controller.abort(abortError(parentSignal));
    throw abortError(parentSignal);
  }
  if (deadlineMs === 0) {
    controller.abort(deadlineError);
    throw deadlineError;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectBoundary: ((reason: Error) => void) | undefined;
  const fail = (reason: Error): void => {
    if (!controller.signal.aborted) controller.abort(reason);
    rejectBoundary?.(reason);
  };
  const onParentAbort = (): void => {
    if (parentSignal !== undefined) fail(abortError(parentSignal));
  };
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
    timer = setTimeout(() => fail(deadlineError), deadlineMs);
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  });
  const pending = Promise.resolve().then(async () => {
    throwIfAborted(controller.signal);
    return await operation(controller.signal);
  });
  try {
    return await Promise.race([pending, boundary]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
    rejectBoundary = undefined;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return invalid();
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || CONTROL.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) return invalid();
  return value;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tupleHash(values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
  return hash.digest("hex");
}

function cacheKey(row: Omit<VectorCacheManifestRowV1, "cacheKey" | "byteLength">): string {
  return tupleHash([
    "vector-cache-row-v1",
    row.sourceHash,
    row.providerId,
    row.model,
    row.chunkerVersion,
    row.dimensions.toString(),
    row.outputHash,
  ]);
}

function positiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    return invalid();
  }
  return Number(value);
}

function encodeVector(value: unknown): Uint8Array {
  if (!Array.isArray(value)) return invalid();
  const dimensions = positiveInteger(value.length, VECTOR_CACHE_LIMITS.dimensions);
  const byteLength = dimensions * 8;
  if (byteLength > VECTOR_CACHE_LIMITS.rowBytes) return invalid();
  const bytes = Buffer.allocUnsafe(byteLength);
  for (let index = 0; index < dimensions; index += 1) {
    const coordinate = value[index];
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) return invalid();
    bytes.writeDoubleLE(coordinate, index * 8);
  }
  return Uint8Array.from(bytes);
}

function decodeVector(bytes: Uint8Array, dimensions: number): number[] {
  if (
    !(bytes instanceof Uint8Array)
    || dimensions < 1
    || dimensions > VECTOR_CACHE_LIMITS.dimensions
    || bytes.byteLength !== dimensions * 8
    || bytes.byteLength > VECTOR_CACHE_LIMITS.rowBytes
  ) return invalid();
  const source = Buffer.from(bytes);
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    const coordinate = source.readDoubleLE(index * 8);
    if (!Number.isFinite(coordinate)) return invalid();
    vector.push(coordinate);
  }
  return vector;
}

function manifestRow(value: unknown): VectorCacheManifestRowV1 {
  const source = exactRecord(value, [
    "cacheKey",
    "sourceHash",
    "providerId",
    "model",
    "chunkerVersion",
    "dimensions",
    "outputHash",
    "byteLength",
  ]);
  if (
    typeof source.cacheKey !== "string"
    || !HASH.test(source.cacheKey)
    || typeof source.sourceHash !== "string"
    || !HASH.test(source.sourceHash)
    || typeof source.outputHash !== "string"
    || !HASH.test(source.outputHash)
  ) return invalid();
  const providerId = boundedText(source.providerId, VECTOR_CACHE_LIMITS.providerIdBytes);
  const model = boundedText(source.model, VECTOR_CACHE_LIMITS.modelBytes);
  const chunkerVersion = boundedText(
    source.chunkerVersion,
    VECTOR_CACHE_LIMITS.chunkerVersionBytes,
  );
  const dimensions = positiveInteger(source.dimensions, VECTOR_CACHE_LIMITS.dimensions);
  const byteLength = positiveInteger(source.byteLength, VECTOR_CACHE_LIMITS.rowBytes);
  if (byteLength !== dimensions * 8) return invalid();
  const output: VectorCacheManifestRowV1 = Object.freeze({
    cacheKey: source.cacheKey,
    sourceHash: source.sourceHash,
    providerId,
    model,
    chunkerVersion,
    dimensions,
    outputHash: source.outputHash,
    byteLength,
  });
  if (output.cacheKey !== cacheKey(output)) return invalid();
  return output;
}

function cacheRow(value: unknown): VectorCacheRowV1 {
  const source = exactRecord(value, [
    "cacheKey",
    "sourceHash",
    "providerId",
    "model",
    "chunkerVersion",
    "dimensions",
    "outputHash",
    "byteLength",
    "vectorBytes",
  ]);
  const metadata = manifestRow({
    cacheKey: source.cacheKey,
    sourceHash: source.sourceHash,
    providerId: source.providerId,
    model: source.model,
    chunkerVersion: source.chunkerVersion,
    dimensions: source.dimensions,
    outputHash: source.outputHash,
    byteLength: source.byteLength,
  });
  if (!(source.vectorBytes instanceof Uint8Array)) return invalid();
  if (
    source.vectorBytes.byteLength !== metadata.byteLength
    || source.vectorBytes.byteLength > VECTOR_CACHE_LIMITS.rowBytes
  ) return invalid();
  const vectorBytes = Uint8Array.from(source.vectorBytes);
  decodeVector(vectorBytes, metadata.dimensions);
  if (hashBytes(vectorBytes) !== metadata.outputHash) return invalid();
  return Object.freeze({ ...metadata, vectorBytes });
}

function cloneRow(row: VectorCacheRowV1): VectorCacheRowV1 {
  return Object.freeze({ ...row, vectorBytes: Uint8Array.from(row.vectorBytes) });
}

function sameLookup(row: VectorCacheRowV1, lookup: VectorCacheLookup): boolean {
  return row.sourceHash === lookup.sourceHash
    && row.providerId === lookup.providerId
    && row.model === lookup.model
    && row.chunkerVersion === lookup.chunkerVersion
    && row.dimensions === lookup.dimensions;
}

export class InMemoryVectorCacheStore implements LocalVectorCacheStore {
  readonly #rows = new Map<string, VectorCacheRowV1>();

  find(lookup: VectorCacheLookup): VectorCacheRowV1 | undefined {
    const matches = [...this.#rows.values()]
      .filter((row) => sameLookup(row, lookup))
      .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
    const row = matches[0];
    return row === undefined ? undefined : cloneRow(row);
  }

  put(value: VectorCacheRowV1): void {
    const row = cacheRow(value);
    this.#rows.delete(row.cacheKey);
    let existingBytes = [...this.#rows.values()].reduce(
      (total, current) => total + current.byteLength,
      0,
    );
    while (
      this.#rows.size >= VECTOR_CACHE_LIMITS.rows
      || existingBytes + row.byteLength > VECTOR_CACHE_LIMITS.totalBytes
    ) {
      const oldestKey = this.#rows.keys().next().value as string | undefined;
      if (oldestKey === undefined) return invalid();
      const oldest = this.#rows.get(oldestKey);
      if (oldest === undefined) return invalid();
      this.#rows.delete(oldestKey);
      existingBytes -= oldest.byteLength;
    }
    this.#rows.set(row.cacheKey, cloneRow(row));
  }

  snapshot(): readonly VectorCacheRowV1[] {
    return Object.freeze([...this.#rows.values()]
      .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey))
      .map(cloneRow));
  }
}

function rowsDigest(rows: readonly VectorCacheManifestRowV1[]): string {
  return hashText(canonicalJson(rows));
}

export function createVectorCacheManifest(
  values: readonly VectorCacheRowV1[],
): VectorCacheManifestV1 {
  if (!Array.isArray(values) || values.length > VECTOR_CACHE_LIMITS.rows) return invalid();
  const rows = values.map(cacheRow).sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
  if (new Set(rows.map((row) => row.cacheKey)).size !== rows.length) return invalid();
  const byteLength = rows.reduce((total, row) => total + row.byteLength, 0);
  if (!Number.isSafeInteger(byteLength) || byteLength > VECTOR_CACHE_LIMITS.totalBytes) {
    return invalid();
  }
  const metadata = Object.freeze(rows.map((row): VectorCacheManifestRowV1 => Object.freeze({
    cacheKey: row.cacheKey,
    sourceHash: row.sourceHash,
    providerId: row.providerId,
    model: row.model,
    chunkerVersion: row.chunkerVersion,
    dimensions: row.dimensions,
    outputHash: row.outputHash,
    byteLength: row.byteLength,
  })));
  return Object.freeze({
    schemaVersion: 1,
    rowCount: metadata.length,
    byteLength,
    rowsSha256: rowsDigest(metadata),
    rows: metadata,
  });
}

export function parseVectorCacheManifest(value: unknown): VectorCacheManifestV1 {
  const source = exactRecord(value, [
    "schemaVersion",
    "rowCount",
    "byteLength",
    "rowsSha256",
    "rows",
  ]);
  if (
    source.schemaVersion !== 1
    || !Array.isArray(source.rows)
    || source.rows.length > VECTOR_CACHE_LIMITS.rows
    || typeof source.rowsSha256 !== "string"
    || !HASH.test(source.rowsSha256)
  ) return invalid();
  const rows = Object.freeze(source.rows.map(manifestRow));
  if (
    !Number.isSafeInteger(source.rowCount)
    || source.rowCount !== rows.length
    || new Set(rows.map((row) => row.cacheKey)).size !== rows.length
    || rows.some((row, index) => index > 0 && rows[index - 1]!.cacheKey >= row.cacheKey)
  ) return invalid();
  const byteLength = rows.reduce((total, row) => total + row.byteLength, 0);
  if (
    !Number.isSafeInteger(source.byteLength)
    || source.byteLength !== byteLength
    || byteLength > VECTOR_CACHE_LIMITS.totalBytes
    || source.rowsSha256 !== rowsDigest(rows)
  ) return invalid();
  return Object.freeze({
    schemaVersion: 1,
    rowCount: rows.length,
    byteLength,
    rowsSha256: source.rowsSha256,
    rows,
  });
}

export function verifyVectorCacheManifest(
  value: VectorCacheManifestV1,
  rows: readonly VectorCacheRowV1[],
): boolean {
  try {
    const declared = parseVectorCacheManifest(value);
    const expected = createVectorCacheManifest(rows);
    return canonicalJson(declared) === canonicalJson(expected);
  } catch {
    return false;
  }
}

function frozenEmpty(): readonly never[] {
  return Object.freeze([]);
}

export function disabledVectorChannel(): VectorChannelResult {
  return Object.freeze({
    used: false,
    failureCode: null,
    candidates: frozenEmpty(),
    manifest: null,
  });
}

export function unavailableVectorChannel(): VectorChannelResult {
  return Object.freeze({
    used: false,
    failureCode: "PROVIDER_UNAVAILABLE",
    candidates: frozenEmpty(),
    manifest: null,
  });
}

function providerIdentity(provider: LocalVectorProvider): Readonly<{
  providerId: string;
  model: string;
}> {
  return Object.freeze({
    providerId: boundedText(provider.providerId, VECTOR_CACHE_LIMITS.providerIdBytes),
    model: boundedText(provider.model, VECTOR_CACHE_LIMITS.modelBytes),
  });
}

function chunkData(value: RedactedCanonicalChunk): RedactedCanonicalChunk {
  const source = exactRecord(value, ["sourceHash", "chunkerVersion", "text", "item"]);
  if (typeof source.sourceHash !== "string" || !HASH.test(source.sourceHash)) return invalid();
  const text = boundedText(source.text, VECTOR_CACHE_LIMITS.chunkBytes);
  if (hashText(text) !== source.sourceHash) return invalid();
  const chunkerVersion = boundedText(
    source.chunkerVersion,
    VECTOR_CACHE_LIMITS.chunkerVersionBytes,
  );
  if (typeof source.item !== "object" || source.item === null) return invalid();
  return Object.freeze({
    sourceHash: source.sourceHash,
    chunkerVersion,
    text,
    item: source.item as RetrievalItem,
  });
}

function boundedEligibleChunks(
  values: readonly RedactedCanonicalChunk[],
  request: ValidatedInternalRetrievalRequest,
): readonly RedactedCanonicalChunk[] {
  if (!Array.isArray(values) || values.length > VECTOR_CACHE_LIMITS.rows) return invalid();
  const eligible = values
    .map(chunkData)
    .filter((value) => isEligible(value.item, request, request.binding))
    .sort((left, right) => {
      const leftKey = `${left.item.kind}:${left.item.id}:${left.sourceHash}`;
      const rightKey = `${right.item.kind}:${right.item.id}:${right.sourceHash}`;
      return leftKey.localeCompare(rightKey);
    });
  const unique = new Map<string, RedactedCanonicalChunk>();
  for (const value of eligible) {
    const key = `${value.item.kind}:${value.item.id}`;
    if (!unique.has(key)) unique.set(key, value);
  }
  return Object.freeze([...unique.values()].slice(0, request.candidateLimit));
}

function rowForVector(
  chunk: RedactedCanonicalChunk,
  identity: Readonly<{ readonly providerId: string; readonly model: string }>,
  vector: readonly number[],
): VectorCacheRowV1 {
  const vectorBytes = encodeVector(vector);
  const descriptor = {
    sourceHash: chunk.sourceHash,
    providerId: identity.providerId,
    model: identity.model,
    chunkerVersion: chunk.chunkerVersion,
    dimensions: vector.length,
    outputHash: hashBytes(vectorBytes),
  };
  return cacheRow({
    cacheKey: cacheKey(descriptor),
    ...descriptor,
    byteLength: vectorBytes.byteLength,
    vectorBytes,
  });
}

function candidateId(item: RetrievalItem, sourceHash: string): string {
  return tupleHash(["vector-candidate-v1", item.kind, item.id, sourceHash]);
}

export async function searchVectorChannel(
  provider: LocalVectorProvider | undefined,
  input: InternalRetrievalRequest,
  options: SearchVectorChannelOptions = {},
): Promise<VectorChannelResult> {
  const request = validateInternalRetrievalRequest(input);
  if (!request.vector.enabled || provider === undefined) return disabledVectorChannel();
  try {
    return await withVectorDeadline(request.consistency.deadlineMs, async (signal) => {
      const identity = providerIdentity(provider);
      const cache = options.cache ?? new InMemoryVectorCacheStore();
      const chunks = boundedEligibleChunks(options.chunks ?? frozenEmpty(), request);
      const queryBytes = encodeVector(await provider.embed(request.query, signal));
      throwIfAborted(signal);
      const dimensions = queryBytes.byteLength / 8;
      const queryVector = decodeVector(queryBytes, dimensions);
      if (chunks.length === 0) {
        return Object.freeze({
          used: true,
          failureCode: null,
          candidates: frozenEmpty(),
          manifest: createVectorCacheManifest([]),
        });
      }
      const pendingRows: VectorCacheRowV1[] = [];
      const usedRows = new Map<string, VectorCacheRowV1>();
      const scored: Array<{ item: RetrievalItem; sourceHash: string; similarity: number }> = [];
      for (const source of chunks) {
        throwIfAborted(signal);
        const lookup = Object.freeze({
          sourceHash: source.sourceHash,
          providerId: identity.providerId,
          model: identity.model,
          chunkerVersion: source.chunkerVersion,
          dimensions,
        });
        const found = cache.find(lookup);
        const candidate = found === undefined ? undefined : cacheRow(found);
        const cached = candidate !== undefined && sameLookup(candidate, lookup)
          ? candidate
          : undefined;
        const row = cached ?? rowForVector(
          source,
          identity,
          await provider.embed(source.text, signal),
        );
        throwIfAborted(signal);
        if (row.dimensions !== dimensions) return invalid();
        const vector = decodeVector(row.vectorBytes, row.dimensions);
        const similarity = cosine(queryVector, vector);
        if (!Number.isFinite(similarity)) return invalid();
        if (cached === undefined) pendingRows.push(row);
        usedRows.set(row.cacheKey, row);
        scored.push({
          item: source.item,
          sourceHash: source.sourceHash,
          similarity: Math.max(-1, Math.min(1, similarity)),
        });
      }
      throwIfAborted(signal);
      for (const row of pendingRows) cache.put(row);
      scored.sort((left, right) => (
        right.similarity - left.similarity
        || `${left.item.kind}:${left.item.id}:${left.sourceHash}`.localeCompare(
          `${right.item.kind}:${right.item.id}:${right.sourceHash}`,
        )
      ));
      const candidates = Object.freeze(scored.map((value, index): VectorCandidate => Object.freeze({
        candidateId: candidateId(value.item, value.sourceHash),
        rank: index + 1,
        similarity: value.similarity,
        item: value.item,
      })));
      return Object.freeze({
        used: true,
        failureCode: null,
        candidates,
        manifest: createVectorCacheManifest([...usedRows.values()]),
      });
    }, options.signal);
  } catch {
    return unavailableVectorChannel();
  }
}

export class LocalVectorCandidateChannel implements VectorCandidateChannel {
  readonly #provider: LocalVectorProvider | undefined;
  readonly #chunks: RedactedCanonicalChunkSource;
  readonly #cache: LocalVectorCacheStore;

  constructor(options: LocalVectorCandidateChannelOptions) {
    this.#provider = options.provider;
    this.#chunks = options.chunks;
    this.#cache = options.cache ?? new InMemoryVectorCacheStore();
  }

  async search(
    input: InternalRetrievalRequest,
    lease: ProjectionReaderLease,
    parentSignal?: AbortSignal,
  ): Promise<VectorChannelResult> {
    const request = validateInternalRetrievalRequest(input);
    if (!request.vector.enabled || this.#provider === undefined) return disabledVectorChannel();
    try {
      return await withVectorDeadline(request.consistency.deadlineMs, async (signal) => {
        const chunks = await this.#chunks.load(request, lease, signal);
        throwIfAborted(signal);
        return await searchVectorChannel(this.#provider, request, {
          chunks,
          cache: this.#cache,
          signal,
        });
      }, parentSignal);
    } catch {
      return unavailableVectorChannel();
    }
  }
}
