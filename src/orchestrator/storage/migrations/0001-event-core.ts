import type { Migration } from "../migration.js";

export const eventCoreMigration: Migration = {
  version: 1,
  name: "event-core",
  sql: `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT NOT NULL UNIQUE,
  vault_id TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE branch_scopes (
  project_id TEXT NOT NULL,
  branch_scope_id TEXT NOT NULL,
  current_ref TEXT,
  created_head TEXT NOT NULL,
  detached INTEGER NOT NULL CHECK (detached IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (project_id, branch_scope_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE UNIQUE INDEX branch_scopes_active_ref
ON branch_scopes(project_id, current_ref)
WHERE current_ref IS NOT NULL AND retired_at IS NULL;

CREATE INDEX branch_scopes_detached_head
ON branch_scopes(project_id, created_head)
WHERE detached = 1 AND retired_at IS NULL;

CREATE TABLE streams (
  project_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_type TEXT NOT NULL CHECK (length(stream_type) > 0),
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, stream_id),
  UNIQUE (project_id, stream_id, stream_type),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE TABLE events (
  global_position INTEGER PRIMARY KEY CHECK (global_position > 0),
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  branch_scope_id TEXT,
  branch_ref TEXT,
  stream_id TEXT NOT NULL,
  stream_type TEXT NOT NULL CHECK (length(stream_type) > 0),
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  event_schema_version INTEGER NOT NULL CHECK (event_schema_version > 0),
  session_id TEXT,
  parent_session_id TEXT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('primary','maintenance','untrusted')),
  agent_id TEXT NOT NULL,
  client_instance_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_event_index INTEGER NOT NULL CHECK (command_event_index >= 0),
  occurred_at TEXT NOT NULL CHECK (length(trim(occurred_at)) > 0),
  recorded_at TEXT NOT NULL CHECK (length(trim(recorded_at)) > 0),
  visibility_scope TEXT NOT NULL CHECK (visibility_scope IN ('session','workspace','branch','project','global')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low','guess')),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified','provisional','verified','conflicted')),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  evidence_digests_json TEXT NOT NULL CHECK (json_valid(evidence_digests_json)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  previous_global_hash TEXT NOT NULL CHECK (length(previous_global_hash) = 64),
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  UNIQUE (project_id, stream_id, stream_version),
  UNIQUE (project_id, command_id, command_event_index),
  FOREIGN KEY (project_id, stream_id, stream_type) REFERENCES streams(project_id, stream_id, stream_type),
  FOREIGN KEY (project_id, branch_scope_id) REFERENCES branch_scopes(project_id, branch_scope_id)
) STRICT;

CREATE INDEX events_project_idempotency
ON events(project_id, idempotency_key);

CREATE INDEX events_project_position
ON events(project_id, global_position);

CREATE INDEX events_project_hash_chain
ON events(project_id, global_position, previous_global_hash, event_hash);

CREATE INDEX events_stream_range
ON events(project_id, stream_id, stream_version);

CREATE TABLE command_dedup (
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
  workspace_head_commit TEXT CHECK (
    workspace_head_commit IS NULL
    OR (
      length(workspace_head_commit) IN (40, 64)
      AND workspace_head_commit NOT GLOB '*[^0-9a-f]*'
    )
  ),
  outbox_order_json TEXT NOT NULL CHECK (
    json_valid(outbox_order_json)
    AND json_type(outbox_order_json) = 'array'
  ),
  state TEXT NOT NULL CHECK (state = 'committed'),
  first_global_position INTEGER NOT NULL,
  last_global_position INTEGER NOT NULL CHECK (last_global_position >= first_global_position),
  final_stream_version INTEGER NOT NULL CHECK (final_stream_version > 0),
  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  response_hash TEXT NOT NULL CHECK (length(response_hash) = 64),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, idempotency_key),
  UNIQUE (project_id, command_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE INDEX command_dedup_event_range
ON command_dedup(project_id, first_global_position, last_global_position);

CREATE TABLE workflow_instances (
  project_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  root_command_id TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, workflow_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE TABLE outbox (
  project_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  event_position INTEGER NOT NULL CHECK (event_position > 0),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_owner TEXT,
  claim_token INTEGER,
  claim_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, target_key),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
  FOREIGN KEY (event_position) REFERENCES events(global_position)
) STRICT;

CREATE INDEX outbox_delivery_order
ON outbox(project_id, status, event_position);

CREATE TABLE maintenance_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('idle','quiescing')),
  owner_id TEXT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  lease_expires_at TEXT,
  requested_at TEXT
) STRICT;

CREATE TABLE executor_leases (
  project_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  binding_generation INTEGER NOT NULL CHECK (binding_generation > 0),
  context_fingerprint TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (project_id, executor_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE TABLE maintenance_acknowledgements (
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  executor_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (epoch, executor_id)
) STRICT;

CREATE TABLE maintenance_required_executors (
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  executor_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  required_at TEXT NOT NULL,
  PRIMARY KEY (epoch, executor_id)
) STRICT;

CREATE TRIGGER schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'SCHEMA_MIGRATIONS_IMMUTABLE'); END;

CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'SCHEMA_MIGRATIONS_IMMUTABLE'); END;

CREATE TRIGGER project_meta_no_update
BEFORE UPDATE ON project_meta
BEGIN SELECT RAISE(ABORT, 'PROJECT_META_IMMUTABLE'); END;

CREATE TRIGGER project_meta_no_delete
BEFORE DELETE ON project_meta
BEGIN SELECT RAISE(ABORT, 'PROJECT_META_IMMUTABLE'); END;

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'EVENTS_IMMUTABLE'); END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'EVENTS_IMMUTABLE'); END;

CREATE TRIGGER command_dedup_no_update
BEFORE UPDATE ON command_dedup
BEGIN SELECT RAISE(ABORT, 'COMMAND_DEDUP_IMMUTABLE'); END;

CREATE TRIGGER command_dedup_no_delete
BEFORE DELETE ON command_dedup
BEGIN SELECT RAISE(ABORT, 'COMMAND_DEDUP_IMMUTABLE'); END;

CREATE TRIGGER events_identity_guard
BEFORE INSERT ON events
WHEN NOT EXISTS (
  SELECT 1 FROM project_meta
  WHERE singleton = 1
    AND project_id = NEW.project_id
    AND vault_id = NEW.vault_id
    AND store_id = NEW.store_id
)
BEGIN SELECT RAISE(ABORT, 'EVENT_PROJECT_IDENTITY_MISMATCH'); END;
`,
};
