import type { Migration } from "../migration.js";

export const v2RolloutControlPlaneMigration: Migration = {
  version: 6,
  name: "v2-rollout-control-plane",
  sql: `
CREATE TABLE rollout_revisions (
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  parent_revision_id TEXT,
  build_identity_hash TEXT NOT NULL CHECK (
    length(build_identity_hash) = 64
    AND length(CAST(build_identity_hash AS BLOB)) = 64
    AND build_identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  migration_identity_hash TEXT NOT NULL CHECK (
    length(migration_identity_hash) = 64
    AND length(CAST(migration_identity_hash AS BLOB)) = 64
    AND migration_identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  configuration_checksum TEXT NOT NULL CHECK (
    length(configuration_checksum) = 64
    AND length(CAST(configuration_checksum AS BLOB)) = 64
    AND configuration_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  v1_baseline_checksum TEXT NOT NULL CHECK (
    length(v1_baseline_checksum) = 64
    AND length(CAST(v1_baseline_checksum AS BLOB)) = 64
    AND v1_baseline_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  cohort_algorithm_version INTEGER NOT NULL CHECK (cohort_algorithm_version > 0),
  cohort_salt TEXT NOT NULL CHECK (
    length(cohort_salt) = 64
    AND length(CAST(cohort_salt AS BLOB)) = 64
    AND cohort_salt NOT GLOB '*[^0-9a-f]*'
  ),
  cohort_basis_points INTEGER NOT NULL CHECK (cohort_basis_points BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision_id),
  CHECK (parent_revision_id IS NULL OR parent_revision_id <> revision_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
  FOREIGN KEY (project_id, parent_revision_id)
    REFERENCES rollout_revisions(project_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE rollout_transitions (
  project_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  revision_id TEXT,
  from_mode TEXT NOT NULL CHECK (from_mode IN (
    'off', 'shadow', 'canary', 'primary', 'rollback-pending', 'read-only-recovery'
  )),
  to_mode TEXT NOT NULL CHECK (to_mode IN (
    'off', 'shadow', 'canary', 'primary', 'rollback-pending', 'read-only-recovery'
  )),
  prior_state_generation INTEGER NOT NULL CHECK (prior_state_generation >= 0),
  next_state_generation INTEGER NOT NULL CHECK (
    next_state_generation = prior_state_generation + 1
  ),
  approval_id TEXT NOT NULL,
  approval_nonce_digest TEXT NOT NULL CHECK (
    length(approval_nonce_digest) = 64
    AND length(CAST(approval_nonce_digest AS BLOB)) = 64
    AND approval_nonce_digest NOT GLOB '*[^0-9a-f]*'
  ),
  actor_fingerprint TEXT NOT NULL CHECK (
    length(actor_fingerprint) = 64
    AND length(CAST(actor_fingerprint AS BLOB)) = 64
    AND actor_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
    AND length(CAST(evidence_digest AS BLOB)) = 64
    AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, transition_id),
  UNIQUE (project_id, approval_id),
  UNIQUE (project_id, approval_nonce_digest),
  CHECK (
    (to_mode = 'off' AND revision_id IS NULL)
    OR (to_mode <> 'off' AND revision_id IS NOT NULL)
  ),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
  FOREIGN KEY (project_id, revision_id)
    REFERENCES rollout_revisions(project_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE rollout_control_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT NOT NULL UNIQUE,
  active_revision_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN (
    'off', 'shadow', 'canary', 'primary', 'rollback-pending', 'read-only-recovery'
  )),
  state_generation INTEGER NOT NULL CHECK (state_generation >= 0),
  last_transition_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (mode = 'off' AND active_revision_id IS NULL)
    OR (mode <> 'off' AND active_revision_id IS NOT NULL)
  ),
  CHECK (
    (state_generation = 0 AND last_transition_id IS NULL)
    OR (state_generation > 0 AND last_transition_id IS NOT NULL)
  ),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
  FOREIGN KEY (project_id, active_revision_id)
    REFERENCES rollout_revisions(project_id, revision_id),
  FOREIGN KEY (project_id, last_transition_id)
    REFERENCES rollout_transitions(project_id, transition_id)
) STRICT;

INSERT INTO rollout_control_state(
  singleton, project_id, active_revision_id, mode,
  state_generation, last_transition_id, updated_at
)
SELECT 1, project_id, NULL, 'off', 0, NULL, created_at
FROM project_meta
WHERE singleton = 1;

-- Reject replacement conflicts before SQLite can delete an immutable record.
CREATE TRIGGER rollout_revisions_no_replace
BEFORE INSERT ON rollout_revisions
WHEN EXISTS (
  SELECT 1 FROM rollout_revisions
  WHERE project_id = NEW.project_id AND revision_id = NEW.revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_IMMUTABLE');
END;

CREATE TRIGGER rollout_transitions_no_replace
BEFORE INSERT ON rollout_transitions
WHEN EXISTS (
  SELECT 1 FROM rollout_transitions
  WHERE project_id = NEW.project_id
    AND (
      transition_id = NEW.transition_id
      OR approval_id = NEW.approval_id
      OR approval_nonce_digest = NEW.approval_nonce_digest
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_IMMUTABLE');
END;

CREATE TRIGGER rollout_revisions_no_update
BEFORE UPDATE ON rollout_revisions
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_IMMUTABLE');
END;

CREATE TRIGGER rollout_revisions_no_delete
BEFORE DELETE ON rollout_revisions
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_IMMUTABLE');
END;

CREATE TRIGGER rollout_transitions_no_update
BEFORE UPDATE ON rollout_transitions
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_IMMUTABLE');
END;

CREATE TRIGGER rollout_transitions_no_delete
BEFORE DELETE ON rollout_transitions
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_IMMUTABLE');
END;

CREATE TRIGGER rollout_control_state_update_guard
BEFORE UPDATE ON rollout_control_state
WHEN NEW.singleton <> OLD.singleton
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.state_generation <> OLD.state_generation + 1
  OR NOT EXISTS (
    SELECT 1 FROM rollout_transitions AS transition
    WHERE transition.project_id = OLD.project_id
      AND transition.transition_id IS NEW.last_transition_id
      AND transition.from_mode = OLD.mode
      AND transition.to_mode = NEW.mode
      AND transition.prior_state_generation = OLD.state_generation
      AND transition.next_state_generation = NEW.state_generation
      AND transition.revision_id IS NEW.active_revision_id
      AND transition.recorded_at IS NEW.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_STATE_TRANSITION_INVALID');
END;

CREATE TRIGGER rollout_control_state_no_delete
BEFORE DELETE ON rollout_control_state
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_STATE_TRANSITION_INVALID');
END;

CREATE TRIGGER rollout_control_state_no_insert
BEFORE INSERT ON rollout_control_state
BEGIN
  SELECT RAISE(ABORT, 'ROLLOUT_STATE_TRANSITION_INVALID');
END;
`,
};
