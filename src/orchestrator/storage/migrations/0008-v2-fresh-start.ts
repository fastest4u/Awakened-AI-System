import type { Migration } from "../migration.js";

const hash = (name: string): string => `${name} TEXT NOT NULL CHECK (length(${name}) = 64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
const immutable = (table: string): string => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;`;

export const v2FreshStartMigration: Migration = {
  version: 8,
  name: "v2-fresh-start",
  sql: `
CREATE TABLE fresh_start_releases (
  project_id TEXT NOT NULL, vault_id TEXT NOT NULL, store_id TEXT NOT NULL,
  release_id TEXT NOT NULL, profile_version INTEGER NOT NULL CHECK (profile_version = 1),
  ${hash("build_identity_hash")}, ${hash("schema_identity_hash")},
  ${hash("configuration_hash")}, ${hash("capability_manifest_hash")},
  ${hash("recovery_policy_hash")}, ${hash("evidence_digest")}, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, release_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE fresh_start_installation (
  project_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, store_id TEXT NOT NULL,
  initialization_id TEXT NOT NULL UNIQUE, release_id TEXT NOT NULL,
  semantic_position INTEGER NOT NULL CHECK (semantic_position = 0),
  ${hash("terminal_hash")}, projection_checksums_json TEXT NOT NULL CHECK (json_valid(projection_checksums_json)),
  ${hash("preparation_intent_digest")}, ${hash("actor_fingerprint")}, created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
  FOREIGN KEY (project_id, release_id) REFERENCES fresh_start_releases(project_id, release_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE fresh_start_control_state (
  project_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, store_id TEXT NOT NULL,
  release_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('prepared','active','read-only-recovery','disabled')),
  generation INTEGER NOT NULL CHECK (generation >= 0), recovery_position INTEGER CHECK (recovery_position >= 0),
  recovery_hash TEXT CHECK (recovery_hash IS NULL OR (length(recovery_hash) = 64 AND recovery_hash NOT GLOB '*[^0-9a-f]*')),
  last_transition_id TEXT, updated_at TEXT NOT NULL,
  CHECK ((recovery_position IS NULL) = (recovery_hash IS NULL)),
  FOREIGN KEY (project_id) REFERENCES fresh_start_installation(project_id),
  FOREIGN KEY (project_id, release_id) REFERENCES fresh_start_releases(project_id, release_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE fresh_start_transitions (
  project_id TEXT NOT NULL, transition_id TEXT NOT NULL,
  previous_generation INTEGER NOT NULL CHECK (previous_generation >= 0),
  generation INTEGER NOT NULL CHECK (generation = previous_generation + 1),
  previous_mode TEXT NOT NULL CHECK (previous_mode IN ('prepared','active','read-only-recovery','disabled')),
  mode TEXT NOT NULL CHECK (mode IN ('prepared','active','read-only-recovery','disabled')),
  previous_release_id TEXT NOT NULL, release_id TEXT NOT NULL,
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('operator','automatic-stop')),
  approval_id TEXT, nonce_digest TEXT, actor_fingerprint TEXT, request_digest TEXT, reason_code TEXT,
  ${hash("evidence_digest")}, recovery_position INTEGER CHECK (recovery_position >= 0),
  recovery_hash TEXT CHECK (recovery_hash IS NULL OR (length(recovery_hash) = 64 AND recovery_hash NOT GLOB '*[^0-9a-f]*')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, transition_id), UNIQUE (project_id, generation),
  UNIQUE (project_id, approval_id), UNIQUE (project_id, nonce_digest),
  CHECK ((recovery_position IS NULL) = (recovery_hash IS NULL)),
  CHECK ((authorization_kind = 'operator' AND approval_id IS NOT NULL AND nonce_digest IS NOT NULL AND actor_fingerprint IS NOT NULL AND request_digest IS NOT NULL AND reason_code IS NULL)
    OR (authorization_kind = 'automatic-stop' AND approval_id IS NULL AND nonce_digest IS NULL AND actor_fingerprint IS NULL AND request_digest IS NULL AND reason_code IN ('integrity-failure','privacy-failure','binding-failure','recovery-failure'))),
  FOREIGN KEY (project_id) REFERENCES fresh_start_installation(project_id),
  FOREIGN KEY (project_id, previous_release_id) REFERENCES fresh_start_releases(project_id, release_id),
  FOREIGN KEY (project_id, release_id) REFERENCES fresh_start_releases(project_id, release_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER fresh_start_releases_identity BEFORE INSERT ON fresh_start_releases
WHEN NOT EXISTS (SELECT 1 FROM project_meta WHERE singleton = 1 AND project_id = NEW.project_id AND vault_id = NEW.vault_id AND store_id = NEW.store_id)
BEGIN SELECT RAISE(ABORT, 'FRESH_START_IDENTITY_MISMATCH'); END;
CREATE TRIGGER fresh_start_releases_no_replace BEFORE INSERT ON fresh_start_releases
WHEN EXISTS (SELECT 1 FROM fresh_start_releases WHERE project_id = NEW.project_id AND release_id = NEW.release_id)
BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;
CREATE TRIGGER fresh_start_installation_identity BEFORE INSERT ON fresh_start_installation
WHEN NOT EXISTS (SELECT 1 FROM project_meta WHERE singleton = 1 AND project_id = NEW.project_id AND vault_id = NEW.vault_id AND store_id = NEW.store_id)
  OR NOT EXISTS (SELECT 1 FROM fresh_start_releases WHERE project_id = NEW.project_id AND vault_id = NEW.vault_id AND store_id = NEW.store_id AND release_id = NEW.release_id)
  OR EXISTS (SELECT 1 FROM events) OR EXISTS (SELECT 1 FROM streams)
  OR EXISTS (SELECT 1 FROM command_dedup) OR EXISTS (SELECT 1 FROM rollout_revisions)
  OR EXISTS (SELECT 1 FROM v2_shadow_migration_runs)
BEGIN SELECT RAISE(ABORT, 'FRESH_START_INSTALLATION_INVALID'); END;
CREATE TRIGGER fresh_start_installation_no_replace BEFORE INSERT ON fresh_start_installation
WHEN EXISTS (SELECT 1 FROM fresh_start_installation WHERE project_id = NEW.project_id OR initialization_id = NEW.initialization_id)
BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;
CREATE TRIGGER fresh_start_control_state_initial BEFORE INSERT ON fresh_start_control_state
WHEN EXISTS (SELECT 1 FROM fresh_start_control_state WHERE project_id = NEW.project_id)
  OR NEW.mode <> 'prepared' OR NEW.generation <> 0 OR NEW.last_transition_id IS NOT NULL
  OR NEW.recovery_position IS NOT NULL OR NEW.recovery_hash IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM fresh_start_installation WHERE project_id = NEW.project_id AND vault_id = NEW.vault_id AND store_id = NEW.store_id AND release_id = NEW.release_id)
BEGIN SELECT RAISE(ABORT, 'FRESH_START_STATE_INVALID'); END;
CREATE TRIGGER fresh_start_transitions_sequence BEFORE INSERT ON fresh_start_transitions
WHEN NOT EXISTS (SELECT 1 FROM fresh_start_control_state
  WHERE project_id = NEW.project_id AND generation = NEW.previous_generation AND mode = NEW.previous_mode
    AND release_id = NEW.previous_release_id AND NEW.generation = generation + 1)
BEGIN SELECT RAISE(ABORT, 'FRESH_START_STALE_STATE'); END;
CREATE TRIGGER fresh_start_transitions_no_replace BEFORE INSERT ON fresh_start_transitions
WHEN EXISTS (SELECT 1 FROM fresh_start_transitions WHERE project_id = NEW.project_id
  AND (transition_id = NEW.transition_id OR generation = NEW.generation
    OR (NEW.approval_id IS NOT NULL AND approval_id = NEW.approval_id)
    OR (NEW.nonce_digest IS NOT NULL AND nonce_digest = NEW.nonce_digest)))
BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;
CREATE TRIGGER fresh_start_control_state_sequence BEFORE UPDATE ON fresh_start_control_state
WHEN NEW.project_id <> OLD.project_id OR NEW.vault_id <> OLD.vault_id OR NEW.store_id <> OLD.store_id
  OR NEW.generation <> OLD.generation + 1
  OR NOT EXISTS (SELECT 1 FROM fresh_start_transitions WHERE project_id = OLD.project_id
    AND transition_id = NEW.last_transition_id AND previous_generation = OLD.generation
    AND generation = NEW.generation AND previous_mode = OLD.mode AND mode = NEW.mode
    AND previous_release_id = OLD.release_id AND release_id = NEW.release_id
    AND recovery_position IS NEW.recovery_position AND recovery_hash IS NEW.recovery_hash
    AND recorded_at = NEW.updated_at)
BEGIN SELECT RAISE(ABORT, 'FRESH_START_STATE_INVALID'); END;
CREATE TRIGGER fresh_start_control_state_no_delete BEFORE DELETE ON fresh_start_control_state
BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;

${immutable("fresh_start_releases")}
${immutable("fresh_start_installation")}
${immutable("fresh_start_transitions")}
`,
};
