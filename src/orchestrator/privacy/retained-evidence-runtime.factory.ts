import type { AppendResult } from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import type { MaintenanceFence } from "../storage/maintenance-fence.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { RetainedEvidenceError, decodeRetainEvidenceBatch, type RetainedEvidenceReceiptV1 } from "./evidence-contracts.js";
import { CapabilityService, type CapabilityNonceSource } from "../lifecycle/capability.service.js";
import { EventAppendTransaction, SqliteEventAppendStatements } from "../storage/event-append-transaction.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import { RetainedEvidenceAuthorityVerifier } from "./retained-evidence-authority.js";
import { RetainedEvidenceRepository } from "./retained-evidence.repository.js";
import { RetainedEvidenceService } from "./retained-evidence.service.js";
import type { EvidenceKeyProvider } from "./evidence-key-provider.js";
import type { TrustedRedactionPolicyV1 } from "./redaction.js";
import type { RetainedEvidenceFaultInjector } from "./retained-evidence.service.js";
import type { PreparedRetainedEvidenceCommandV1 } from "./retained-evidence-worker-protocol.js";
export interface RetainedEvidenceRuntime {
  execute(prepared: PreparedRetainedEvidenceCommandV1, context: ProjectContext): AppendResult<RetainedEvidenceReceiptV1>;
}
export interface RetainedEvidenceRuntimeCreateInput {
  readonly connection: SqliteConnection;
  readonly maintenanceFence: MaintenanceFence;
  readonly keyProvider: CapabilityKeyProvider;
}
export interface RetainedEvidenceRuntimeFactoryPort {
  create(input: RetainedEvidenceRuntimeCreateInput): RetainedEvidenceRuntime;
}
export interface RetainedEvidenceRuntimeFactoryOptions {
  readonly provider: EvidenceKeyProvider;
  readonly policy: () => TrustedRedactionPolicyV1;
  readonly clock: { now(): string; nowMs(): bigint };
  readonly nonceSource: CapabilityNonceSource;
  readonly faults?: RetainedEvidenceFaultInjector;
}
export class RetainedEvidenceRuntimeFactory implements RetainedEvidenceRuntimeFactoryPort {
  constructor(private readonly options: RetainedEvidenceRuntimeFactoryOptions) {}
  create(input: RetainedEvidenceRuntimeCreateInput): RetainedEvidenceRuntime {
    const { connection, maintenanceFence, keyProvider } = input;
    const capabilities = new CapabilityService({ keyProvider, clock: this.options.clock, nonceSource: this.options.nonceSource });
    const service = new RetainedEvidenceService({ connection,
      events: new EventAppendTransaction(connection, new SqliteEventAppendStatements(connection), maintenanceFence, new BranchScopeRepository()),
      repository: new RetainedEvidenceRepository(connection, (boundary, commandId, idempotencyKey) => this.options.faults?.hit(boundary, commandId, idempotencyKey)),
      authority: new RetainedEvidenceAuthorityVerifier({ connection, capabilities }), provider: this.options.provider,
      policy: this.options.policy, now: () => this.options.clock.now(), ...(this.options.faults === undefined ? {} : { faults: this.options.faults }) });
    return Object.freeze({ execute(prepared: PreparedRetainedEvidenceCommandV1, context: ProjectContext) {
      // Service owns and clears bytes. Each retry reconstructs a fresh bounded input.
      const decoded = decodeRetainEvidenceBatch(prepared.command);
      try { return service.retain({ context, input: decoded, authorization: prepared.authorization }); }
      catch (error) { if (error instanceof RetainedEvidenceError) throw new RetainedEvidenceError(error.code, error.details); throw new RetainedEvidenceError("RETAINED_EVIDENCE_UNAVAILABLE"); }
      finally { decoded.canonicalOriginalBytes.fill(0); }
    } });
  }
}
