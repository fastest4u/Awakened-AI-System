import { CapabilityService, type CapabilityNonceSource } from "../lifecycle/capability.service.js";
import type { RetainedEvidenceRuntimeCreateInput } from "../privacy/retained-evidence-runtime.factory.js";
import type { EvidenceKeyProvider } from "../privacy/evidence-key-provider.js";
import type { TrustedRedactionPolicyV1 } from "../privacy/redaction.js";
import { EventAppendTransaction, SqliteEventAppendStatements } from "../storage/event-append-transaction.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import { GovernedNoteAuthorityVerifier } from "./authority.js";
import { GovernedNoteRepository } from "./repository.js";
import { GovernedNoteProvenanceRepository } from "./provenance.repository.js";
import { GovernedNoteService, type GovernedNoteFaultInjectorV1 } from "./service.js";
import type { GovernedNoteClockV1, GovernedNoteRuntime, GovernedNoteRuntimeFactoryPort } from "./contracts.js";
export interface GovernedNoteRuntimeFactoryOptions {
  readonly provider: EvidenceKeyProvider;
  readonly policy: () => TrustedRedactionPolicyV1;
  readonly clock: GovernedNoteClockV1;
  readonly nonceSource: CapabilityNonceSource;
  readonly faults?: GovernedNoteFaultInjectorV1;
}
export class GovernedNoteRuntimeFactory implements GovernedNoteRuntimeFactoryPort {
  constructor(private readonly options: GovernedNoteRuntimeFactoryOptions) {}
  create(input: RetainedEvidenceRuntimeCreateInput): GovernedNoteRuntime {
    const { connection, maintenanceFence, keyProvider } = input;
    const capabilities = new CapabilityService({ keyProvider, clock: this.options.clock, nonceSource: this.options.nonceSource });
    const service = new GovernedNoteService({ connection,
      events: new EventAppendTransaction(connection, new SqliteEventAppendStatements(connection), maintenanceFence, new BranchScopeRepository(),
        () => this.options.nonceSource.uuid(), { hit: point => { if (point === "after-first-insert-before-commit") this.options.faults?.inject("after-note-event"); } }),
      repository: new GovernedNoteRepository(connection), provenance: new GovernedNoteProvenanceRepository(),
      authority: new GovernedNoteAuthorityVerifier({ connection, capabilities, clock: this.options.clock }),
      provider: this.options.provider, policy: this.options.policy, clock: this.options.clock,
      ...(this.options.faults === undefined ? {} : { faults: this.options.faults }),
    });
    // The service owns each attempt and preserves only its certified BEGIN-busy retry classification.
    return Object.freeze({ create: service.create.bind(service), recover: service.recover.bind(service) });
  }
}
