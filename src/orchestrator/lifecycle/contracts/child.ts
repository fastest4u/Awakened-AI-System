import { LifecycleError } from "../errors.js";
import {
  exactRecord,
  parseBoundedString,
  parseCanonicalTimestamp,
  parseEnum,
  parseLifecycleId,
  parseNullableUuid,
  strictArray,
  type MaterialConfidence,
  type ReportId,
  type ReportItemId,
  type SessionId,
} from "./identifiers.js";

const REPORT_MAX_ITEMS = 200;
const REPORT_MAX_REFERENCES_PER_ITEM = 100;
const REPORT_MAX_SUMMARY_SCALARS = 4_000;
const CONFIDENCE = ["high", "medium", "low", "guess"] as const;
const DISPOSITIONS = ["accepted", "partially-accepted", "rejected", "superseded"] as const;
const LOWER_HASH = /^[0-9a-f]{64}$/;
const REPORT_ITEM_FIELDS = [
  "findings",
  "proposedDecisions",
  "filesObservedOrChanged",
  "verificationPerformed",
  "openFollowUps",
  "blockers",
] as const;

export interface ChildReportItemDraftV1 {
  readonly summary: string;
  readonly evidenceReferences: readonly string[];
  readonly confidence: MaterialConfidence;
}

export interface ChildReportItemV1 extends ChildReportItemDraftV1 {
  readonly itemId: ReportItemId;
}

export interface ChildEvidenceFingerprintV1 {
  readonly fingerprintSchemaVersion: 1;
  readonly fingerprintKeyId: string;
  readonly fingerprintDomain: "pm-evidence-frame-v1";
  readonly fingerprint: string;
}

export interface ChildReportV1 {
  readonly reportVersion: 1;
  readonly reportId: ReportId;
  readonly childSessionId: SessionId;
  readonly parentSessionId: SessionId;
  readonly assignmentId: string;
  readonly createdAt: string;
  readonly outcomeSummary: string;
  readonly findings: readonly ChildReportItemV1[];
  readonly proposedDecisions: readonly ChildReportItemV1[];
  readonly filesObservedOrChanged: readonly ChildReportItemV1[];
  readonly verificationPerformed: readonly ChildReportItemV1[];
  readonly openFollowUps: readonly ChildReportItemV1[];
  readonly blockers: readonly ChildReportItemV1[];
  readonly evidenceFingerprints: readonly ChildEvidenceFingerprintV1[];
  readonly allReportItemIds: readonly ReportItemId[];
}

export interface ChildReportDraftV1 {
  readonly reportVersion: 1;
  readonly outcomeSummary: string;
  readonly findings: readonly ChildReportItemDraftV1[];
  readonly proposedDecisions: readonly ChildReportItemDraftV1[];
  readonly filesObservedOrChanged: readonly ChildReportItemDraftV1[];
  readonly verificationPerformed: readonly ChildReportItemDraftV1[];
  readonly openFollowUps: readonly ChildReportItemDraftV1[];
  readonly blockers: readonly ChildReportItemDraftV1[];
  readonly evidenceFingerprints: readonly ChildEvidenceFingerprintV1[];
}

export type ChildDispositionKind = (typeof DISPOSITIONS)[number];

export interface ChildDispositionV1 {
  readonly dispositionVersion: 1;
  readonly reportId: ReportId;
  readonly kind: ChildDispositionKind;
  readonly acceptedItemIds: readonly ReportItemId[];
  readonly rejectedItemIds: readonly ReportItemId[];
  readonly deferredItemIds: readonly ReportItemId[];
  readonly supersededByReportId: ReportId | null;
  readonly explanation: string;
  readonly allReportItemIds: readonly ReportItemId[];
}

function reportInvalid(): never {
  throw new LifecycleError("CHILD_REPORT_INVALID");
}

function dispositionInvalid(): never {
  throw new LifecycleError("CHILD_DISPOSITION_INVALID");
}

function reportId<T extends string>(value: unknown, field: string): T {
  try {
    return parseLifecycleId<T>(value, field);
  } catch {
    reportInvalid();
  }
}

function dispositionId<T extends string>(value: unknown, field: string): T {
  try {
    return parseLifecycleId<T>(value, field);
  } catch {
    dispositionInvalid();
  }
}

function reportString(value: unknown, field: string, maximum: number): string {
  try {
    return parseBoundedString(value, field, maximum);
  } catch {
    reportInvalid();
  }
}

function reportItem(value: unknown, field: string): ChildReportItemV1 {
  const item = exactRecord(
    value,
    ["itemId", "summary", "evidenceReferences", "confidence"],
    field,
    "CHILD_REPORT_INVALID",
  );
  const references = strictArray(item.evidenceReferences, `${field}.evidenceReferences`, "CHILD_REPORT_INVALID");
  if (references.length > REPORT_MAX_REFERENCES_PER_ITEM) reportInvalid();
  const evidenceReferences = Object.freeze(references.map((reference, index) =>
    reportString(reference, `${field}.evidenceReferences[${index}]`, 512)));
  let decodedConfidence: MaterialConfidence;
  try {
    decodedConfidence = parseEnum(item.confidence, CONFIDENCE, `${field}.confidence`);
  } catch {
    reportInvalid();
  }
  return Object.freeze({
    itemId: reportId<ReportItemId>(item.itemId, `${field}.itemId`),
    summary: reportString(item.summary, `${field}.summary`, REPORT_MAX_SUMMARY_SCALARS),
    evidenceReferences,
    confidence: decodedConfidence,
  });
}

function reportItems(value: unknown, field: string): readonly ChildReportItemV1[] {
  const source = strictArray(value, field, "CHILD_REPORT_INVALID");
  if (source.length > REPORT_MAX_ITEMS) reportInvalid();
  return Object.freeze(source.map((item, index) => reportItem(item, `${field}[${index}]`)));
}

function evidenceFingerprint(value: unknown, field: string): ChildEvidenceFingerprintV1 {
  const fingerprint = exactRecord(value, [
    "fingerprintSchemaVersion",
    "fingerprintKeyId",
    "fingerprintDomain",
    "fingerprint",
  ], field, "CHILD_REPORT_INVALID");
  if (
    fingerprint.fingerprintSchemaVersion !== 1
    || fingerprint.fingerprintDomain !== "pm-evidence-frame-v1"
    || typeof fingerprint.fingerprint !== "string"
    || !LOWER_HASH.test(fingerprint.fingerprint)
  ) reportInvalid();
  return Object.freeze({
    fingerprintSchemaVersion: 1,
    fingerprintKeyId: reportString(fingerprint.fingerprintKeyId, `${field}.fingerprintKeyId`, 128),
    fingerprintDomain: "pm-evidence-frame-v1",
    fingerprint: fingerprint.fingerprint,
  });
}

function reportItemDraft(value: unknown, field: string): ChildReportItemDraftV1 {
  const item = exactRecord(
    value,
    ["summary", "evidenceReferences", "confidence"],
    field,
    "CHILD_REPORT_INVALID",
  );
  const references = strictArray(item.evidenceReferences, `${field}.evidenceReferences`, "CHILD_REPORT_INVALID");
  if (references.length > REPORT_MAX_REFERENCES_PER_ITEM) reportInvalid();
  let decodedConfidence: MaterialConfidence;
  try {
    decodedConfidence = parseEnum(item.confidence, CONFIDENCE, `${field}.confidence`);
  } catch {
    reportInvalid();
  }
  return Object.freeze({
    summary: reportString(item.summary, `${field}.summary`, REPORT_MAX_SUMMARY_SCALARS),
    evidenceReferences: Object.freeze(references.map((reference, index) =>
      reportString(reference, `${field}.evidenceReferences[${index}]`, 512))),
    confidence: decodedConfidence,
  });
}

function reportDraftItems(value: unknown, field: string): readonly ChildReportItemDraftV1[] {
  const source = strictArray(value, field, "CHILD_REPORT_INVALID");
  if (source.length > REPORT_MAX_ITEMS) reportInvalid();
  return Object.freeze(source.map((item, index) => reportItemDraft(item, `${field}[${index}]`)));
}

function decodeEvidenceFingerprints(value: unknown): readonly ChildEvidenceFingerprintV1[] {
  const source = strictArray(value, "evidenceFingerprints", "CHILD_REPORT_INVALID");
  if (source.length > REPORT_MAX_ITEMS) reportInvalid();
  return Object.freeze(source.map((item, index) =>
    evidenceFingerprint(item, `evidenceFingerprints[${index}]`)));
}

export function decodeChildReportDraftV1(value: unknown): ChildReportDraftV1 {
  const report = exactRecord(value, [
    "reportVersion",
    "outcomeSummary",
    ...REPORT_ITEM_FIELDS,
    "evidenceFingerprints",
  ], "childReportDraft", "CHILD_REPORT_INVALID");
  if (report.reportVersion !== 1) reportInvalid();
  const findings = reportDraftItems(report.findings, "findings");
  const proposedDecisions = reportDraftItems(report.proposedDecisions, "proposedDecisions");
  const filesObservedOrChanged = reportDraftItems(report.filesObservedOrChanged, "filesObservedOrChanged");
  const verificationPerformed = reportDraftItems(report.verificationPerformed, "verificationPerformed");
  const openFollowUps = reportDraftItems(report.openFollowUps, "openFollowUps");
  const blockers = reportDraftItems(report.blockers, "blockers");
  if (
    findings.length
      + proposedDecisions.length
      + filesObservedOrChanged.length
      + verificationPerformed.length
      + openFollowUps.length
      + blockers.length
    > REPORT_MAX_ITEMS
  ) reportInvalid();
  return Object.freeze({
    reportVersion: 1,
    outcomeSummary: reportString(report.outcomeSummary, "outcomeSummary", REPORT_MAX_SUMMARY_SCALARS),
    findings,
    proposedDecisions,
    filesObservedOrChanged,
    verificationPerformed,
    openFollowUps,
    blockers,
    evidenceFingerprints: decodeEvidenceFingerprints(report.evidenceFingerprints),
  });
}

export function decodeChildReportV1(value: unknown): ChildReportV1 {
  const report = exactRecord(value, [
    "reportVersion",
    "reportId",
    "childSessionId",
    "parentSessionId",
    "assignmentId",
    "createdAt",
    "outcomeSummary",
    "findings",
    "proposedDecisions",
    "filesObservedOrChanged",
    "verificationPerformed",
    "openFollowUps",
    "blockers",
    "evidenceFingerprints",
  ], "childReport", "CHILD_REPORT_INVALID");
  if (report.reportVersion !== 1) reportInvalid();

  const findings = reportItems(report.findings, "findings");
  const proposedDecisions = reportItems(report.proposedDecisions, "proposedDecisions");
  const filesObservedOrChanged = reportItems(report.filesObservedOrChanged, "filesObservedOrChanged");
  const verificationPerformed = reportItems(report.verificationPerformed, "verificationPerformed");
  const openFollowUps = reportItems(report.openFollowUps, "openFollowUps");
  const blockers = reportItems(report.blockers, "blockers");
  const allItems = [
    ...findings,
    ...proposedDecisions,
    ...filesObservedOrChanged,
    ...verificationPerformed,
    ...openFollowUps,
    ...blockers,
  ];
  if (allItems.length > REPORT_MAX_ITEMS) reportInvalid();
  const allReportItemIds = allItems.map((item) => item.itemId);
  if (new Set(allReportItemIds).size !== allReportItemIds.length) reportInvalid();

  let createdAt: string;
  try {
    createdAt = parseCanonicalTimestamp(report.createdAt, "createdAt");
  } catch {
    reportInvalid();
  }
  const evidenceFingerprints = decodeEvidenceFingerprints(report.evidenceFingerprints);

  return Object.freeze({
    reportVersion: 1,
    reportId: reportId<ReportId>(report.reportId, "reportId"),
    childSessionId: reportId<SessionId>(report.childSessionId, "childSessionId"),
    parentSessionId: reportId<SessionId>(report.parentSessionId, "parentSessionId"),
    assignmentId: reportId(report.assignmentId, "assignmentId"),
    createdAt,
    outcomeSummary: reportString(report.outcomeSummary, "outcomeSummary", REPORT_MAX_SUMMARY_SCALARS),
    findings,
    proposedDecisions,
    filesObservedOrChanged,
    verificationPerformed,
    openFollowUps,
    blockers,
    evidenceFingerprints,
    allReportItemIds: Object.freeze(allReportItemIds),
  });
}

function dispositionIds(value: unknown, field: string): readonly ReportItemId[] {
  const source = strictArray(value, field, "CHILD_DISPOSITION_INVALID");
  if (source.length > REPORT_MAX_ITEMS) dispositionInvalid();
  const decoded = source.map((item, index) => dispositionId<ReportItemId>(item, `${field}[${index}]`));
  if (new Set(decoded).size !== decoded.length) dispositionInvalid();
  return Object.freeze(decoded);
}

function setEquals(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

export function decodeChildDispositionV1(value: unknown): ChildDispositionV1 {
  const disposition = exactRecord(value, [
    "dispositionVersion",
    "reportId",
    "kind",
    "acceptedItemIds",
    "rejectedItemIds",
    "deferredItemIds",
    "supersededByReportId",
    "explanation",
    "allReportItemIds",
  ], "childDisposition", "CHILD_DISPOSITION_INVALID");
  if (disposition.dispositionVersion !== 1) dispositionInvalid();

  let kind: ChildDispositionKind;
  try {
    kind = parseEnum(disposition.kind, DISPOSITIONS, "kind");
  } catch {
    dispositionInvalid();
  }
  const acceptedItemIds = dispositionIds(disposition.acceptedItemIds, "acceptedItemIds");
  const rejectedItemIds = dispositionIds(disposition.rejectedItemIds, "rejectedItemIds");
  const deferredItemIds = dispositionIds(disposition.deferredItemIds, "deferredItemIds");
  const allReportItemIds = dispositionIds(disposition.allReportItemIds, "allReportItemIds");
  if (allReportItemIds.length === 0) dispositionInvalid();
  const accepted = new Set<string>(acceptedItemIds);
  const rejected = new Set<string>(rejectedItemIds);
  const deferred = new Set<string>(deferredItemIds);
  if (
    [...accepted].some((item) => rejected.has(item) || deferred.has(item))
    || [...rejected].some((item) => deferred.has(item))
  ) dispositionInvalid();
  const partition = new Set([...accepted, ...rejected, ...deferred]);
  const all = new Set<string>(allReportItemIds);
  if (!setEquals(partition, all)) dispositionInvalid();

  let supersededByReportId: ReportId | null;
  try {
    supersededByReportId = parseNullableUuid<ReportId>(
      disposition.supersededByReportId,
      "supersededByReportId",
      "CHILD_DISPOSITION_INVALID",
    );
  } catch {
    dispositionInvalid();
  }
  if (kind === "accepted") {
    if (!setEquals(accepted, all) || rejected.size !== 0 || deferred.size !== 0 || supersededByReportId !== null) {
      dispositionInvalid();
    }
  } else if (kind === "rejected") {
    if (!setEquals(rejected, all) || accepted.size !== 0 || deferred.size !== 0 || supersededByReportId !== null) {
      dispositionInvalid();
    }
  } else if (kind === "partially-accepted") {
    if (accepted.size === 0 || rejected.size + deferred.size === 0 || supersededByReportId !== null) {
      dispositionInvalid();
    }
  } else if (
    !setEquals(rejected, all)
    || accepted.size !== 0
    || deferred.size !== 0
    || supersededByReportId === null
    || supersededByReportId === disposition.reportId
  ) {
    dispositionInvalid();
  }

  let explanation: string;
  try {
    explanation = parseBoundedString(
      disposition.explanation,
      "explanation",
      REPORT_MAX_SUMMARY_SCALARS,
      { code: "CHILD_DISPOSITION_INVALID" },
    );
  } catch {
    dispositionInvalid();
  }
  return Object.freeze({
    dispositionVersion: 1,
    reportId: dispositionId<ReportId>(disposition.reportId, "reportId"),
    kind,
    acceptedItemIds,
    rejectedItemIds,
    deferredItemIds,
    supersededByReportId,
    explanation,
    allReportItemIds,
  });
}
