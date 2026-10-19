import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { JsonValue } from "../contracts/event.js";
import {
  parseCanonicalTimestamp,
  parseCanonicalUuid,
  parseUnsignedDecimal,
} from "../lifecycle/contracts/identifiers.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  assertRetainedByteLimit,
  boundedRetainedJson,
  retainedDataEntries,
  retainedExactRecord,
  retainedStringMetrics,
  RETAINED_EVIDENCE_LIMITS,
  RetainedEvidenceError,
  type BoundedEvidenceInputV1,
  type EvidenceCategory,
  type EvidenceRole,
  type RetainedEvidenceFrameV1,
} from "./evidence-contracts.js";
import {
  redactEvidence,
  type RedactedEvidenceFrameV1,
  type RedactionSpanV1,
  type TrustedRedactionPolicyV1,
} from "./redaction.js";
import {
  decodeRedactedEvidencePlaintext,
  RETAINED_EVIDENCE_BUNDLE_BYTES,
  retainedIdentifier,
} from "./retained-evidence-codec.js";

export interface PrepareLargeEvidenceFramesInput {
  readonly frameId: string;
  readonly startOrdinal: bigint;
  readonly previousFrameId: string | null;
  readonly role: EvidenceRole;
  readonly category: EvidenceCategory;
  readonly occurredAt: string;
  readonly mediaType: "text/plain; charset=utf-8" | "application/json";
  readonly content: unknown;
  readonly toolCorrelationId: string | null;
  readonly artifactHashes: readonly string[];
  readonly policy: TrustedRedactionPolicyV1;
  readonly maxChunkContentBytes?: number;
  readonly forceChunk?: boolean;
}

const DEFAULT_UNCOMPRESSED_CHUNK_THRESHOLD_BYTES = 49_152;
const DEFAULT_MAX_CHUNK_B64_CHARS = 32_768;
const MAX_CHUNKS_PER_FRAME = 32;
const CHUNK_ENVELOPE_KEYS = [
  "__v2ChunkedFrame",
  "chunkCount",
  "chunkIndex",
  "compressedSha256",
  "groupId",
  "originalMediaType",
  "payloadB64",
] as const;

function assertUuidV4(value: unknown, code: "RETAINED_EVIDENCE_INPUT_INVALID" | "INTEGRITY_FAILURE" = "RETAINED_EVIDENCE_INPUT_INVALID"): string {
  if (typeof value !== "string" || value.length !== 36 || value[14] !== "4") {
    throw new RetainedEvidenceError(code);
  }
  try {
    return parseCanonicalUuid(value, "chunk-selector");
  } catch {
    throw new RetainedEvidenceError(code);
  }
}

export function deriveChunkFrameId(groupId: string, chunkIndex: number): string {
  if (chunkIndex === 0) return groupId;
  const digest = createHash("sha256")
    .update("v2-chunked-evidence-frame-id-v1\0", "utf8")
    .update(groupId, "utf8")
    .update(`\0${String(chunkIndex)}`, "utf8")
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function validateLargeInputMetadata(input: PrepareLargeEvidenceFramesInput): {
  readonly frameId: string;
  readonly previousFrameId: string | null;
  readonly toolCorrelationId: string | null;
  readonly artifactHashes: readonly string[];
} {
  const frameId = assertUuidV4(input.frameId);
  if (typeof input.startOrdinal !== "bigint" || input.startOrdinal < 0n) {
    throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
  }
  const previousFrameId =
    input.previousFrameId === null ? null : assertUuidV4(input.previousFrameId);
  if (input.startOrdinal === 0n ? previousFrameId !== null : previousFrameId === null) {
    throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
  }
  try {
    parseCanonicalTimestamp(input.occurredAt, "occurredAt");
  } catch {
    throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
  }
  const isTool = input.category === "tool-input" || input.category === "tool-output";
  const toolCorrelationId = isTool
    ? assertUuidV4(input.toolCorrelationId)
    : input.toolCorrelationId === null
      ? null
      : (() => {
          throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
        })();

  if (!Array.isArray(input.artifactHashes) || input.artifactHashes.length > RETAINED_EVIDENCE_LIMITS.hashes) {
    throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
  }
  const seenHashes = new Set<string>();
  const artifactHashes: string[] = [];
  for (const h of input.artifactHashes) {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/u.test(h) || seenHashes.has(h)) {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
    }
    seenHashes.add(h);
    artifactHashes.push(h);
  }
  return {
    frameId,
    previousFrameId,
    toolCorrelationId,
    artifactHashes: Object.freeze(artifactHashes),
  };
}

export function prepareLargeEvidenceFrames(
  input: PrepareLargeEvidenceFramesInput,
): readonly RetainedEvidenceFrameV1[] {
  const meta = validateLargeInputMetadata(input);

  // Enforce 1 MiB maximum logical frame size before redaction
  let normalizedContent: string | JsonValue;
  if (input.mediaType === "text/plain; charset=utf-8") {
    if (typeof input.content !== "string") {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
    }
    retainedStringMetrics(input.content, RETAINED_EVIDENCE_LIMITS.batchBytes);
    normalizedContent = input.content;
  } else if (input.mediaType === "application/json") {
    normalizedContent = boundedRetainedJson(
      input.content,
      RETAINED_EVIDENCE_LIMITS.batchBytes,
    ).snapshot;
  } else {
    throw new RetainedEvidenceError("RETAINED_EVIDENCE_FORMAT_UNSUPPORTED");
  }

  // Run redactEvidence on the full unsplit frame first so no secret can ever split across chunks
  const singleFrame: RetainedEvidenceFrameV1 =
    input.mediaType === "text/plain; charset=utf-8"
      ? Object.freeze({
          frameId: meta.frameId,
          ordinal: input.startOrdinal.toString(),
          role: input.role,
          category: input.category,
          occurredAt: input.occurredAt,
          mediaType: "text/plain; charset=utf-8" as const,
          content: normalizedContent as string,
          previousFrameId: meta.previousFrameId,
          toolCorrelationId: meta.toolCorrelationId,
          artifactHashes: meta.artifactHashes,
        })
      : Object.freeze({
          frameId: meta.frameId,
          ordinal: input.startOrdinal.toString(),
          role: input.role,
          category: input.category,
          occurredAt: input.occurredAt,
          mediaType: "application/json" as const,
          content: normalizedContent,
          previousFrameId: meta.previousFrameId,
          toolCorrelationId: meta.toolCorrelationId,
          artifactHashes: meta.artifactHashes,
        });

  const syntheticBatchInput: BoundedEvidenceInputV1 = Object.freeze({
    command: Object.freeze({
      version: 1 as const,
      commandType: "retain-evidence-batch" as const,
      commandId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      targetSessionId: "00000000-0000-4000-8000-000000000003",
      conversationId: "00000000-0000-4000-8000-000000000004",
      frames: Object.freeze([singleFrame]),
    }),
    canonicalOriginalBytes: Buffer.alloc(0),
  });

  const redactedBatch = redactEvidence(syntheticBatchInput, input.policy);
  const redactedFrame = redactedBatch.frames[0]!;

  const serializedRedacted = boundedRetainedJson(
    { content: redactedFrame.content, manifest: redactedFrame.manifest },
    RETAINED_EVIDENCE_BUNDLE_BYTES,
  );
  const maxUncompressedBytes =
    input.maxChunkContentBytes ?? DEFAULT_UNCOMPRESSED_CHUNK_THRESHOLD_BYTES;

  if (
    !input.forceChunk
    && redactedFrame.manifest.length === 0
    && serializedRedacted.bytes <= maxUncompressedBytes
    && serializedRedacted.bytes <= RETAINED_EVIDENCE_LIMITS.frameBytes
  ) {
    const unchunked: RetainedEvidenceFrameV1 =
      input.mediaType === "text/plain; charset=utf-8"
        ? Object.freeze({
            frameId: meta.frameId,
            ordinal: input.startOrdinal.toString(),
            role: input.role,
            category: input.category,
            occurredAt: input.occurredAt,
            mediaType: "text/plain; charset=utf-8" as const,
            content: redactedFrame.content as string,
            previousFrameId: meta.previousFrameId,
            toolCorrelationId: meta.toolCorrelationId,
            artifactHashes: meta.artifactHashes,
          })
        : Object.freeze({
            frameId: meta.frameId,
            ordinal: input.startOrdinal.toString(),
            role: input.role,
            category: input.category,
            occurredAt: input.occurredAt,
            mediaType: "application/json" as const,
            content: redactedFrame.content,
            previousFrameId: meta.previousFrameId,
            toolCorrelationId: meta.toolCorrelationId,
            artifactHashes: meta.artifactHashes,
          });
    return Object.freeze([unchunked]);
  }

  const rawRedactedBuffer = Buffer.from(serializedRedacted.canonical, "utf8");
  let compressedBuffer: Buffer | undefined;
  try {
    compressedBuffer = deflateSync(rawRedactedBuffer, { level: 9 });
    const compressedSha256 = createHash("sha256").update(compressedBuffer).digest("hex");
    const payloadB64 = compressedBuffer.toString("base64url");
    if (payloadB64.length === 0) {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
    }

    const maxB64PerChunk = Math.min(
      DEFAULT_MAX_CHUNK_B64_CHARS,
      Math.max(64, input.maxChunkContentBytes ?? DEFAULT_MAX_CHUNK_B64_CHARS),
    );
    const minDesiredChunks =
      serializedRedacted.bytes > maxUncompressedBytes || input.forceChunk === true
        ? Math.min(
            MAX_CHUNKS_PER_FRAME,
            Math.max(2, Math.ceil(serializedRedacted.bytes / maxUncompressedBytes)),
          )
        : 1;
    const chunkChars = Math.min(
      maxB64PerChunk,
      Math.max(1, Math.ceil(payloadB64.length / minDesiredChunks)),
    );

    const slices: string[] = [];
    for (let offset = 0; offset < payloadB64.length; offset += chunkChars) {
      slices.push(payloadB64.slice(offset, offset + chunkChars));
    }
    const chunkCount = slices.length;
    if (chunkCount < 1 || chunkCount > MAX_CHUNKS_PER_FRAME) {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_LIMIT_EXCEEDED");
    }

    const chunkFrameIds = slices.map((_, idx) => deriveChunkFrameId(meta.frameId, idx));
    const chunkFrames: RetainedEvidenceFrameV1[] = slices.map((slice, chunkIndex) => {
      const contentEnvelope: JsonValue = Object.freeze({
        __v2ChunkedFrame: 1,
        groupId: meta.frameId,
        chunkIndex,
        chunkCount,
        originalMediaType: input.mediaType,
        compressedSha256,
        payloadB64: slice,
      });
      return Object.freeze({
        frameId: chunkFrameIds[chunkIndex]!,
        ordinal: (input.startOrdinal + BigInt(chunkIndex)).toString(),
        role: input.role,
        category: input.category,
        occurredAt: input.occurredAt,
        mediaType: "application/json" as const,
        content: contentEnvelope,
        previousFrameId:
          chunkIndex === 0 ? meta.previousFrameId : chunkFrameIds[chunkIndex - 1]!,
        toolCorrelationId: meta.toolCorrelationId,
        artifactHashes: meta.artifactHashes,
      });
    });

    return Object.freeze(chunkFrames);
  } finally {
    rawRedactedBuffer.fill(0);
    compressedBuffer?.fill(0);
  }
}

function integrityFailure(): never {
  throw new RetainedEvidenceError("INTEGRITY_FAILURE");
}

function isUnchunkedSingleFrame(frame: RedactedEvidenceFrameV1): boolean {
  if (frame.mediaType !== "application/json") return true;
  if (typeof frame.content !== "object" || frame.content === null || Array.isArray(frame.content)) {
    return true;
  }
  return !Object.hasOwn(frame.content, "__v2ChunkedFrame");
}

function validateLargeManifestSpans(rawManifest: unknown): readonly RedactionSpanV1[] {
  const entries = retainedDataEntries(
    rawManifest,
    RETAINED_EVIDENCE_LIMITS.spans,
    "INTEGRITY_FAILURE",
  );
  if (!Array.isArray(rawManifest)) integrityFailure();
  let previousEnd = 0;
  const spans: RedactionSpanV1[] = [];
  for (const [, value] of entries) {
    const span = retainedExactRecord(
      value,
      ["ruleId", "startByte", "endByte"],
      "INTEGRITY_FAILURE",
    );
    const startByte = span.startByte;
    const endByte = span.endByte;
    if (
      typeof startByte !== "number"
      || typeof endByte !== "number"
      || !Number.isSafeInteger(startByte)
      || !Number.isSafeInteger(endByte)
      || startByte < previousEnd
      || endByte <= startByte
      || endByte > RETAINED_EVIDENCE_BUNDLE_BYTES
    ) {
      integrityFailure();
    }
    previousEnd = endByte;
    let ruleId: string;
    try {
      ruleId = retainedIdentifier(span.ruleId);
    } catch {
      return integrityFailure();
    }
    spans.push(Object.freeze({ ruleId, startByte, endByte }));
  }
  return Object.freeze(spans);
}

export function reassembleChunkedEvidenceFrames(
  frames: readonly RedactedEvidenceFrameV1[],
): RedactedEvidenceFrameV1 {
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_CHUNKS_PER_FRAME) {
    integrityFailure();
  }

  if (frames.length === 1 && isUnchunkedSingleFrame(frames[0]!)) {
    return frames[0]!;
  }

  let groupId: string | undefined;
  let expectedChunkCount: number | undefined;
  let originalMediaType: "text/plain; charset=utf-8" | "application/json" | undefined;
  let expectedCompressedSha256: string | undefined;
  let previousOrdinal: bigint | undefined;
  let previousFrameId: string | undefined;
  const payloadSlices: string[] = [];

  const firstFrame = frames[0]!;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    if (frame.mediaType !== "application/json") integrityFailure();
    const frameId = assertUuidV4(frame.frameId, "INTEGRITY_FAILURE");
    let ordinal: bigint;
    try {
      ordinal = parseUnsignedDecimal(frame.ordinal, "ordinal");
    } catch {
      return integrityFailure();
    }

    if (index === 0) {
      if (ordinal === 0n ? frame.previousFrameId !== null : frame.previousFrameId === null) {
        integrityFailure();
      }
      if (frame.previousFrameId !== null) {
        assertUuidV4(frame.previousFrameId, "INTEGRITY_FAILURE");
      }
    } else {
      if (
        ordinal !== previousOrdinal! + 1n
        || frame.previousFrameId !== previousFrameId
        || frame.role !== firstFrame.role
        || frame.category !== firstFrame.category
        || frame.occurredAt !== firstFrame.occurredAt
        || frame.toolCorrelationId !== firstFrame.toolCorrelationId
        || canonicalJson(frame.artifactHashes) !== canonicalJson(firstFrame.artifactHashes)
      ) {
        integrityFailure();
      }
    }

    const envelope = retainedExactRecord(
      frame.content,
      CHUNK_ENVELOPE_KEYS,
      "INTEGRITY_FAILURE",
    );
    if (envelope.__v2ChunkedFrame !== 1) integrityFailure();
    const chunkGroupId = assertUuidV4(envelope.groupId, "INTEGRITY_FAILURE");
    const chunkCount = envelope.chunkCount;
    const chunkIndex = envelope.chunkIndex;
    const mediaType = envelope.originalMediaType;
    const compressedSha256 = envelope.compressedSha256;
    const payloadB64 = envelope.payloadB64;

    if (
      typeof chunkCount !== "number"
      || !Number.isSafeInteger(chunkCount)
      || chunkCount !== frames.length
      || typeof chunkIndex !== "number"
      || !Number.isSafeInteger(chunkIndex)
      || chunkIndex !== index
      || (mediaType !== "text/plain; charset=utf-8" && mediaType !== "application/json")
      || typeof compressedSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(compressedSha256)
      || typeof payloadB64 !== "string"
      || payloadB64.length === 0
      || !/^[A-Za-z0-9_-]+$/u.test(payloadB64)
    ) {
      integrityFailure();
    }

    if (index === 0) {
      if (frameId !== chunkGroupId) integrityFailure();
      groupId = chunkGroupId;
      expectedChunkCount = chunkCount;
      originalMediaType = mediaType;
      expectedCompressedSha256 = compressedSha256;
    } else {
      if (
        chunkGroupId !== groupId
        || chunkCount !== expectedChunkCount
        || mediaType !== originalMediaType
        || compressedSha256 !== expectedCompressedSha256
        || frameId !== deriveChunkFrameId(groupId!, index)
      ) {
        integrityFailure();
      }
    }

    payloadSlices.push(payloadB64);
    previousOrdinal = ordinal;
    previousFrameId = frameId;
  }

  const combinedB64 = payloadSlices.join("");
  assertRetainedByteLimit(combinedB64.length, RETAINED_EVIDENCE_BUNDLE_BYTES);
  const compressed = Buffer.from(combinedB64, "base64url");
  let inflated: Buffer | undefined;
  try {
    if (compressed.toString("base64url") !== combinedB64) integrityFailure();
    const actualSha256 = createHash("sha256").update(compressed).digest("hex");
    if (actualSha256 !== expectedCompressedSha256) integrityFailure();

    try {
      inflated = inflateSync(compressed, { maxOutputLength: RETAINED_EVIDENCE_BUNDLE_BYTES });
    } catch {
      return integrityFailure();
    }

    const inflatedText = inflated.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(inflatedText);
    } catch {
      return integrityFailure();
    }
    const rawRecord = retainedExactRecord(
      parsed,
      ["content", "manifest"],
      "INTEGRITY_FAILURE",
    );
    if (canonicalJson(parsed) !== inflatedText) integrityFailure();

    let validatedContent: JsonValue;
    try {
      validatedContent = decodeRedactedEvidencePlaintext(
        { content: rawRecord.content, manifest: [] },
        originalMediaType!,
      ).content;
    } catch {
      return integrityFailure();
    }
    const validatedManifest = validateLargeManifestSpans(rawRecord.manifest);

    return Object.freeze({
      frameId: groupId!,
      ordinal: firstFrame.ordinal,
      role: firstFrame.role,
      category: firstFrame.category,
      occurredAt: firstFrame.occurredAt,
      mediaType: originalMediaType!,
      content: validatedContent,
      previousFrameId: firstFrame.previousFrameId,
      toolCorrelationId: firstFrame.toolCorrelationId,
      artifactHashes: Object.freeze([...firstFrame.artifactHashes]),
      manifest: validatedManifest,
    }) as RedactedEvidenceFrameV1;
  } finally {
    compressed.fill(0);
    inflated?.fill(0);
  }
}
