import {
  filesystemStableProjectionDirectoryOperations,
  type ProjectionDirectoryIdentity,
  type StableProjectionGenerationIdentity,
} from "./stable-directory.js";

const MAX_GENERATION = 2_147_483_647;

export type V2RetirementImage = Readonly<Pick<
  StableProjectionGenerationIdentity,
  "device" | "inode" | "size" | "ctimeNs" | "sha256"
>>;

export function toRetirementImage(
  identity: StableProjectionGenerationIdentity,
): V2RetirementImage {
  return Object.freeze({
    device: identity.device,
    inode: identity.inode,
    size: identity.size,
    ctimeNs: identity.ctimeNs,
    sha256: identity.sha256,
  });
}

export function sameRetirementImage(
  identity: StableProjectionGenerationIdentity,
  expected: V2RetirementImage,
): boolean {
  return identity.device === expected.device
    && identity.inode === expected.inode
    && identity.size === expected.size
    && identity.ctimeNs === expected.ctimeNs
    && identity.sha256 === expected.sha256;
}

export function sameRetirementRenameContinuity(
  identity: StableProjectionGenerationIdentity,
  expected: V2RetirementImage,
): boolean {
  return identity.device === expected.device
    && identity.inode === expected.inode
    && identity.size === expected.size
    && identity.sha256 === expected.sha256;
}

export interface V2RetirementIntent {
  readonly state: "intent";
  readonly generation: number;
  readonly finalFilename: string;
  readonly retiredFilename: string;
  readonly image: V2RetirementImage;
}

export interface V2RetiredGeneration {
  readonly state: "retired";
  readonly generation: number;
  readonly retiredFilename: string;
  readonly image: V2RetirementImage;
}

/** Lock-scoped durable reservation and retirement journal for V2 final names. */
export class V2ReconciliationJournal {
  reserveAtLeast(
    projectionDirectory: string,
    directoryIdentity: ProjectionDirectoryIdentity,
    lockToken: string,
    minimumGeneration: number,
  ): number {
    if (
      !Number.isSafeInteger(minimumGeneration)
      || minimumGeneration < 0
      || minimumGeneration > MAX_GENERATION
    ) throw new Error("PROJECTION_GENERATION_EXHAUSTED");
    return filesystemStableProjectionDirectoryOperations.reserveReconciliationJournal(
      projectionDirectory,
      directoryIdentity,
      lockToken,
      minimumGeneration,
    );
  }

  beginRetirement(
    projectionDirectory: string,
    directoryIdentity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
  ): V2RetirementIntent {
    return filesystemStableProjectionDirectoryOperations.beginReconciliationRetirement(
      projectionDirectory,
      directoryIdentity,
      lockToken,
      intent,
    );
  }

  completeRetirement(
    projectionDirectory: string,
    directoryIdentity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
    image: V2RetirementImage,
  ): V2RetiredGeneration {
    return filesystemStableProjectionDirectoryOperations.completeReconciliationRetirement(
      projectionDirectory,
      directoryIdentity,
      lockToken,
      intent,
      image,
    );
  }

  snapshot(
    projectionDirectory: string,
    directoryIdentity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): readonly (V2RetirementIntent | V2RetiredGeneration)[] {
    return filesystemStableProjectionDirectoryOperations.readReconciliationRetirements(
      projectionDirectory,
      directoryIdentity,
      lockToken,
    );
  }
}
