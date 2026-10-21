import type { ProjectContext } from "../identity/contracts.js";
import type { BoundedOperationAuthorization } from "../lifecycle/contracts/commands.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import type { EvidenceKeyProvider } from "./evidence-key-provider.js";
import type { RetainedEvidenceAuthorityVerifier } from "./retained-evidence-authority.js";
import { requireRetainedEvidenceReadAuthority } from "./retained-evidence-authority.js";
import type { RedactedEvidenceFrameV1 } from "./redaction.js";
import { RetainedEvidenceError } from "./evidence-contracts.js";
import { RetainedEvidenceRepository } from "./retained-evidence.repository.js";
import { openEvidenceItem } from "./evidence-envelope.js";
import { verifyRetainedEvidenceTransport } from "./retained-evidence-codec.js";
import { assertStoredRetainedEvidenceCorrespondence } from "../integrity/event-integrity.service.js";

export interface RetainedEvidenceReadInvocationV1 {
  readonly context: ProjectContext;
  readonly operationId: string;
  readonly requestId: string;
  readonly evidenceId: string;
  readonly targetSessionId: string;
  readonly expiresAt: string;
  readonly authorization: BoundedOperationAuthorization;
}

/** Private composition only; never registered as a public content operation. */
export class RetainedEvidenceReader {
  constructor(private readonly options: { connection: SqliteConnection; authority: RetainedEvidenceAuthorityVerifier; provider: EvidenceKeyProvider }) {}
  read(invocation: RetainedEvidenceReadInvocationV1): RedactedEvidenceFrameV1 {
    const { connection, authority, provider } = this.options;
    let transaction = false;
    try {
      connection.exec("BEGIN DEFERRED"); transaction = true;
      const handle = authority.verifyRead(invocation);
      const row = connection.prepare("SELECT command_id,idempotency_key,encrypted_item_json FROM retained_evidence_blobs WHERE project_id=$p AND evidence_id=$e")
        .get({ $p: invocation.context.binding.projectId, $e: invocation.evidenceId });
      if (!row || typeof row.command_id !== "string" || typeof row.idempotency_key !== "string" || typeof row.encrypted_item_json !== "string") throw new RetainedEvidenceError("SESSION_CAPABILITY_INVALID");
      const prior = new RetainedEvidenceRepository(connection).findPrior(row.command_id, row.idempotency_key);
      if (!prior) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
      requireRetainedEvidenceReadAuthority(connection, handle, invocation.evidenceId, prior.authorization);
      assertStoredRetainedEvidenceCorrespondence(connection, prior.event);
      const item = verifyRetainedEvidenceTransport(JSON.parse(row.encrypted_item_json) as unknown);
      if (item.binding.evidenceId !== invocation.evidenceId || item.binding.targetSessionId !== invocation.targetSessionId) throw new RetainedEvidenceError("SESSION_CAPABILITY_INVALID");
      const content = openEvidenceItem(item.binding, item, provider);
      requireRetainedEvidenceReadAuthority(connection, handle, invocation.evidenceId, prior.authorization);
      connection.exec("COMMIT"); transaction = false;
      return content;
    } catch (error) {
      if (transaction) try { connection.exec("ROLLBACK"); } catch { /* opaque original refusal */ }
      if (error instanceof RetainedEvidenceError) throw new RetainedEvidenceError(error.code);
      throw new RetainedEvidenceError("INTEGRITY_FAILURE");
    }
  }
}
