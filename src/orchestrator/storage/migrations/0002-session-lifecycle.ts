import type { Migration } from "../migration.js";

export const sessionLifecycleMigration: Migration = {
  version: 2,
  name: "session-lifecycle",
  sql: `
DROP TRIGGER project_meta_no_update;

CREATE TRIGGER project_meta_identity_immutable
BEFORE UPDATE OF singleton, project_id, vault_id, store_id, created_at ON project_meta
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_META_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER project_meta_schema_version_monotonic
BEFORE UPDATE OF schema_version ON project_meta
WHEN NEW.schema_version <> OLD.schema_version + 1
  OR NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = NEW.schema_version
  )
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_META_SCHEMA_VERSION_INVALID');
END;

CREATE TABLE session_authority (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('root', 'child')),
  parent_session_id TEXT,
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) > 0),
  client_namespace TEXT NOT NULL CHECK (length(trim(client_namespace)) > 0),
  semantic_state TEXT NOT NULL CHECK (length(trim(semantic_state)) > 0),
  owner_generation INTEGER,
  child_capability_generation INTEGER,
  direct_access_enabled INTEGER NOT NULL CHECK (direct_access_enabled IN (0, 1)),
  continuity_fingerprint_algorithm TEXT,
  continuity_fingerprint_schema_version INTEGER,
  continuity_fingerprint_key_id TEXT,
  continuity_fingerprint_domain TEXT,
  continuity_fingerprint TEXT,
  root_handle_capability_version INTEGER,
  root_handle_key_id TEXT,
  root_handle_issue_nonce TEXT,
  root_handle_issued_at TEXT,
  root_handle_policy_code TEXT,
  root_handle_expiry_kind TEXT,
  root_handle_expires_at TEXT,
  root_handle_actor_role TEXT,
  root_handle_client_instance_id TEXT,
  root_handle_verifier TEXT,
  root_handle_issuance_id TEXT,
  resume_token_capability_version INTEGER,
  resume_token_key_id TEXT,
  resume_token_issue_nonce TEXT,
  resume_token_issued_at TEXT,
  resume_token_policy_code TEXT,
  resume_token_expiry_kind TEXT,
  resume_token_expires_at TEXT,
  resume_token_actor_role TEXT,
  resume_token_verifier TEXT,
  resume_token_issuance_id TEXT,
  child_handle_capability_version INTEGER,
  child_handle_key_id TEXT,
  child_handle_issue_nonce TEXT,
  child_handle_issued_at TEXT,
  child_handle_policy_code TEXT,
  child_handle_expiry_kind TEXT,
  child_handle_expires_at TEXT,
  child_handle_actor_role TEXT,
  child_handle_client_instance_id TEXT,
  child_handle_verifier TEXT,
  child_handle_issuance_id TEXT,
  authority_commitment TEXT NOT NULL CHECK (
    length(authority_commitment) = 64
    AND authority_commitment NOT GLOB '*[^0-9a-f]*'
  ),
  authority_event_position INTEGER NOT NULL CHECK (authority_event_position > 0),
  latest_checkpoint_id TEXT,
  latest_checkpoint_event_position INTEGER,
  latest_checkpoint_fingerprint TEXT,
  checkpoint_required_reason TEXT,
  checkpoint_required_event_position INTEGER,
  revocation_reason_code TEXT,
  revocation_event_position INTEGER,
  revoked_at TEXT,
  terminal_event_position INTEGER,
  terminal_event_type TEXT,
  terminal_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id),
  UNIQUE (project_id, stream_id),
  CHECK (stream_id = 'session/' || session_id),
  FOREIGN KEY (project_id, stream_id)
    REFERENCES streams(project_id, stream_id),
  FOREIGN KEY (project_id, parent_session_id)
    REFERENCES session_authority(project_id, session_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (authority_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (latest_checkpoint_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (checkpoint_required_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (revocation_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX session_authority_nonterminal_root_continuity
ON session_authority(project_id, workspace_id, client_namespace, continuity_fingerprint)
WHERE session_kind = 'root' AND terminal_event_position IS NULL;

CREATE INDEX session_authority_parent_terminal
ON session_authority(project_id, parent_session_id, terminal_event_position, session_id);

CREATE INDEX session_authority_safe_resume
ON session_authority(project_id, workspace_id, client_namespace, semantic_state, updated_at, session_id)
WHERE session_kind = 'root' AND terminal_event_position IS NULL;

CREATE TABLE session_leases (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  owner_client_instance_id TEXT NOT NULL CHECK (length(trim(owner_client_instance_id)) > 0),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
  expires_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (project_id, session_id, owner_generation),
  FOREIGN KEY (project_id, session_id)
    REFERENCES session_authority(project_id, session_id)
) STRICT;

CREATE UNIQUE INDEX session_leases_one_unreleased
ON session_leases(project_id, session_id)
WHERE released_at IS NULL;

CREATE TABLE session_evidence_coverage (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adapter_session_id TEXT NOT NULL,
  capture_mode TEXT NOT NULL CHECK (capture_mode = 'coverage-only'),
  first_ordinal INTEGER NOT NULL CHECK (first_ordinal >= 0),
  last_ordinal INTEGER NOT NULL CHECK (last_ordinal >= first_ordinal),
  highest_contiguous_ordinal INTEGER NOT NULL CHECK (
    highest_contiguous_ordinal >= first_ordinal - 1
    AND highest_contiguous_ordinal <= last_ordinal
  ),
  missing_intervals_json TEXT NOT NULL CHECK (
    json_valid(missing_intervals_json)
    AND json_type(missing_intervals_json) = 'array'
  ),
  fingerprint_algorithm TEXT NOT NULL CHECK (length(trim(fingerprint_algorithm)) > 0),
  fingerprint_schema_version INTEGER NOT NULL CHECK (fingerprint_schema_version > 0),
  fingerprint_key_id TEXT NOT NULL CHECK (length(trim(fingerprint_key_id)) > 0),
  fingerprint_domain TEXT NOT NULL CHECK (length(trim(fingerprint_domain)) > 0),
  latest_batch_id TEXT NOT NULL,
  latest_batch_event_position INTEGER NOT NULL CHECK (latest_batch_event_position > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id, adapter_session_id),
  FOREIGN KEY (project_id, session_id)
    REFERENCES session_authority(project_id, session_id),
  FOREIGN KEY (latest_batch_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE session_evidence_fingerprints (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adapter_session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  frame_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'model-turn', 'tool-request', 'tool-result', 'adapter-event', 'external-observation'
  )),
  observed_at TEXT NOT NULL CHECK (length(trim(observed_at)) > 0),
  fingerprint_algorithm TEXT NOT NULL CHECK (length(trim(fingerprint_algorithm)) > 0),
  fingerprint_schema_version INTEGER NOT NULL CHECK (fingerprint_schema_version > 0),
  fingerprint_key_id TEXT NOT NULL CHECK (length(trim(fingerprint_key_id)) > 0),
  fingerprint_domain TEXT NOT NULL CHECK (length(trim(fingerprint_domain)) > 0),
  fingerprint_value TEXT NOT NULL CHECK (
    length(fingerprint_value) = 64
    AND fingerprint_value NOT GLOB '*[^0-9a-f]*'
  ),
  batch_id TEXT NOT NULL,
  recorded_event_position INTEGER NOT NULL CHECK (recorded_event_position > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id, adapter_session_id, ordinal),
  UNIQUE (project_id, frame_id),
  FOREIGN KEY (project_id, session_id, adapter_session_id)
    REFERENCES session_evidence_coverage(project_id, session_id, adapter_session_id),
  FOREIGN KEY (recorded_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE lifecycle_approval_consumptions (
  project_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  nonce_digest TEXT NOT NULL CHECK (
    length(nonce_digest) = 64
    AND nonce_digest NOT GLOB '*[^0-9a-f]*'
  ),
  session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('recover-root-authority', 'abandon-root')),
  command_id TEXT NOT NULL,
  target_actor_role TEXT NOT NULL CHECK (target_actor_role = 'primary'),
  target_client_instance_id TEXT NOT NULL CHECK (length(trim(target_client_instance_id)) > 0),
  consumed_event_position INTEGER NOT NULL CHECK (consumed_event_position > 0),
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, approval_id),
  UNIQUE (approval_id),
  UNIQUE (nonce_digest),
  FOREIGN KEY (project_id, session_id)
    REFERENCES session_authority(project_id, session_id),
  FOREIGN KEY (consumed_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE child_transfer_tickets (
  project_id TEXT NOT NULL,
  transfer_ticket_id TEXT NOT NULL,
  source_parent_session_id TEXT NOT NULL,
  source_child_session_id TEXT NOT NULL,
  source_assignment_json TEXT NOT NULL CHECK (json_valid(source_assignment_json)),
  source_scope_json TEXT NOT NULL CHECK (json_valid(source_scope_json)),
  checkpoint_id TEXT NOT NULL,
  follow_ups_json TEXT NOT NULL CHECK (
    json_valid(follow_ups_json) AND json_type(follow_ups_json) = 'array'
  ),
  source_state_json TEXT NOT NULL CHECK (json_valid(source_state_json)),
  lineage_json TEXT NOT NULL CHECK (json_valid(lineage_json)),
  created_event_position INTEGER NOT NULL CHECK (created_event_position > 0),
  created_at TEXT NOT NULL,
  claimed_by_root_session_id TEXT,
  claimed_child_session_id TEXT,
  claimed_event_position INTEGER,
  claimed_at TEXT,
  PRIMARY KEY (project_id, transfer_ticket_id),
  FOREIGN KEY (project_id, source_parent_session_id)
    REFERENCES session_authority(project_id, session_id),
  FOREIGN KEY (project_id, source_child_session_id)
    REFERENCES session_authority(project_id, session_id),
  FOREIGN KEY (project_id, claimed_by_root_session_id)
    REFERENCES session_authority(project_id, session_id),
  FOREIGN KEY (project_id, claimed_child_session_id)
    REFERENCES session_authority(project_id, session_id),
  FOREIGN KEY (created_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (claimed_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE lifecycle_validation_results (
  project_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  validation_result_version INTEGER NOT NULL CHECK (validation_result_version > 0),
  workflow_id TEXT NOT NULL,
  workflow_generation INTEGER NOT NULL CHECK (workflow_generation > 0),
  profile_id TEXT NOT NULL CHECK (length(trim(profile_id)) > 0),
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  profile_configuration_hash TEXT NOT NULL CHECK (
    length(profile_configuration_hash) = 64
    AND profile_configuration_hash NOT GLOB '*[^0-9a-f]*'
  ),
  run_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  final_checkpoint_id TEXT NOT NULL,
  final_checkpoint_fingerprint TEXT NOT NULL CHECK (
    length(final_checkpoint_fingerprint) = 64
    AND final_checkpoint_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  validation_start_scope_version INTEGER NOT NULL CHECK (validation_start_scope_version > 0),
  validation_start_project_id TEXT NOT NULL,
  validation_start_workspace_id TEXT NOT NULL,
  validation_start_branch_ref TEXT,
  validation_start_head_commit TEXT,
  validation_start_dirty_fingerprint TEXT NOT NULL CHECK (
    length(validation_start_dirty_fingerprint) = 64
    AND validation_start_dirty_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  validation_completion_scope_version INTEGER NOT NULL CHECK (validation_completion_scope_version > 0),
  validation_completion_project_id TEXT NOT NULL,
  validation_completion_workspace_id TEXT NOT NULL,
  validation_completion_branch_ref TEXT,
  validation_completion_head_commit TEXT,
  validation_completion_dirty_fingerprint TEXT NOT NULL CHECK (
    length(validation_completion_dirty_fingerprint) = 64
    AND validation_completion_dirty_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unavailable')),
  exit_classification TEXT NOT NULL CHECK (
    exit_classification IN ('passed', 'failed', 'unavailable', 'not-run')
  ),
  redacted_summary TEXT NOT NULL,
  output_fingerprint_algorithm TEXT NOT NULL CHECK (length(trim(output_fingerprint_algorithm)) > 0),
  output_fingerprint_schema_version INTEGER NOT NULL CHECK (output_fingerprint_schema_version > 0),
  output_fingerprint_key_id TEXT NOT NULL CHECK (length(trim(output_fingerprint_key_id)) > 0),
  output_fingerprint_domain TEXT NOT NULL CHECK (length(trim(output_fingerprint_domain)) > 0),
  output_fingerprint_value TEXT NOT NULL CHECK (
    length(output_fingerprint_value) = 64
    AND output_fingerprint_value NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_references_json TEXT NOT NULL CHECK (
    json_valid(artifact_references_json)
    AND json_type(artifact_references_json) = 'array'
  ),
  fresh INTEGER NOT NULL CHECK (fresh IN (0, 1)),
  recorded_event_position INTEGER NOT NULL CHECK (recorded_event_position > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, result_id),
  UNIQUE (project_id, workflow_id, workflow_generation, profile_id, profile_version),
  UNIQUE (project_id, run_id),
  FOREIGN KEY (project_id, session_id)
    REFERENCES session_authority(project_id, session_id),
  FOREIGN KEY (recorded_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

ALTER TABLE command_dedup ADD COLUMN lifecycle_authorization_kind TEXT;
ALTER TABLE command_dedup ADD COLUMN authorization_proof_version INTEGER;
ALTER TABLE command_dedup ADD COLUMN authorization_proof_nonce TEXT;
ALTER TABLE command_dedup ADD COLUMN authorization_proof_digest TEXT;
ALTER TABLE command_dedup ADD COLUMN authorization_approval_id TEXT;
ALTER TABLE command_dedup ADD COLUMN authorization_approval_digest TEXT;
ALTER TABLE command_dedup ADD COLUMN authorization_session_id TEXT;
ALTER TABLE command_dedup ADD COLUMN target_session_id TEXT;
ALTER TABLE command_dedup ADD COLUMN presenting_actor_role TEXT;
ALTER TABLE command_dedup ADD COLUMN presenting_client_instance_id TEXT;
ALTER TABLE command_dedup ADD COLUMN target_actor_role TEXT;
ALTER TABLE command_dedup ADD COLUMN target_client_instance_id TEXT;
ALTER TABLE command_dedup ADD COLUMN internal_workflow_id TEXT;
ALTER TABLE command_dedup ADD COLUMN internal_workflow_generation INTEGER;
ALTER TABLE command_dedup ADD COLUMN internal_planned_work_id TEXT;
ALTER TABLE command_dedup ADD COLUMN internal_claim_owner_id TEXT;
ALTER TABLE command_dedup ADD COLUMN internal_claim_token INTEGER;

ALTER TABLE workflow_instances ADD COLUMN session_id TEXT;
ALTER TABLE workflow_instances ADD COLUMN triggering_event_position INTEGER;
ALTER TABLE workflow_instances ADD COLUMN expected_authority_commitment TEXT;
ALTER TABLE workflow_instances ADD COLUMN coordinator_owner_id TEXT;
ALTER TABLE workflow_instances ADD COLUMN coordinator_claim_token INTEGER;
ALTER TABLE workflow_instances ADD COLUMN coordinator_claim_expires_at TEXT;
ALTER TABLE workflow_instances ADD COLUMN coordinator_attempt_count INTEGER;
ALTER TABLE workflow_instances ADD COLUMN coordinator_failure_class TEXT;
ALTER TABLE workflow_instances ADD COLUMN coordinator_error_code TEXT;
ALTER TABLE workflow_instances ADD COLUMN coordinator_next_attempt_at TEXT;
ALTER TABLE workflow_instances ADD COLUMN validation_attempt_plan_generation INTEGER;
ALTER TABLE workflow_instances ADD COLUMN validation_attempt_plans_json TEXT;

CREATE INDEX workflow_instances_lifecycle_recovery
ON workflow_instances(project_id, state, phase, triggering_event_position, workflow_id)
WHERE session_id IS NOT NULL;

ALTER TABLE outbox ADD COLUMN session_id TEXT;
ALTER TABLE outbox ADD COLUMN origin_kind TEXT;
ALTER TABLE outbox ADD COLUMN workflow_id TEXT;
ALTER TABLE outbox ADD COLUMN workflow_generation INTEGER;
ALTER TABLE outbox ADD COLUMN artifact_kind TEXT;
ALTER TABLE outbox ADD COLUMN artifact_path TEXT;
ALTER TABLE outbox ADD COLUMN materialization_revision INTEGER;
ALTER TABLE outbox ADD COLUMN expected_prior_fingerprint TEXT;
ALTER TABLE outbox ADD COLUMN next_fingerprint TEXT;
ALTER TABLE outbox ADD COLUMN fingerprint_algorithm TEXT;
ALTER TABLE outbox ADD COLUMN fingerprint_schema_version INTEGER;
ALTER TABLE outbox ADD COLUMN fingerprint_key_id TEXT;
ALTER TABLE outbox ADD COLUMN fingerprint_domain TEXT;
ALTER TABLE outbox ADD COLUMN failure_class TEXT;
ALTER TABLE outbox ADD COLUMN safe_error_code TEXT;
ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT;

CREATE UNIQUE INDEX outbox_lifecycle_target_revision
ON outbox(project_id, session_id, artifact_kind, materialization_revision)
WHERE session_id IS NOT NULL;

CREATE INDEX outbox_lifecycle_claim_recovery
ON outbox(project_id, status, next_attempt_at, event_position, workflow_id, target_key)
WHERE session_id IS NOT NULL;

CREATE INDEX outbox_lifecycle_latest_artifact
ON outbox(project_id, session_id, artifact_kind, materialization_revision DESC)
WHERE session_id IS NOT NULL;

CREATE TRIGGER session_authority_insert_guard
BEFORE INSERT ON session_authority
WHEN
  NEW.authority_commitment IS NULL
  OR length(NEW.authority_commitment) <> 64
  OR NEW.authority_commitment GLOB '*[^0-9a-f]*'
  OR (NEW.latest_checkpoint_id IS NULL) <> (NEW.latest_checkpoint_event_position IS NULL)
  OR (NEW.latest_checkpoint_id IS NULL) <> (NEW.latest_checkpoint_fingerprint IS NULL)
  OR (NEW.latest_checkpoint_fingerprint IS NOT NULL AND (
    length(NEW.latest_checkpoint_fingerprint) <> 64
    OR NEW.latest_checkpoint_fingerprint GLOB '*[^0-9a-f]*'
  ))
  OR (NEW.checkpoint_required_reason IS NULL) <> (NEW.checkpoint_required_event_position IS NULL)
  OR (NEW.revocation_reason_code IS NULL) <> (NEW.revocation_event_position IS NULL)
  OR (NEW.revocation_reason_code IS NULL) <> (NEW.revoked_at IS NULL)
  OR (NEW.terminal_event_position IS NULL) <> (NEW.terminal_event_type IS NULL)
  OR (NEW.terminal_event_position IS NULL) <> (NEW.terminal_at IS NULL)
  OR (
    NEW.session_kind = 'root' AND (
      NEW.parent_session_id IS NOT NULL
      OR NEW.owner_generation IS NULL OR NEW.owner_generation <= 0
      OR NEW.child_capability_generation IS NOT NULL
      OR NEW.direct_access_enabled <> 0
      OR NEW.continuity_fingerprint_algorithm IS NULL
      OR NEW.continuity_fingerprint_schema_version IS NULL
      OR NEW.continuity_fingerprint_schema_version <= 0
      OR NEW.continuity_fingerprint_key_id IS NULL
      OR NEW.continuity_fingerprint_domain IS NULL
      OR NEW.continuity_fingerprint IS NULL
      OR length(NEW.continuity_fingerprint) <> 64
      OR NEW.continuity_fingerprint GLOB '*[^0-9a-f]*'
      OR NEW.root_handle_capability_version IS NULL OR NEW.root_handle_capability_version <= 0
      OR NEW.root_handle_key_id IS NULL
      OR NEW.root_handle_issue_nonce IS NULL
      OR length(NEW.root_handle_issue_nonce) <> 64
      OR NEW.root_handle_issue_nonce GLOB '*[^0-9a-f]*'
      OR NEW.root_handle_issued_at IS NULL
      OR NEW.root_handle_policy_code IS NULL
      OR NEW.root_handle_expiry_kind NOT IN ('until-revoked', 'absolute')
      OR (NEW.root_handle_expiry_kind = 'absolute') <> (NEW.root_handle_expires_at IS NOT NULL)
      OR NEW.root_handle_actor_role <> 'primary'
      OR NEW.root_handle_client_instance_id IS NULL
      OR NEW.root_handle_verifier IS NULL
      OR length(NEW.root_handle_verifier) <> 64
      OR NEW.root_handle_verifier GLOB '*[^0-9a-f]*'
      OR NEW.root_handle_issuance_id IS NULL
      OR NEW.resume_token_capability_version IS NULL OR NEW.resume_token_capability_version <= 0
      OR NEW.resume_token_key_id IS NULL
      OR NEW.resume_token_issue_nonce IS NULL
      OR length(NEW.resume_token_issue_nonce) <> 64
      OR NEW.resume_token_issue_nonce GLOB '*[^0-9a-f]*'
      OR NEW.resume_token_issued_at IS NULL
      OR NEW.resume_token_policy_code IS NULL
      OR NEW.resume_token_expiry_kind NOT IN ('until-revoked', 'absolute')
      OR (NEW.resume_token_expiry_kind = 'absolute') <> (NEW.resume_token_expires_at IS NOT NULL)
      OR NEW.resume_token_actor_role <> 'primary'
      OR NEW.resume_token_verifier IS NULL
      OR length(NEW.resume_token_verifier) <> 64
      OR NEW.resume_token_verifier GLOB '*[^0-9a-f]*'
      OR NEW.resume_token_issuance_id IS NULL
      OR NEW.child_handle_capability_version IS NOT NULL
      OR NEW.child_handle_key_id IS NOT NULL
      OR NEW.child_handle_issue_nonce IS NOT NULL
      OR NEW.child_handle_issued_at IS NOT NULL
      OR NEW.child_handle_policy_code IS NOT NULL
      OR NEW.child_handle_expiry_kind IS NOT NULL
      OR NEW.child_handle_expires_at IS NOT NULL
      OR NEW.child_handle_actor_role IS NOT NULL
      OR NEW.child_handle_client_instance_id IS NOT NULL
      OR NEW.child_handle_verifier IS NOT NULL
      OR NEW.child_handle_issuance_id IS NOT NULL
    )
  )
  OR (
    NEW.session_kind = 'child' AND (
      NEW.parent_session_id IS NULL
      OR NEW.owner_generation IS NOT NULL
      OR NEW.continuity_fingerprint_algorithm IS NOT NULL
      OR NEW.continuity_fingerprint_schema_version IS NOT NULL
      OR NEW.continuity_fingerprint_key_id IS NOT NULL
      OR NEW.continuity_fingerprint_domain IS NOT NULL
      OR NEW.continuity_fingerprint IS NOT NULL
      OR NEW.root_handle_capability_version IS NOT NULL
      OR NEW.root_handle_key_id IS NOT NULL
      OR NEW.root_handle_issue_nonce IS NOT NULL
      OR NEW.root_handle_issued_at IS NOT NULL
      OR NEW.root_handle_policy_code IS NOT NULL
      OR NEW.root_handle_expiry_kind IS NOT NULL
      OR NEW.root_handle_expires_at IS NOT NULL
      OR NEW.root_handle_actor_role IS NOT NULL
      OR NEW.root_handle_client_instance_id IS NOT NULL
      OR NEW.root_handle_verifier IS NOT NULL
      OR NEW.root_handle_issuance_id IS NOT NULL
      OR NEW.resume_token_capability_version IS NOT NULL
      OR NEW.resume_token_key_id IS NOT NULL
      OR NEW.resume_token_issue_nonce IS NOT NULL
      OR NEW.resume_token_issued_at IS NOT NULL
      OR NEW.resume_token_policy_code IS NOT NULL
      OR NEW.resume_token_expiry_kind IS NOT NULL
      OR NEW.resume_token_expires_at IS NOT NULL
      OR NEW.resume_token_actor_role IS NOT NULL
      OR NEW.resume_token_verifier IS NOT NULL
      OR NEW.resume_token_issuance_id IS NOT NULL
      OR (
        NEW.direct_access_enabled = 0 AND (
          NEW.child_capability_generation IS NOT NULL
          OR NEW.child_handle_capability_version IS NOT NULL
          OR NEW.child_handle_key_id IS NOT NULL
          OR NEW.child_handle_issue_nonce IS NOT NULL
          OR NEW.child_handle_issued_at IS NOT NULL
          OR NEW.child_handle_policy_code IS NOT NULL
          OR NEW.child_handle_expiry_kind IS NOT NULL
          OR NEW.child_handle_expires_at IS NOT NULL
          OR NEW.child_handle_actor_role IS NOT NULL
          OR NEW.child_handle_client_instance_id IS NOT NULL
          OR NEW.child_handle_verifier IS NOT NULL
          OR NEW.child_handle_issuance_id IS NOT NULL
        )
      )
      OR (
        NEW.direct_access_enabled = 1 AND (
          NEW.child_capability_generation IS NULL OR NEW.child_capability_generation <= 0
          OR NEW.child_handle_capability_version IS NULL OR NEW.child_handle_capability_version <= 0
          OR NEW.child_handle_key_id IS NULL
          OR NEW.child_handle_issue_nonce IS NULL
          OR length(NEW.child_handle_issue_nonce) <> 64
          OR NEW.child_handle_issue_nonce GLOB '*[^0-9a-f]*'
          OR NEW.child_handle_issued_at IS NULL
          OR NEW.child_handle_policy_code IS NULL
          OR NEW.child_handle_expiry_kind NOT IN ('until-revoked', 'absolute')
          OR (NEW.child_handle_expiry_kind = 'absolute') <> (NEW.child_handle_expires_at IS NOT NULL)
          OR NEW.child_handle_actor_role <> 'untrusted'
          OR NEW.child_handle_client_instance_id IS NULL
          OR NEW.child_handle_verifier IS NULL
          OR length(NEW.child_handle_verifier) <> 64
          OR NEW.child_handle_verifier GLOB '*[^0-9a-f]*'
          OR NEW.child_handle_issuance_id IS NULL
        )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION_AUTHORITY_SHAPE_INVALID');
END;

CREATE TRIGGER session_authority_update_guard
BEFORE UPDATE ON session_authority
WHEN
  NEW.authority_commitment IS NULL
  OR length(NEW.authority_commitment) <> 64
  OR NEW.authority_commitment GLOB '*[^0-9a-f]*'
  OR (NEW.latest_checkpoint_id IS NULL) <> (NEW.latest_checkpoint_event_position IS NULL)
  OR (NEW.latest_checkpoint_id IS NULL) <> (NEW.latest_checkpoint_fingerprint IS NULL)
  OR (NEW.latest_checkpoint_fingerprint IS NOT NULL AND (
    length(NEW.latest_checkpoint_fingerprint) <> 64
    OR NEW.latest_checkpoint_fingerprint GLOB '*[^0-9a-f]*'
  ))
  OR (NEW.checkpoint_required_reason IS NULL) <> (NEW.checkpoint_required_event_position IS NULL)
  OR (NEW.revocation_reason_code IS NULL) <> (NEW.revocation_event_position IS NULL)
  OR (NEW.revocation_reason_code IS NULL) <> (NEW.revoked_at IS NULL)
  OR (NEW.terminal_event_position IS NULL) <> (NEW.terminal_event_type IS NULL)
  OR (NEW.terminal_event_position IS NULL) <> (NEW.terminal_at IS NULL)
  OR (NEW.session_kind = 'root' AND (
    NEW.parent_session_id IS NOT NULL
    OR NEW.owner_generation IS NULL OR NEW.owner_generation <= 0
    OR NEW.child_capability_generation IS NOT NULL
    OR NEW.direct_access_enabled <> 0
    OR NEW.continuity_fingerprint_algorithm IS NULL
    OR NEW.continuity_fingerprint_schema_version IS NULL
    OR NEW.continuity_fingerprint_schema_version <= 0
    OR NEW.continuity_fingerprint_key_id IS NULL
    OR NEW.continuity_fingerprint_domain IS NULL
    OR NEW.continuity_fingerprint IS NULL
    OR length(NEW.continuity_fingerprint) <> 64
    OR NEW.continuity_fingerprint GLOB '*[^0-9a-f]*'
    OR NEW.root_handle_capability_version IS NULL OR NEW.root_handle_capability_version <= 0
    OR NEW.root_handle_key_id IS NULL
    OR NEW.root_handle_issue_nonce IS NULL
    OR length(NEW.root_handle_issue_nonce) <> 64
    OR NEW.root_handle_issue_nonce GLOB '*[^0-9a-f]*'
    OR NEW.root_handle_issued_at IS NULL
    OR NEW.root_handle_policy_code IS NULL
    OR NEW.root_handle_expiry_kind NOT IN ('until-revoked', 'absolute')
    OR (NEW.root_handle_expiry_kind = 'absolute') <> (NEW.root_handle_expires_at IS NOT NULL)
    OR NEW.root_handle_actor_role <> 'primary'
    OR NEW.root_handle_client_instance_id IS NULL
    OR NEW.root_handle_verifier IS NULL
    OR length(NEW.root_handle_verifier) <> 64
    OR NEW.root_handle_verifier GLOB '*[^0-9a-f]*'
    OR NEW.root_handle_issuance_id IS NULL
    OR NEW.resume_token_capability_version IS NULL OR NEW.resume_token_capability_version <= 0
    OR NEW.resume_token_key_id IS NULL
    OR NEW.resume_token_issue_nonce IS NULL
    OR length(NEW.resume_token_issue_nonce) <> 64
    OR NEW.resume_token_issue_nonce GLOB '*[^0-9a-f]*'
    OR NEW.resume_token_issued_at IS NULL
    OR NEW.resume_token_policy_code IS NULL
    OR NEW.resume_token_expiry_kind NOT IN ('until-revoked', 'absolute')
    OR (NEW.resume_token_expiry_kind = 'absolute') <> (NEW.resume_token_expires_at IS NOT NULL)
    OR NEW.resume_token_actor_role <> 'primary'
    OR NEW.resume_token_verifier IS NULL
    OR length(NEW.resume_token_verifier) <> 64
    OR NEW.resume_token_verifier GLOB '*[^0-9a-f]*'
    OR NEW.resume_token_issuance_id IS NULL
    OR NEW.child_handle_capability_version IS NOT NULL
    OR NEW.child_handle_key_id IS NOT NULL
    OR NEW.child_handle_issue_nonce IS NOT NULL
    OR NEW.child_handle_issued_at IS NOT NULL
    OR NEW.child_handle_policy_code IS NOT NULL
    OR NEW.child_handle_expiry_kind IS NOT NULL
    OR NEW.child_handle_expires_at IS NOT NULL
    OR NEW.child_handle_actor_role IS NOT NULL
    OR NEW.child_handle_client_instance_id IS NOT NULL
    OR NEW.child_handle_verifier IS NOT NULL
    OR NEW.child_handle_issuance_id IS NOT NULL
  ))
  OR (NEW.session_kind = 'child' AND (
    NEW.parent_session_id IS NULL
    OR NEW.owner_generation IS NOT NULL
    OR NEW.continuity_fingerprint_algorithm IS NOT NULL
    OR NEW.continuity_fingerprint_schema_version IS NOT NULL
    OR NEW.continuity_fingerprint_key_id IS NOT NULL
    OR NEW.continuity_fingerprint_domain IS NOT NULL
    OR NEW.continuity_fingerprint IS NOT NULL
    OR NEW.root_handle_capability_version IS NOT NULL
    OR NEW.root_handle_key_id IS NOT NULL
    OR NEW.root_handle_issue_nonce IS NOT NULL
    OR NEW.root_handle_issued_at IS NOT NULL
    OR NEW.root_handle_policy_code IS NOT NULL
    OR NEW.root_handle_expiry_kind IS NOT NULL
    OR NEW.root_handle_expires_at IS NOT NULL
    OR NEW.root_handle_actor_role IS NOT NULL
    OR NEW.root_handle_client_instance_id IS NOT NULL
    OR NEW.root_handle_verifier IS NOT NULL
    OR NEW.root_handle_issuance_id IS NOT NULL
    OR NEW.resume_token_capability_version IS NOT NULL
    OR NEW.resume_token_key_id IS NOT NULL
    OR NEW.resume_token_issue_nonce IS NOT NULL
    OR NEW.resume_token_issued_at IS NOT NULL
    OR NEW.resume_token_policy_code IS NOT NULL
    OR NEW.resume_token_expiry_kind IS NOT NULL
    OR NEW.resume_token_expires_at IS NOT NULL
    OR NEW.resume_token_actor_role IS NOT NULL
    OR NEW.resume_token_verifier IS NOT NULL
    OR NEW.resume_token_issuance_id IS NOT NULL
    OR (NEW.direct_access_enabled = 0 AND (
      NEW.child_capability_generation IS NOT NULL
      OR NEW.child_handle_capability_version IS NOT NULL
      OR NEW.child_handle_key_id IS NOT NULL
      OR NEW.child_handle_issue_nonce IS NOT NULL
      OR NEW.child_handle_issued_at IS NOT NULL
      OR NEW.child_handle_policy_code IS NOT NULL
      OR NEW.child_handle_expiry_kind IS NOT NULL
      OR NEW.child_handle_expires_at IS NOT NULL
      OR NEW.child_handle_actor_role IS NOT NULL
      OR NEW.child_handle_client_instance_id IS NOT NULL
      OR NEW.child_handle_verifier IS NOT NULL
      OR NEW.child_handle_issuance_id IS NOT NULL
    ))
    OR (NEW.direct_access_enabled = 1 AND (
      NEW.child_capability_generation IS NULL OR NEW.child_capability_generation <= 0
      OR NEW.child_handle_capability_version IS NULL OR NEW.child_handle_capability_version <= 0
      OR NEW.child_handle_key_id IS NULL
      OR NEW.child_handle_issue_nonce IS NULL
      OR length(NEW.child_handle_issue_nonce) <> 64
      OR NEW.child_handle_issue_nonce GLOB '*[^0-9a-f]*'
      OR NEW.child_handle_issued_at IS NULL
      OR NEW.child_handle_policy_code IS NULL
      OR NEW.child_handle_expiry_kind NOT IN ('until-revoked', 'absolute')
      OR (NEW.child_handle_expiry_kind = 'absolute') <> (NEW.child_handle_expires_at IS NOT NULL)
      OR NEW.child_handle_actor_role <> 'untrusted'
      OR NEW.child_handle_client_instance_id IS NULL
      OR NEW.child_handle_verifier IS NULL
      OR length(NEW.child_handle_verifier) <> 64
      OR NEW.child_handle_verifier GLOB '*[^0-9a-f]*'
      OR NEW.child_handle_issuance_id IS NULL
    ))
  ))
BEGIN
  SELECT RAISE(ABORT, 'SESSION_AUTHORITY_SHAPE_INVALID');
END;

CREATE TRIGGER session_authority_lineage_immutable
BEFORE UPDATE OF project_id, session_id, stream_id, session_kind, parent_session_id,
  workspace_id, client_namespace, created_at ON session_authority
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.stream_id IS NOT OLD.stream_id
  OR NEW.session_kind IS NOT OLD.session_kind
  OR NEW.parent_session_id IS NOT OLD.parent_session_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.client_namespace IS NOT OLD.client_namespace
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'SESSION_AUTHORITY_LINEAGE_IMMUTABLE');
END;

CREATE TRIGGER session_leases_insert_guard
BEFORE INSERT ON session_leases
WHEN NEW.released_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM session_authority AS authority
  WHERE authority.project_id = NEW.project_id
    AND authority.session_id = NEW.session_id
    AND authority.session_kind = 'root'
    AND authority.owner_generation = NEW.owner_generation
    AND authority.terminal_event_position IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_LEASE_AUTHORITY_MISMATCH');
END;

CREATE TRIGGER session_leases_update_guard
BEFORE UPDATE ON session_leases
WHEN NEW.released_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM session_authority AS authority
  WHERE authority.project_id = NEW.project_id
    AND authority.session_id = NEW.session_id
    AND authority.session_kind = 'root'
    AND authority.owner_generation = NEW.owner_generation
    AND authority.terminal_event_position IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_LEASE_AUTHORITY_MISMATCH');
END;

CREATE TRIGGER session_leases_lineage_immutable
BEFORE UPDATE OF project_id, session_id, owner_generation, owner_client_instance_id, acquired_at
ON session_leases
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.owner_generation IS NOT OLD.owner_generation
  OR NEW.owner_client_instance_id IS NOT OLD.owner_client_instance_id
  OR NEW.acquired_at IS NOT OLD.acquired_at
BEGIN
  SELECT RAISE(ABORT, 'SESSION_LEASE_LINEAGE_IMMUTABLE');
END;

CREATE TRIGGER session_leases_release_immutable
BEFORE UPDATE ON session_leases
WHEN OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at
BEGIN
  SELECT RAISE(ABORT, 'SESSION_LEASE_RELEASE_IMMUTABLE');
END;

CREATE TRIGGER session_authority_lease_update_guard
BEFORE UPDATE ON session_authority
WHEN EXISTS (
  SELECT 1 FROM session_leases AS lease
  WHERE lease.project_id = OLD.project_id
    AND lease.session_id = OLD.session_id
    AND lease.released_at IS NULL
    AND (
      NEW.session_kind <> 'root'
      OR NEW.terminal_event_position IS NOT NULL
      OR NEW.owner_generation IS NOT lease.owner_generation
    )
)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_AUTHORITY_LEASE_MISMATCH');
END;

CREATE TRIGGER session_evidence_coverage_insert_guard
BEFORE INSERT ON session_evidence_coverage
WHEN json_array_length(NEW.missing_intervals_json) > 200
  OR json(NEW.missing_intervals_json) <> NEW.missing_intervals_json
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.missing_intervals_json) AS interval
    WHERE json_type(interval.value) <> 'array'
      OR json_array_length(interval.value) <> 2
      OR json_type(interval.value, '$[0]') <> 'integer'
      OR json_type(interval.value, '$[1]') <> 'integer'
      OR json_extract(interval.value, '$[0]') < NEW.first_ordinal
      OR json_extract(interval.value, '$[1]') > NEW.last_ordinal
      OR json_extract(interval.value, '$[0]') > json_extract(interval.value, '$[1]')
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.missing_intervals_json) AS previous
        WHERE CAST(previous.key AS INTEGER) = CAST(interval.key AS INTEGER) - 1
          AND json_extract(previous.value, '$[1]') + 1 >= json_extract(interval.value, '$[0]')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'EVIDENCE_COVERAGE_TOO_FRAGMENTED');
END;

CREATE TRIGGER session_evidence_coverage_update_guard
BEFORE UPDATE ON session_evidence_coverage
WHEN json_array_length(NEW.missing_intervals_json) > 200
  OR json(NEW.missing_intervals_json) <> NEW.missing_intervals_json
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.missing_intervals_json) AS interval
    WHERE json_type(interval.value) <> 'array'
      OR json_array_length(interval.value) <> 2
      OR json_type(interval.value, '$[0]') <> 'integer'
      OR json_type(interval.value, '$[1]') <> 'integer'
      OR json_extract(interval.value, '$[0]') < NEW.first_ordinal
      OR json_extract(interval.value, '$[1]') > NEW.last_ordinal
      OR json_extract(interval.value, '$[0]') > json_extract(interval.value, '$[1]')
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.missing_intervals_json) AS previous
        WHERE CAST(previous.key AS INTEGER) = CAST(interval.key AS INTEGER) - 1
          AND json_extract(previous.value, '$[1]') + 1 >= json_extract(interval.value, '$[0]')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'EVIDENCE_COVERAGE_TOO_FRAGMENTED');
END;

CREATE TRIGGER session_evidence_fingerprints_no_update
BEFORE UPDATE ON session_evidence_fingerprints
BEGIN
  SELECT RAISE(ABORT, 'SESSION_EVIDENCE_FINGERPRINT_IMMUTABLE');
END;

CREATE TRIGGER session_evidence_fingerprints_no_delete
BEFORE DELETE ON session_evidence_fingerprints
BEGIN
  SELECT RAISE(ABORT, 'SESSION_EVIDENCE_FINGERPRINT_IMMUTABLE');
END;

CREATE TRIGGER lifecycle_approval_consumptions_no_update
BEFORE UPDATE ON lifecycle_approval_consumptions
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_APPROVAL_CONSUMPTION_IMMUTABLE');
END;

CREATE TRIGGER lifecycle_approval_consumptions_no_delete
BEFORE DELETE ON lifecycle_approval_consumptions
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_APPROVAL_CONSUMPTION_IMMUTABLE');
END;

CREATE TRIGGER child_transfer_tickets_insert_guard
BEFORE INSERT ON child_transfer_tickets
WHEN json(NEW.source_assignment_json) <> NEW.source_assignment_json
  OR json(NEW.source_scope_json) <> NEW.source_scope_json
  OR json(NEW.follow_ups_json) <> NEW.follow_ups_json
  OR json(NEW.source_state_json) <> NEW.source_state_json
  OR json(NEW.lineage_json) <> NEW.lineage_json
  OR (NEW.claimed_by_root_session_id IS NULL) <> (NEW.claimed_child_session_id IS NULL)
  OR (NEW.claimed_by_root_session_id IS NULL) <> (NEW.claimed_event_position IS NULL)
  OR (NEW.claimed_by_root_session_id IS NULL) <> (NEW.claimed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'CHILD_TRANSFER_TICKET_INVALID');
END;

CREATE TRIGGER child_transfer_tickets_update_guard
BEFORE UPDATE ON child_transfer_tickets
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.transfer_ticket_id IS NOT OLD.transfer_ticket_id
  OR NEW.source_parent_session_id IS NOT OLD.source_parent_session_id
  OR NEW.source_child_session_id IS NOT OLD.source_child_session_id
  OR NEW.source_assignment_json IS NOT OLD.source_assignment_json
  OR NEW.source_scope_json IS NOT OLD.source_scope_json
  OR NEW.checkpoint_id IS NOT OLD.checkpoint_id
  OR NEW.follow_ups_json IS NOT OLD.follow_ups_json
  OR NEW.source_state_json IS NOT OLD.source_state_json
  OR NEW.lineage_json IS NOT OLD.lineage_json
  OR NEW.created_event_position IS NOT OLD.created_event_position
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.claimed_by_root_session_id IS NOT NULL AND (
    NEW.claimed_by_root_session_id IS NOT OLD.claimed_by_root_session_id
    OR NEW.claimed_child_session_id IS NOT OLD.claimed_child_session_id
    OR NEW.claimed_event_position IS NOT OLD.claimed_event_position
    OR NEW.claimed_at IS NOT OLD.claimed_at
  ))
  OR (NEW.claimed_by_root_session_id IS NULL) <> (NEW.claimed_child_session_id IS NULL)
  OR (NEW.claimed_by_root_session_id IS NULL) <> (NEW.claimed_event_position IS NULL)
  OR (NEW.claimed_by_root_session_id IS NULL) <> (NEW.claimed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'CHILD_TRANSFER_TICKET_IMMUTABLE');
END;

CREATE TRIGGER lifecycle_validation_results_insert_guard
BEFORE INSERT ON lifecycle_validation_results
WHEN NEW.project_id <> NEW.validation_start_project_id
  OR NEW.project_id <> NEW.validation_completion_project_id
  OR NEW.workspace_id <> NEW.validation_start_workspace_id
  OR NEW.workspace_id <> NEW.validation_completion_workspace_id
  OR NEW.completed_at < NEW.started_at
  OR json(NEW.artifact_references_json) <> NEW.artifact_references_json
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.artifact_references_json)
    WHERE json_type(value) <> 'text' OR length(value) = 0
  )
  OR NOT EXISTS (
    SELECT 1 FROM events
    WHERE global_position = NEW.recorded_event_position
      AND project_id = NEW.project_id
      AND vault_id = NEW.vault_id
      AND store_id = NEW.store_id
      AND workspace_id = NEW.workspace_id
      AND session_id = NEW.session_id
      AND event_type = 'SessionValidationResultRecorded'
  )
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_VALIDATION_EVENT_MISMATCH');
END;

CREATE TRIGGER lifecycle_validation_results_no_update
BEFORE UPDATE ON lifecycle_validation_results
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_VALIDATION_RESULT_IMMUTABLE');
END;

CREATE TRIGGER lifecycle_validation_results_no_delete
BEFORE DELETE ON lifecycle_validation_results
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_VALIDATION_RESULT_IMMUTABLE');
END;

CREATE TRIGGER command_dedup_lifecycle_insert_guard
BEFORE INSERT ON command_dedup
WHEN
  (NEW.lifecycle_authorization_kind IS NULL AND (
    NEW.authorization_proof_version IS NOT NULL
    OR NEW.authorization_proof_nonce IS NOT NULL
    OR NEW.authorization_proof_digest IS NOT NULL
    OR NEW.authorization_approval_id IS NOT NULL
    OR NEW.authorization_approval_digest IS NOT NULL
    OR NEW.authorization_session_id IS NOT NULL
    OR NEW.target_session_id IS NOT NULL
    OR NEW.presenting_actor_role IS NOT NULL
    OR NEW.presenting_client_instance_id IS NOT NULL
    OR NEW.target_actor_role IS NOT NULL
    OR NEW.target_client_instance_id IS NOT NULL
    OR NEW.internal_workflow_id IS NOT NULL
    OR NEW.internal_workflow_generation IS NOT NULL
    OR NEW.internal_planned_work_id IS NOT NULL
    OR NEW.internal_claim_owner_id IS NOT NULL
    OR NEW.internal_claim_token IS NOT NULL
  ))
  OR (NEW.lifecycle_authorization_kind IS NOT NULL AND (
    NEW.lifecycle_authorization_kind NOT IN ('initial-authority', 'protected', 'internal-workflow')
    OR NEW.presenting_actor_role NOT IN ('primary', 'maintenance', 'untrusted')
    OR NEW.target_actor_role NOT IN ('primary', 'maintenance', 'untrusted')
    OR NEW.presenting_client_instance_id IS NULL
    OR NEW.target_client_instance_id IS NULL
    OR ((NEW.authorization_proof_version IS NULL
      OR NEW.authorization_proof_nonce IS NULL
      OR NEW.authorization_proof_digest IS NULL) AND NOT (
        NEW.authorization_proof_version IS NULL
        AND NEW.authorization_proof_nonce IS NULL
        AND NEW.authorization_proof_digest IS NULL
      ))
    OR (NEW.authorization_proof_version IS NOT NULL AND (
      NEW.authorization_proof_version <= 0
      OR length(NEW.authorization_proof_nonce) <> 36
      OR lower(NEW.authorization_proof_nonce) <> NEW.authorization_proof_nonce
      OR length(NEW.authorization_proof_digest) <> 64
      OR NEW.authorization_proof_digest GLOB '*[^0-9a-f]*'
    ))
    OR ((NEW.authorization_approval_id IS NULL OR NEW.authorization_approval_digest IS NULL)
      AND NOT (NEW.authorization_approval_id IS NULL AND NEW.authorization_approval_digest IS NULL))
    OR (NEW.authorization_approval_id IS NOT NULL AND (
      length(NEW.authorization_approval_id) <> 36
      OR lower(NEW.authorization_approval_id) <> NEW.authorization_approval_id
      OR length(NEW.authorization_approval_digest) <> 64
      OR NEW.authorization_approval_digest GLOB '*[^0-9a-f]*'
    ))
    OR (NEW.lifecycle_authorization_kind = 'initial-authority' AND (
      NEW.authorization_session_id IS NOT NULL
      OR NEW.target_session_id IS NULL
      OR NEW.authorization_proof_version IS NOT NULL
      OR NEW.authorization_approval_id IS NOT NULL
      OR NEW.internal_workflow_id IS NOT NULL
      OR NEW.internal_workflow_generation IS NOT NULL
      OR NEW.internal_planned_work_id IS NOT NULL
      OR NEW.internal_claim_owner_id IS NOT NULL
      OR NEW.internal_claim_token IS NOT NULL
    ))
    OR (NEW.lifecycle_authorization_kind = 'protected' AND (
      NEW.authorization_session_id IS NULL
      OR NEW.target_session_id IS NULL
      OR (NEW.authorization_proof_version IS NULL AND NEW.authorization_approval_id IS NULL)
      OR ((NEW.authorization_proof_version IS NOT NULL AND NEW.authorization_approval_id IS NOT NULL)
        <> (NEW.command_type = 'abandon-session'))
      OR NEW.internal_workflow_id IS NOT NULL
      OR NEW.internal_workflow_generation IS NOT NULL
      OR NEW.internal_planned_work_id IS NOT NULL
      OR NEW.internal_claim_owner_id IS NOT NULL
      OR NEW.internal_claim_token IS NOT NULL
    ))
    OR (NEW.lifecycle_authorization_kind = 'internal-workflow' AND (
      NEW.authorization_session_id IS NULL
      OR NEW.target_session_id IS NULL
      OR NEW.authorization_proof_version IS NOT NULL
      OR NEW.authorization_approval_id IS NOT NULL
      OR NEW.internal_workflow_id IS NULL
      OR NEW.internal_workflow_generation IS NULL OR NEW.internal_workflow_generation <= 0
      OR NEW.internal_planned_work_id IS NULL
      OR length(NEW.internal_planned_work_id) <> 64
      OR NEW.internal_planned_work_id GLOB '*[^0-9a-f]*'
      OR NEW.internal_claim_owner_id IS NULL
      OR NEW.internal_claim_token IS NULL OR NEW.internal_claim_token <= 0
    ))
  ))
BEGIN
  SELECT RAISE(ABORT, 'COMMAND_AUTHORIZATION_INVALID');
END;

CREATE TRIGGER workflow_instances_lifecycle_insert_guard
BEFORE INSERT ON workflow_instances
WHEN
  (NEW.session_id IS NULL AND (
    NEW.triggering_event_position IS NOT NULL
    OR NEW.expected_authority_commitment IS NOT NULL
    OR NEW.coordinator_owner_id IS NOT NULL
    OR NEW.coordinator_claim_token IS NOT NULL
    OR NEW.coordinator_claim_expires_at IS NOT NULL
    OR NEW.coordinator_attempt_count IS NOT NULL
    OR NEW.coordinator_failure_class IS NOT NULL
    OR NEW.coordinator_error_code IS NOT NULL
    OR NEW.coordinator_next_attempt_at IS NOT NULL
    OR NEW.validation_attempt_plan_generation IS NOT NULL
    OR NEW.validation_attempt_plans_json IS NOT NULL
  ))
  OR (NEW.session_id IS NOT NULL AND (
    NEW.workflow_type <> 'session-end'
    OR NEW.triggering_event_position IS NULL OR NEW.triggering_event_position <= 0
    OR NEW.expected_authority_commitment IS NULL
    OR length(NEW.expected_authority_commitment) <> 64
    OR NEW.expected_authority_commitment GLOB '*[^0-9a-f]*'
    OR NEW.coordinator_attempt_count IS NULL OR NEW.coordinator_attempt_count < 0
    OR (NEW.coordinator_owner_id IS NULL) <> (NEW.coordinator_claim_token IS NULL)
    OR (NEW.coordinator_owner_id IS NULL) <> (NEW.coordinator_claim_expires_at IS NULL)
    OR (NEW.coordinator_claim_token IS NOT NULL AND NEW.coordinator_claim_token <= 0)
    OR (NEW.coordinator_failure_class IS NULL) <> (NEW.coordinator_error_code IS NULL)
    OR (NEW.coordinator_failure_class IS NULL AND NEW.coordinator_next_attempt_at IS NOT NULL)
    OR (NEW.coordinator_failure_class = 'retryable' AND NEW.coordinator_next_attempt_at IS NULL)
    OR (NEW.coordinator_failure_class = 'permanent' AND NEW.coordinator_next_attempt_at IS NOT NULL)
    OR (NEW.coordinator_failure_class IS NOT NULL
      AND NEW.coordinator_failure_class NOT IN ('retryable', 'permanent'))
    OR (NEW.validation_attempt_plan_generation IS NULL)
      <> (NEW.validation_attempt_plans_json IS NULL)
    OR (NEW.validation_attempt_plan_generation IS NOT NULL AND (
      NEW.validation_attempt_plan_generation <> NEW.generation
      OR NOT json_valid(NEW.validation_attempt_plans_json)
      OR json_type(NEW.validation_attempt_plans_json) <> 'array'
      OR json(NEW.validation_attempt_plans_json) <> NEW.validation_attempt_plans_json
      OR json_array_length(NEW.validation_attempt_plans_json) < 1
      OR json_array_length(NEW.validation_attempt_plans_json) > 64
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.validation_attempt_plans_json) AS plan
        WHERE json_type(plan.value) <> 'object'
          OR (SELECT count(*) FROM json_each(plan.value)) <> 6
          OR EXISTS (
            SELECT 1 FROM json_each(plan.value)
            WHERE key NOT IN ('profileId', 'profileVersion', 'runId', 'resultId', 'commandId', 'idempotencyKey')
          )
          OR json_type(plan.value, '$.profileId') <> 'text'
          OR json_type(plan.value, '$.profileVersion') <> 'integer'
          OR json_extract(plan.value, '$.profileVersion') <= 0
          OR json_type(plan.value, '$.runId') <> 'text'
          OR json_type(plan.value, '$.resultId') <> 'text'
          OR json_type(plan.value, '$.commandId') <> 'text'
          OR json_type(plan.value, '$.idempotencyKey') <> 'text'
      )
      OR (SELECT count(*) FROM json_each(NEW.validation_attempt_plans_json)) <>
         (SELECT count(DISTINCT json_extract(value, '$.profileId') || char(0)
            || json_extract(value, '$.profileVersion'))
          FROM json_each(NEW.validation_attempt_plans_json))
    ))
  ))
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_LIFECYCLE_INVALID');
END;

CREATE TRIGGER workflow_instances_lifecycle_update_guard
BEFORE UPDATE ON workflow_instances
WHEN
  (NEW.session_id IS NULL AND (
    NEW.triggering_event_position IS NOT NULL
    OR NEW.expected_authority_commitment IS NOT NULL
    OR NEW.coordinator_owner_id IS NOT NULL
    OR NEW.coordinator_claim_token IS NOT NULL
    OR NEW.coordinator_claim_expires_at IS NOT NULL
    OR NEW.coordinator_attempt_count IS NOT NULL
    OR NEW.coordinator_failure_class IS NOT NULL
    OR NEW.coordinator_error_code IS NOT NULL
    OR NEW.coordinator_next_attempt_at IS NOT NULL
    OR NEW.validation_attempt_plan_generation IS NOT NULL
    OR NEW.validation_attempt_plans_json IS NOT NULL
  ))
  OR (NEW.session_id IS NOT NULL AND (
    OLD.session_id IS NULL
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.workflow_id IS NOT OLD.workflow_id
    OR NEW.workflow_type IS NOT OLD.workflow_type
    OR NEW.session_id IS NOT OLD.session_id
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.workflow_type <> 'session-end'
    OR NEW.triggering_event_position IS NULL OR NEW.triggering_event_position <= 0
    OR NEW.expected_authority_commitment IS NULL
    OR length(NEW.expected_authority_commitment) <> 64
    OR NEW.expected_authority_commitment GLOB '*[^0-9a-f]*'
    OR NEW.coordinator_attempt_count IS NULL OR NEW.coordinator_attempt_count < 0
    OR (NEW.coordinator_owner_id IS NULL) <> (NEW.coordinator_claim_token IS NULL)
    OR (NEW.coordinator_owner_id IS NULL) <> (NEW.coordinator_claim_expires_at IS NULL)
    OR (NEW.coordinator_claim_token IS NOT NULL AND NEW.coordinator_claim_token <= 0)
    OR (OLD.coordinator_claim_token IS NOT NULL AND NEW.coordinator_claim_token IS NOT NULL AND (
      NEW.coordinator_claim_token < OLD.coordinator_claim_token
      OR (NEW.coordinator_owner_id IS NOT OLD.coordinator_owner_id
        AND NEW.coordinator_claim_token <= OLD.coordinator_claim_token)
    ))
    OR (NEW.coordinator_failure_class IS NULL) <> (NEW.coordinator_error_code IS NULL)
    OR (NEW.coordinator_failure_class IS NULL AND NEW.coordinator_next_attempt_at IS NOT NULL)
    OR (NEW.coordinator_failure_class = 'retryable' AND NEW.coordinator_next_attempt_at IS NULL)
    OR (NEW.coordinator_failure_class = 'permanent' AND NEW.coordinator_next_attempt_at IS NOT NULL)
    OR (NEW.coordinator_failure_class IS NOT NULL
      AND NEW.coordinator_failure_class NOT IN ('retryable', 'permanent'))
    OR (NEW.validation_attempt_plan_generation IS NULL)
      <> (NEW.validation_attempt_plans_json IS NULL)
    OR (NEW.validation_attempt_plan_generation IS NOT NULL AND (
      NEW.validation_attempt_plan_generation <> NEW.generation
      OR NOT json_valid(NEW.validation_attempt_plans_json)
      OR json_type(NEW.validation_attempt_plans_json) <> 'array'
      OR json(NEW.validation_attempt_plans_json) <> NEW.validation_attempt_plans_json
      OR json_array_length(NEW.validation_attempt_plans_json) < 1
      OR json_array_length(NEW.validation_attempt_plans_json) > 64
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.validation_attempt_plans_json) AS plan
        WHERE json_type(plan.value) <> 'object'
          OR (SELECT count(*) FROM json_each(plan.value)) <> 6
          OR EXISTS (
            SELECT 1 FROM json_each(plan.value)
            WHERE key NOT IN ('profileId', 'profileVersion', 'runId', 'resultId', 'commandId', 'idempotencyKey')
          )
          OR json_type(plan.value, '$.profileId') <> 'text'
          OR json_type(plan.value, '$.profileVersion') <> 'integer'
          OR json_extract(plan.value, '$.profileVersion') <= 0
          OR json_type(plan.value, '$.runId') <> 'text'
          OR json_type(plan.value, '$.resultId') <> 'text'
          OR json_type(plan.value, '$.commandId') <> 'text'
          OR json_type(plan.value, '$.idempotencyKey') <> 'text'
      )
      OR (SELECT count(*) FROM json_each(NEW.validation_attempt_plans_json)) <>
         (SELECT count(DISTINCT json_extract(value, '$.profileId') || char(0)
            || json_extract(value, '$.profileVersion'))
          FROM json_each(NEW.validation_attempt_plans_json))
    ))
    OR (OLD.phase IN ('completed', 'abandoned') AND (
      NEW.phase IS NOT OLD.phase OR NEW.generation IS NOT OLD.generation
    ))
    OR (OLD.phase = 'cancelled' AND NEW.phase IS NOT OLD.phase AND (
      NEW.phase <> 'requested'
      OR NEW.generation <> OLD.generation + 1
      OR NEW.coordinator_owner_id IS NOT NULL
      OR NEW.coordinator_attempt_count <> 0
      OR NEW.coordinator_failure_class IS NOT NULL
      OR NEW.validation_attempt_plan_generation IS NOT NULL
      OR NEW.result_json IS NOT NULL
      OR NEW.error_code IS NOT NULL
    ))
  ))
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_LIFECYCLE_INVALID');
END;

CREATE TRIGGER workflow_instances_generation_guard
BEFORE UPDATE ON workflow_instances
WHEN OLD.session_id IS NOT NULL AND (
  NEW.generation < OLD.generation
  OR NEW.generation > OLD.generation + 1
  OR (NEW.generation = OLD.generation + 1 AND (
    NEW.coordinator_owner_id IS NOT NULL
    OR NEW.coordinator_claim_token IS NOT NULL
    OR NEW.coordinator_claim_expires_at IS NOT NULL
    OR NEW.coordinator_attempt_count <> 0
    OR NEW.coordinator_failure_class IS NOT NULL
    OR NEW.coordinator_error_code IS NOT NULL
    OR NEW.coordinator_next_attempt_at IS NOT NULL
    OR NEW.validation_attempt_plan_generation IS NOT NULL
    OR NEW.validation_attempt_plans_json IS NOT NULL
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_GENERATION_INVALID');
END;

CREATE TRIGGER workflow_instances_validation_plan_immutable
BEFORE UPDATE ON workflow_instances
WHEN OLD.session_id IS NOT NULL
  AND NEW.generation = OLD.generation
  AND OLD.validation_attempt_plans_json IS NOT NULL
  AND (
    NEW.validation_attempt_plan_generation IS NOT OLD.validation_attempt_plan_generation
    OR NEW.validation_attempt_plans_json IS NOT OLD.validation_attempt_plans_json
  )
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_VALIDATION_PLAN_IMMUTABLE');
END;

CREATE TRIGGER outbox_lifecycle_insert_guard
BEFORE INSERT ON outbox
WHEN
  (NEW.session_id IS NULL AND (
    NEW.origin_kind IS NOT NULL
    OR NEW.workflow_id IS NOT NULL
    OR NEW.workflow_generation IS NOT NULL
    OR NEW.artifact_kind IS NOT NULL
    OR NEW.artifact_path IS NOT NULL
    OR NEW.materialization_revision IS NOT NULL
    OR NEW.expected_prior_fingerprint IS NOT NULL
    OR NEW.next_fingerprint IS NOT NULL
    OR NEW.fingerprint_algorithm IS NOT NULL
    OR NEW.fingerprint_schema_version IS NOT NULL
    OR NEW.fingerprint_key_id IS NOT NULL
    OR NEW.fingerprint_domain IS NOT NULL
    OR NEW.failure_class IS NOT NULL
    OR NEW.safe_error_code IS NOT NULL
    OR NEW.next_attempt_at IS NOT NULL
  ))
  OR (NEW.session_id IS NOT NULL AND (
    NEW.origin_kind NOT IN ('workflow', 'terminal-event')
    OR (NEW.origin_kind = 'workflow' AND (
      NEW.workflow_id IS NULL OR NEW.workflow_generation IS NULL OR NEW.workflow_generation <= 0
    ))
    OR (NEW.origin_kind = 'terminal-event' AND (
      NEW.workflow_id IS NOT NULL OR NEW.workflow_generation IS NOT NULL
    ))
    OR NEW.artifact_kind IS NULL
    OR NEW.artifact_path IS NULL
    OR NEW.materialization_revision IS NULL
    OR NEW.materialization_revision <> NEW.event_position
    OR (NEW.expected_prior_fingerprint IS NOT NULL AND (
      length(NEW.expected_prior_fingerprint) <> 64
      OR NEW.expected_prior_fingerprint GLOB '*[^0-9a-f]*'
    ))
    OR NEW.next_fingerprint IS NULL
    OR length(NEW.next_fingerprint) <> 64
    OR NEW.next_fingerprint GLOB '*[^0-9a-f]*'
    OR NEW.fingerprint_algorithm IS NULL
    OR NEW.fingerprint_schema_version IS NULL OR NEW.fingerprint_schema_version <= 0
    OR NEW.fingerprint_key_id IS NULL
    OR NEW.fingerprint_domain IS NULL
    OR (NEW.status = 'pending' AND (
      NEW.claim_owner IS NOT NULL OR NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL
      OR NOT (
        (NEW.failure_class IS NULL AND NEW.safe_error_code IS NULL AND NEW.next_attempt_at IS NULL)
        OR (NEW.failure_class = 'retryable' AND NEW.safe_error_code IS NOT NULL
          AND NEW.next_attempt_at IS NOT NULL)
      )
    ))
    OR (NEW.status = 'claimed' AND (
      NEW.claim_owner IS NULL OR NEW.claim_token IS NULL OR NEW.claim_token <= 0
      OR NEW.claim_expires_at IS NULL
      OR NEW.failure_class IS NOT NULL OR NEW.safe_error_code IS NOT NULL
      OR NEW.next_attempt_at IS NOT NULL
    ))
    OR (NEW.status = 'completed' AND (
      NEW.claim_owner IS NULL OR NEW.claim_token IS NULL OR NEW.claim_token <= 0
      OR NEW.claim_expires_at IS NOT NULL
      OR NEW.failure_class IS NOT NULL OR NEW.safe_error_code IS NOT NULL
      OR NEW.next_attempt_at IS NOT NULL
    ))
    OR (NEW.status = 'failed' AND (
      NEW.claim_owner IS NOT NULL OR NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL
      OR NEW.failure_class NOT IN ('retryable', 'permanent')
      OR NEW.safe_error_code IS NULL
      OR (NEW.failure_class = 'retryable' AND NEW.next_attempt_at IS NULL)
      OR (NEW.failure_class = 'permanent' AND NEW.next_attempt_at IS NOT NULL)
    ))
    OR (NEW.status <> 'pending' AND NEW.attempt_count <= 0)
  ))
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_LIFECYCLE_INVALID');
END;

CREATE TRIGGER outbox_lifecycle_update_guard
BEFORE UPDATE ON outbox
WHEN
  (NEW.session_id IS NULL AND (
    OLD.session_id IS NOT NULL
    OR NEW.origin_kind IS NOT NULL
    OR NEW.workflow_id IS NOT NULL
    OR NEW.workflow_generation IS NOT NULL
    OR NEW.artifact_kind IS NOT NULL
    OR NEW.artifact_path IS NOT NULL
    OR NEW.materialization_revision IS NOT NULL
    OR NEW.expected_prior_fingerprint IS NOT NULL
    OR NEW.next_fingerprint IS NOT NULL
    OR NEW.fingerprint_algorithm IS NOT NULL
    OR NEW.fingerprint_schema_version IS NOT NULL
    OR NEW.fingerprint_key_id IS NOT NULL
    OR NEW.fingerprint_domain IS NOT NULL
    OR NEW.failure_class IS NOT NULL
    OR NEW.safe_error_code IS NOT NULL
    OR NEW.next_attempt_at IS NOT NULL
  ))
  OR (NEW.session_id IS NOT NULL AND (
    OLD.session_id IS NULL
    OR NEW.origin_kind NOT IN ('workflow', 'terminal-event')
    OR (NEW.origin_kind = 'workflow' AND (
      NEW.workflow_id IS NULL OR NEW.workflow_generation IS NULL OR NEW.workflow_generation <= 0
    ))
    OR (NEW.origin_kind = 'terminal-event' AND (
      NEW.workflow_id IS NOT NULL OR NEW.workflow_generation IS NOT NULL
    ))
    OR NEW.materialization_revision <> NEW.event_position
    OR (NEW.expected_prior_fingerprint IS NOT NULL AND (
      length(NEW.expected_prior_fingerprint) <> 64
      OR NEW.expected_prior_fingerprint GLOB '*[^0-9a-f]*'
    ))
    OR NEW.next_fingerprint IS NULL
    OR length(NEW.next_fingerprint) <> 64
    OR NEW.next_fingerprint GLOB '*[^0-9a-f]*'
    OR NEW.fingerprint_schema_version IS NULL OR NEW.fingerprint_schema_version <= 0
    OR (NEW.status = 'pending' AND (
      NEW.claim_owner IS NOT NULL OR NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL
      OR NOT (
        (NEW.failure_class IS NULL AND NEW.safe_error_code IS NULL AND NEW.next_attempt_at IS NULL)
        OR (NEW.failure_class = 'retryable' AND NEW.safe_error_code IS NOT NULL
          AND NEW.next_attempt_at IS NOT NULL)
      )
    ))
    OR (NEW.status = 'claimed' AND (
      NEW.claim_owner IS NULL OR NEW.claim_token IS NULL OR NEW.claim_token <= 0
      OR NEW.claim_expires_at IS NULL
      OR NEW.failure_class IS NOT NULL OR NEW.safe_error_code IS NOT NULL
      OR NEW.next_attempt_at IS NOT NULL
    ))
    OR (NEW.status = 'completed' AND (
      NEW.claim_owner IS NULL OR NEW.claim_token IS NULL OR NEW.claim_token <= 0
      OR NEW.claim_expires_at IS NOT NULL
      OR NEW.failure_class IS NOT NULL OR NEW.safe_error_code IS NOT NULL
      OR NEW.next_attempt_at IS NOT NULL
    ))
    OR (NEW.status = 'failed' AND (
      NEW.claim_owner IS NOT NULL OR NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL
      OR NEW.failure_class NOT IN ('retryable', 'permanent')
      OR NEW.safe_error_code IS NULL
      OR (NEW.failure_class = 'retryable' AND NEW.next_attempt_at IS NULL)
      OR (NEW.failure_class = 'permanent' AND NEW.next_attempt_at IS NOT NULL)
    ))
    OR (NEW.status <> 'pending' AND NEW.attempt_count <= 0)
    OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NOT NULL AND (
      NEW.claim_token < OLD.claim_token
      OR (NEW.claim_owner IS NOT OLD.claim_owner AND NEW.claim_token <= OLD.claim_token)
    ))
    OR (OLD.status = 'completed' AND (
      NEW.status <> 'completed'
      OR NEW.claim_owner IS NOT OLD.claim_owner
      OR NEW.claim_token IS NOT OLD.claim_token
    ))
  ))
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_LIFECYCLE_INVALID');
END;

CREATE TRIGGER outbox_lifecycle_planned_immutable
BEFORE UPDATE ON outbox
WHEN OLD.session_id IS NOT NULL AND (
  NEW.project_id IS NOT OLD.project_id
  OR NEW.target_key IS NOT OLD.target_key
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.origin_kind IS NOT OLD.origin_kind
  OR NEW.workflow_id IS NOT OLD.workflow_id
  OR NEW.workflow_generation IS NOT OLD.workflow_generation
  OR NEW.artifact_kind IS NOT OLD.artifact_kind
  OR NEW.artifact_path IS NOT OLD.artifact_path
  OR NEW.event_position IS NOT OLD.event_position
  OR NEW.materialization_revision IS NOT OLD.materialization_revision
  OR NEW.kind IS NOT OLD.kind
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.expected_prior_fingerprint IS NOT OLD.expected_prior_fingerprint
  OR NEW.next_fingerprint IS NOT OLD.next_fingerprint
  OR NEW.fingerprint_algorithm IS NOT OLD.fingerprint_algorithm
  OR NEW.fingerprint_schema_version IS NOT OLD.fingerprint_schema_version
  OR NEW.fingerprint_key_id IS NOT OLD.fingerprint_key_id
  OR NEW.fingerprint_domain IS NOT OLD.fingerprint_domain
  OR NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_PLANNED_METADATA_IMMUTABLE');
END;
`,
};
