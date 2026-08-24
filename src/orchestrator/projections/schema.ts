import type { SqliteConnection } from "../storage/sqlite-driver.js";

export const PROJECTION_SCHEMA_VERSION = 1 as const;

export const PROJECTION_SCHEMA_SQL_V1 = `
  CREATE TABLE projection_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    project_id TEXT CHECK (
      project_id IS NULL OR (length(project_id) = 64 AND project_id NOT GLOB '*[^0-9a-f]*')
    ),
    vault_id TEXT CHECK (
      vault_id IS NULL OR (length(vault_id) = 64 AND vault_id NOT GLOB '*[^0-9a-f]*')
    ),
    store_id TEXT CHECK (
      store_id IS NULL OR (length(store_id) = 64 AND store_id NOT GLOB '*[^0-9a-f]*')
    ),
    workspace_id TEXT CHECK (
      workspace_id IS NULL OR (length(workspace_id) = 64 AND workspace_id NOT GLOB '*[^0-9a-f]*')
    ),
    branch_scope_id TEXT,
    branch_ref TEXT,
    session_id TEXT CHECK (session_id IS NULL),
    generation INTEGER CHECK (generation IS NULL OR generation BETWEEN 1 AND 2147483647),
    terminal_event_position INTEGER CHECK (
      terminal_event_position IS NULL OR terminal_event_position >= 0
    ),
    terminal_event_hash TEXT CHECK (
      terminal_event_hash IS NULL OR (
        length(terminal_event_hash) = 64 AND terminal_event_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at TEXT,
    CHECK (
      (
        project_id IS NULL AND vault_id IS NULL AND store_id IS NULL
        AND workspace_id IS NULL AND branch_scope_id IS NULL AND branch_ref IS NULL
        AND generation IS NULL AND terminal_event_position IS NULL
        AND terminal_event_hash IS NULL AND created_at IS NULL
      ) OR (
        project_id IS NOT NULL AND vault_id IS NOT NULL AND store_id IS NOT NULL
        AND workspace_id IS NOT NULL AND generation IS NOT NULL
        AND terminal_event_position IS NOT NULL AND terminal_event_hash IS NOT NULL
        AND created_at IS NOT NULL
      )
    )
  ) STRICT;

  INSERT INTO projection_metadata(singleton, schema_version) VALUES (1, 1);

  CREATE TABLE session_tree (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version IN (1, 2)),
    base_event_position INTEGER NOT NULL CHECK (base_event_position > 0),
    source_event_position INTEGER NOT NULL CHECK (source_event_position > 0),
    occurred_at TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id),
    CHECK (base_event_position <= source_event_position)
  ) STRICT;

  CREATE INDEX session_tree_project_position_idx
    ON session_tree(project_id, source_event_position DESC, session_id);

  CREATE TABLE canonical_items (
    project_id TEXT NOT NULL,
    session_id TEXT,
    item_id TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'candidate', 'provisional', 'verified', 'conflicted', 'superseded',
      'retracted', 'expired', 'erased-evidence'
    )),
    confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'guess')),
    verification_method TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    summary TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    known_from_event_position INTEGER NOT NULL CHECK (known_from_event_position > 0),
    source_event_position INTEGER NOT NULL CHECK (source_event_position > 0),
    PRIMARY KEY (project_id, item_id),
    UNIQUE (project_id, normalized_key),
    CHECK (known_from_event_position <= source_event_position)
  ) STRICT;

  CREATE INDEX canonical_items_candidates_idx
    ON canonical_items(project_id, session_id, status, valid_from, valid_to, source_event_position DESC, item_id);

  CREATE TABLE tasks_followups (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    follow_up_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'blocked')),
    summary TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'guess')),
    source_event_position INTEGER NOT NULL CHECK (source_event_position > 0),
    PRIMARY KEY (project_id, follow_up_id)
  ) STRICT;

  CREATE INDEX tasks_followups_candidates_idx
    ON tasks_followups(project_id, status, source_event_position DESC, follow_up_id);

  CREATE TABLE artifacts_files (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    path TEXT NOT NULL,
    summary TEXT,
    action TEXT NOT NULL CHECK (action IN (
      'created', 'modified', 'deleted', 'observed', 'renamed', 'referenced'
    )),
    content_hash TEXT CHECK (
      content_hash IS NULL OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')
    ),
    branch_ref TEXT,
    confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'guess')),
    source_event_position INTEGER NOT NULL CHECK (source_event_position > 0),
    PRIMARY KEY (project_id, session_id, artifact_id)
  ) STRICT;

  CREATE INDEX artifacts_files_path_idx
    ON artifacts_files(project_id, path, source_event_position DESC, artifact_id);

  CREATE TABLE entity_graph (
    project_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    relationship TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    source_event_position INTEGER NOT NULL CHECK (source_event_position > 0),
    PRIMARY KEY (project_id, edge_id)
  ) STRICT;

  CREATE INDEX entity_graph_source_idx
    ON entity_graph(project_id, source_entity_id, relationship, source_event_position DESC, edge_id);
  CREATE INDEX entity_graph_target_idx
    ON entity_graph(project_id, target_entity_id, relationship, source_event_position DESC, edge_id);

  CREATE TABLE lexical_chunks (
    row_id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    item_id TEXT,
    session_id TEXT,
    section TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    text TEXT NOT NULL,
    source_event_position INTEGER NOT NULL CHECK (source_event_position > 0),
    UNIQUE (project_id, chunk_id)
  ) STRICT;

  CREATE INDEX lexical_chunks_scope_idx
    ON lexical_chunks(project_id, source_event_position DESC, chunk_id);

  CREATE VIRTUAL TABLE lexical_chunks_fts USING fts5(
    normalized_key,
    text,
    content = 'lexical_chunks',
    content_rowid = 'row_id',
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER lexical_chunks_fts_insert AFTER INSERT ON lexical_chunks BEGIN
    INSERT INTO lexical_chunks_fts(rowid, normalized_key, text)
    VALUES (new.row_id, new.normalized_key, new.text);
  END;

  CREATE TRIGGER lexical_chunks_fts_delete AFTER DELETE ON lexical_chunks BEGIN
    INSERT INTO lexical_chunks_fts(lexical_chunks_fts, rowid, normalized_key, text)
    VALUES ('delete', old.row_id, old.normalized_key, old.text);
  END;

  CREATE TRIGGER lexical_chunks_fts_update AFTER UPDATE ON lexical_chunks BEGIN
    INSERT INTO lexical_chunks_fts(lexical_chunks_fts, rowid, normalized_key, text)
    VALUES ('delete', old.row_id, old.normalized_key, old.text);
    INSERT INTO lexical_chunks_fts(rowid, normalized_key, text)
    VALUES (new.row_id, new.normalized_key, new.text);
  END;

  CREATE TABLE retrieval_feedback (
    project_id TEXT NOT NULL,
    feedback_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'dismissed', 'corrected')),
    usefulness INTEGER NOT NULL CHECK (usefulness BETWEEN -10000 AND 10000),
    source_item_event_position INTEGER NOT NULL CHECK (source_item_event_position > 0),
    source_event_position INTEGER NOT NULL CHECK (source_event_position > 0),
    PRIMARY KEY (project_id, feedback_id),
    CHECK (source_item_event_position <= source_event_position)
  ) STRICT;

  CREATE INDEX retrieval_feedback_item_idx
    ON retrieval_feedback(project_id, item_id, source_event_position DESC, feedback_id);
`;

export function createProjectionSchema(connection: SqliteConnection): void {
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(PROJECTION_SCHEMA_SQL_V1);
    connection.exec("COMMIT");
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // Preserve the schema failure.
    }
    throw error;
  }
}
