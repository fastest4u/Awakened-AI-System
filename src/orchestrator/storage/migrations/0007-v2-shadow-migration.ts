import type { Migration } from "../migration.js";

const hash = (column: string): string => `
  ${column} TEXT NOT NULL CHECK (length(${column}) = 64 AND length(CAST(${column} AS BLOB)) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*')`;

const immutable = (table: string, condition: string): string => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${condition})
BEGIN SELECT RAISE(ABORT, 'V2_SHADOW_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'V2_SHADOW_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'V2_SHADOW_IMMUTABLE'); END;`;

export const v2ShadowMigration: Migration = {
  version: 7,
  name: "v2-shadow-migration",
  sql: `
CREATE TABLE v2_shadow_migration_runs (
  project_id TEXT NOT NULL,
  ${hash("migration_identity")},
  rollout_revision_id TEXT NOT NULL,
  ${hash("package_checksum")}, ${hash("source_manifest_checksum")},
  source_terminal_position INTEGER NOT NULL CHECK (source_terminal_position >= 0),
  ${hash("source_terminal_hash")}, ${hash("configuration_checksum")}, ${hash("policy_checksum")},
  ${hash("build_identity_hash")}, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity),
  FOREIGN KEY (project_id, rollout_revision_id) REFERENCES rollout_revisions(project_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_migration_transitions (
  project_id TEXT NOT NULL, migration_identity TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0), attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('snapshot-verified','package-sealed','import-committed','projection-verified','parity-complete','compatibility-complete')),
  ${hash("prior_transition_hash")}, ${hash("transition_hash")}, ${hash("evidence_digest")}, recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, ordinal),
  UNIQUE (project_id, migration_identity, phase), UNIQUE (project_id, migration_identity, transition_hash),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_migration_attempts (
  project_id TEXT NOT NULL, migration_identity TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0), attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('snapshot-verified','package-sealed','import-committed','projection-verified','parity-complete','compatibility-complete')),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 64),
  operation_attempt_index INTEGER NOT NULL CHECK (operation_attempt_index >= 0),
  outcome_category TEXT NOT NULL CHECK (outcome_category IN ('retryable-failure','unknown-outcome','retry-exhausted','terminal-failure')),
  safe_error_code TEXT NOT NULL CHECK (length(trim(safe_error_code)) BETWEEN 1 AND 64), prior_committed_phase TEXT,
  ${hash("evidence_digest")}, recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, attempt_ordinal), UNIQUE (project_id, migration_identity, attempt_id),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_imported_records (
  project_id TEXT NOT NULL, migration_identity TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('source-event','legacy-artifact')),
  ${hash("source_record_hash")}, imported_event_id TEXT NOT NULL,
  imported_global_position INTEGER NOT NULL CHECK (imported_global_position > 0), ${hash("imported_event_hash")}, recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, source_ordinal), UNIQUE (project_id, imported_event_id), UNIQUE (project_id, imported_global_position),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_expected_difference_rules (
  project_id TEXT NOT NULL, migration_identity TEXT NOT NULL, rule_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  category TEXT NOT NULL CHECK (category IN ('semantic-value','representation')),
  projection_name TEXT NOT NULL CHECK (projection_name IN ('sessionTree','sessionCheckpoints','canonicalItems','tasksFollowups','artifactsFiles','entityGraph','lexicalChunks','retrievalFeedback','sealedRetrieval')),
  selector_json TEXT NOT NULL, predicate_json TEXT NOT NULL, ${hash("rationale_digest")}, ${hash("approver_fingerprint")},
  ${hash("approval_reference_digest")}, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, rollout_revision_id TEXT NOT NULL, ${hash("rule_checksum")},
  PRIMARY KEY (project_id, migration_identity, rule_id), UNIQUE (project_id, migration_identity, rule_checksum),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity),
  FOREIGN KEY (project_id, rollout_revision_id) REFERENCES rollout_revisions(project_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_parity_reports (
  project_id TEXT NOT NULL, migration_identity TEXT NOT NULL, report_id TEXT NOT NULL, ${hash("package_checksum")},
  compared_event_position INTEGER NOT NULL CHECK (compared_event_position >= 0), ${hash("compared_event_hash")},
  ${hash("v1_manifest_checksum")}, ${hash("v2_manifest_checksum")}, ${hash("v1_core_checksums_digest")},
  ${hash("v2_core_checksums_digest")}, ${hash("retrieval_vector_checksum")},
  equal_count INTEGER NOT NULL CHECK (equal_count >= 0), expected_difference_count INTEGER NOT NULL CHECK (expected_difference_count >= 0),
  blocking_divergence_count INTEGER NOT NULL CHECK (blocking_divergence_count >= 0), report_json TEXT NOT NULL, ${hash("report_checksum")}, recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, report_id), UNIQUE (project_id, migration_identity, report_checksum),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_outbox (
  project_id TEXT NOT NULL, migration_identity TEXT NOT NULL, outbox_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0), imported_event_id TEXT NOT NULL,
  imported_global_position INTEGER NOT NULL CHECK (imported_global_position > 0), ${hash("imported_event_hash")},
  ${hash("triggering_payload_hash")}, relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0), ${hash("content_sha256")},
  materialization_revision INTEGER NOT NULL CHECK (materialization_revision > 0), recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id), UNIQUE (project_id, migration_identity, source_ordinal),
  FOREIGN KEY (project_id, migration_identity, source_ordinal) REFERENCES v2_shadow_imported_records(project_id, migration_identity, source_ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_claims (
  project_id TEXT NOT NULL, migration_identity TEXT NOT NULL, outbox_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  ${hash("claim_owner_fingerprint")}, claimed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id), UNIQUE (project_id, migration_identity, claim_id),
  FOREIGN KEY (project_id, migration_identity, outbox_id) REFERENCES v2_shadow_compatibility_outbox(project_id, migration_identity, outbox_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_acknowledgements (
  project_id TEXT NOT NULL, migration_identity TEXT NOT NULL, outbox_id TEXT NOT NULL, acknowledgement_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  acknowledged_imported_position INTEGER NOT NULL CHECK (acknowledged_imported_position > 0),
  materialization_revision INTEGER NOT NULL CHECK (materialization_revision > 0), ${hash("target_content_sha256")},
  ${hash("acknowledgement_checksum")}, acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id), UNIQUE (project_id, migration_identity, acknowledgement_id),
  FOREIGN KEY (project_id, migration_identity, outbox_id) REFERENCES v2_shadow_compatibility_claims(project_id, migration_identity, outbox_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER v2_shadow_migration_transitions_sequence BEFORE INSERT ON v2_shadow_migration_transitions
WHEN NEW.ordinal <> COALESCE((SELECT max(ordinal) + 1 FROM v2_shadow_migration_transitions WHERE project_id = NEW.project_id AND migration_identity = NEW.migration_identity), 0)
  OR NEW.phase <> CASE NEW.ordinal WHEN 0 THEN 'snapshot-verified' WHEN 1 THEN 'package-sealed' WHEN 2 THEN 'import-committed' WHEN 3 THEN 'projection-verified' WHEN 4 THEN 'parity-complete' WHEN 5 THEN 'compatibility-complete' END
  OR NEW.prior_transition_hash <> COALESCE((SELECT transition_hash FROM v2_shadow_migration_transitions WHERE project_id = NEW.project_id AND migration_identity = NEW.migration_identity ORDER BY ordinal DESC LIMIT 1), '${"0".repeat(64)}')
BEGIN SELECT RAISE(ABORT, 'V2_SHADOW_IMMUTABLE'); END;

${immutable("v2_shadow_migration_runs", "project_id = NEW.project_id AND migration_identity = NEW.migration_identity")}
${immutable("v2_shadow_migration_transitions", "project_id = NEW.project_id AND migration_identity = NEW.migration_identity AND (ordinal = NEW.ordinal OR phase = NEW.phase OR transition_hash = NEW.transition_hash)")}
${immutable("v2_shadow_migration_attempts", "project_id = NEW.project_id AND migration_identity = NEW.migration_identity AND (attempt_ordinal = NEW.attempt_ordinal OR attempt_id = NEW.attempt_id)")}
${immutable("v2_shadow_imported_records", "project_id = NEW.project_id AND (imported_event_id = NEW.imported_event_id OR imported_global_position = NEW.imported_global_position) OR (project_id = NEW.project_id AND migration_identity = NEW.migration_identity AND source_ordinal = NEW.source_ordinal)")}
${immutable("v2_shadow_expected_difference_rules", "project_id = NEW.project_id AND migration_identity = NEW.migration_identity AND (rule_id = NEW.rule_id OR rule_checksum = NEW.rule_checksum)")}
${immutable("v2_shadow_parity_reports", "project_id = NEW.project_id AND migration_identity = NEW.migration_identity AND (report_id = NEW.report_id OR report_checksum = NEW.report_checksum)")}
${immutable("v2_shadow_compatibility_outbox", "project_id = NEW.project_id AND migration_identity = NEW.migration_identity AND (outbox_id = NEW.outbox_id OR source_ordinal = NEW.source_ordinal)")}
${immutable("v2_shadow_compatibility_claims", "project_id = NEW.project_id AND migration_identity = NEW.migration_identity AND (outbox_id = NEW.outbox_id OR claim_id = NEW.claim_id)")}
${immutable("v2_shadow_compatibility_acknowledgements", "project_id = NEW.project_id AND migration_identity = NEW.migration_identity AND (outbox_id = NEW.outbox_id OR acknowledgement_id = NEW.acknowledgement_id)")}
`,
};
