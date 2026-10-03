import type { Migration } from "../migration.js";
const immutable = (table: string, collision: string): string => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision})
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_IMMUTABLE'); END;`;
const scopedEvent = `NOT EXISTS (SELECT 1 FROM events e WHERE e.event_id = NEW.event_id AND e.global_position = NEW.event_position
 AND e.project_id = NEW.project_id AND e.command_id = NEW.command_id AND e.idempotency_key = NEW.idempotency_key
 AND e.event_type = 'EvidenceBatchRetained' AND e.event_schema_version = 1 AND e.command_event_index = 0)`;

export const retainedEvidenceMigration: Migration = {
  version: 9, name: "retained-evidence", sql: `
CREATE TABLE retained_evidence_command_authorizations (
 project_id TEXT NOT NULL, command_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 event_id TEXT NOT NULL, event_position INTEGER NOT NULL CHECK (event_position > 0),
 authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json) AND json_type(authorization_json) IS 'object'
   AND json_type(authorization_json, '$.projectId') IS 'text' AND json_extract(authorization_json, '$.projectId') IS project_id
   AND json_type(authorization_json, '$.vaultId') IS 'text' AND json_type(authorization_json, '$.storeId') IS 'text'
   AND json_type(authorization_json, '$.targetSessionId') IS 'text'
   AND json_type(authorization_json, '$.authorizationSessionId') IS 'text'
   AND json_type(authorization_json, '$.rootSessionId') IS 'text'
   AND json_type(authorization_json, '$.rootOwnerGeneration') IS 'text'),
 PRIMARY KEY (project_id, command_id), UNIQUE (project_id, idempotency_key),
 UNIQUE (project_id, event_id), UNIQUE (project_id, event_position),
 FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
 FOREIGN KEY (event_id) REFERENCES events(event_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (event_position) REFERENCES events(global_position) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (project_id, command_id) REFERENCES command_dedup(project_id, command_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (project_id, idempotency_key) REFERENCES command_dedup(project_id, idempotency_key) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TABLE retained_evidence_blobs (
 project_id TEXT NOT NULL, vault_id TEXT NOT NULL, store_id TEXT NOT NULL,
 evidence_id TEXT NOT NULL, event_id TEXT NOT NULL, event_position INTEGER NOT NULL CHECK (event_position > 0),
 command_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, item_index INTEGER NOT NULL CHECK (item_index BETWEEN 0 AND 63),
 target_session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, frame_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 encrypted_item_json TEXT NOT NULL CHECK (json_valid(encrypted_item_json) AND length(CAST(encrypted_item_json AS BLOB)) <= 2097152
   AND json_type(encrypted_item_json) IS 'object' AND json_type(encrypted_item_json, '$.formatVersion') IS 'integer'
   AND json_extract(encrypted_item_json, '$.formatVersion') IS 1 AND json_extract(encrypted_item_json, '$.algorithm') IS 'AES-256-GCM'
   AND json_type(encrypted_item_json, '$.binding') IS 'object' AND json_type(encrypted_item_json, '$.frame') IS 'object'
   AND json_extract(encrypted_item_json, '$.binding.projectId') IS project_id
   AND json_extract(encrypted_item_json, '$.binding.vaultId') IS vault_id
   AND json_extract(encrypted_item_json, '$.binding.storeId') IS store_id
   AND json_extract(encrypted_item_json, '$.binding.evidenceId') IS evidence_id
   AND json_extract(encrypted_item_json, '$.binding.eventId') IS event_id
   AND json_extract(encrypted_item_json, '$.binding.targetSessionId') IS target_session_id
   AND json_extract(encrypted_item_json, '$.binding.conversationId') IS conversation_id
   AND json_extract(encrypted_item_json, '$.binding.frameId') IS frame_id
   AND json_type(encrypted_item_json, '$.binding.formatVersion') IS 'integer' AND json_extract(encrypted_item_json, '$.binding.formatVersion') IS 1
   AND json_type(encrypted_item_json, '$.binding.mediaType') IS 'text' AND json_extract(encrypted_item_json, '$.binding.mediaType') IN ('text/plain; charset=utf-8','application/json')
   AND json_type(encrypted_item_json, '$.binding.policyId') IS 'text' AND json_type(encrypted_item_json, '$.binding.policyVersion') IS 'text'
   AND json_extract(encrypted_item_json, '$.frame.frameId') IS frame_id
   AND json_type(encrypted_item_json, '$.frame.ordinal') IS 'text'
   AND json_extract(encrypted_item_json, '$.frame.ordinal') IS CAST(ordinal AS TEXT)
   AND json_type(encrypted_item_json, '$.frame.role') IS 'text' AND json_extract(encrypted_item_json, '$.frame.role') IN ('user','assistant','tool')
   AND json_type(encrypted_item_json, '$.frame.category') IS 'text' AND json_extract(encrypted_item_json, '$.frame.category') IN ('user-message','assistant-message','tool-input','tool-output','child-report','artifact-reference','retrieval-feedback','user-correction')
   AND json_type(encrypted_item_json, '$.frame.occurredAt') IS 'text'
   AND json_type(encrypted_item_json, '$.frame.mediaType') IS 'text' AND json_extract(encrypted_item_json, '$.frame.mediaType') IS json_extract(encrypted_item_json, '$.binding.mediaType')
   AND json_type(encrypted_item_json, '$.frame.artifactHashes') IS 'array'
   AND (json_type(encrypted_item_json, '$.frame.previousFrameId') IS 'null' OR json_type(encrypted_item_json, '$.frame.previousFrameId') IS 'text')
   AND (json_type(encrypted_item_json, '$.frame.toolCorrelationId') IS 'null' OR json_type(encrypted_item_json, '$.frame.toolCorrelationId') IS 'text')
   AND json_type(encrypted_item_json, '$.wrapKeyRef') IS 'object' AND json_type(encrypted_item_json, '$.wrapKeyRef.keyId') IS 'text' AND json_type(encrypted_item_json, '$.wrapKeyRef.version') IS 'text'
   AND json_type(encrypted_item_json, '$.fingerprintKeyRef') IS 'object' AND json_type(encrypted_item_json, '$.fingerprintKeyRef.keyId') IS 'text' AND json_type(encrypted_item_json, '$.fingerprintKeyRef.version') IS 'text'
   AND json_type(encrypted_item_json, '$.nonce') IS 'text' AND json_type(encrypted_item_json, '$.tag') IS 'text'
   AND json_type(encrypted_item_json, '$.ciphertext') IS 'text' AND json_type(encrypted_item_json, '$.wrappedKey') IS 'object'
   AND json_type(encrypted_item_json, '$.wrappedKey.formatVersion') IS 'integer' AND json_extract(encrypted_item_json, '$.wrappedKey.formatVersion') IS 1
   AND json_extract(encrypted_item_json, '$.wrappedKey.algorithm') IS 'AES-256-GCM'
   AND json_type(encrypted_item_json, '$.wrappedKey.keyRef') IS 'object' AND json_type(encrypted_item_json, '$.wrappedKey.keyRef.keyId') IS 'text' AND json_type(encrypted_item_json, '$.wrappedKey.keyRef.version') IS 'text'
   AND json_extract(encrypted_item_json, '$.wrappedKey.keyRef') IS json_extract(encrypted_item_json, '$.wrapKeyRef')
   AND json_type(encrypted_item_json, '$.wrappedKey.nonce') IS 'text' AND json_type(encrypted_item_json, '$.wrappedKey.tag') IS 'text' AND json_type(encrypted_item_json, '$.wrappedKey.ciphertext') IS 'text'
   AND json_type(encrypted_item_json, '$.ciphertextHash') IS 'text' AND json_type(encrypted_item_json, '$.wrappedKeyHash') IS 'text'
   AND json_type(encrypted_item_json, '$.keyedFingerprint') IS 'text'),
 PRIMARY KEY (project_id, evidence_id),
 UNIQUE (project_id, target_session_id, conversation_id, frame_id),
 UNIQUE (project_id, target_session_id, conversation_id, ordinal),
 UNIQUE (project_id, command_id, item_index),
 FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
 FOREIGN KEY (event_id) REFERENCES events(event_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (event_position) REFERENCES events(global_position) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (project_id, command_id) REFERENCES retained_evidence_command_authorizations(project_id, command_id) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;
CREATE INDEX retained_evidence_tool_inputs ON retained_evidence_blobs(project_id, target_session_id, conversation_id, ordinal);

CREATE TABLE retained_evidence_stream_heads (
 project_id TEXT NOT NULL, target_session_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 last_frame_id TEXT NOT NULL, last_ordinal INTEGER NOT NULL CHECK (last_ordinal >= 0),
 version INTEGER NOT NULL CHECK (version > 0),
 PRIMARY KEY (project_id, target_session_id, conversation_id),
 FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
 FOREIGN KEY (project_id, target_session_id, conversation_id, last_frame_id)
 REFERENCES retained_evidence_blobs(project_id, target_session_id, conversation_id, frame_id) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TRIGGER retained_evidence_blobs_scope BEFORE INSERT ON retained_evidence_blobs
WHEN ${scopedEvent}
 OR NOT EXISTS (SELECT 1 FROM project_meta WHERE project_id = NEW.project_id AND vault_id = NEW.vault_id AND store_id = NEW.store_id)
 OR NOT EXISTS (SELECT 1 FROM events WHERE event_id = NEW.event_id AND session_id = NEW.target_session_id
   AND vault_id = NEW.vault_id AND store_id = NEW.store_id
   AND json_extract(payload_json, '$.witness.conversationId') IS NEW.conversation_id)
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_CORRESPONDENCE'); END;
CREATE TRIGGER retained_evidence_authorizations_scope BEFORE INSERT ON retained_evidence_command_authorizations
WHEN ${scopedEvent}
 OR NOT EXISTS (SELECT 1 FROM events e WHERE e.event_id = NEW.event_id
   AND json_extract(e.payload_json, '$.witness.authority') IS json(NEW.authorization_json))
 OR EXISTS (SELECT 1 FROM command_dedup d WHERE d.project_id = NEW.project_id
   AND (d.command_id = NEW.command_id OR d.idempotency_key = NEW.idempotency_key)
   AND (d.command_id <> NEW.command_id OR d.idempotency_key <> NEW.idempotency_key
     OR d.command_type <> 'retain-evidence-batch' OR d.first_global_position <> NEW.event_position
     OR d.last_global_position <> NEW.event_position OR json_extract(d.event_ids_json, '$[0]') IS NOT NEW.event_id
     OR json_array_length(d.event_ids_json) <> 1))
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_CORRESPONDENCE'); END;
CREATE TRIGGER retained_evidence_dedup_scope BEFORE INSERT ON command_dedup
WHEN EXISTS (SELECT 1 FROM retained_evidence_command_authorizations a WHERE a.project_id = NEW.project_id
 AND (a.command_id = NEW.command_id OR a.idempotency_key = NEW.idempotency_key)
 AND (a.command_id <> NEW.command_id OR a.idempotency_key <> NEW.idempotency_key
   OR NEW.command_type <> 'retain-evidence-batch' OR NEW.first_global_position <> a.event_position
   OR NEW.last_global_position <> a.event_position OR json_type(NEW.event_ids_json) IS NOT 'array'
   OR json_array_length(NEW.event_ids_json) <> 1 OR json_extract(NEW.event_ids_json, '$[0]') IS NOT a.event_id))
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_CORRESPONDENCE'); END;
CREATE TRIGGER retained_evidence_event_no_replace BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM retained_evidence_command_authorizations a
 WHERE a.event_id = NEW.event_id OR a.event_position = NEW.global_position)
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER retained_evidence_dedup_no_replace BEFORE INSERT ON command_dedup
WHEN EXISTS (SELECT 1 FROM retained_evidence_command_authorizations a JOIN command_dedup d
 ON d.project_id = a.project_id AND d.command_id = a.command_id
 WHERE d.project_id = NEW.project_id AND (d.command_id = NEW.command_id OR d.idempotency_key = NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_IMMUTABLE'); END;
${immutable("retained_evidence_blobs", "project_id = NEW.project_id AND (evidence_id = NEW.evidence_id OR (target_session_id = NEW.target_session_id AND conversation_id = NEW.conversation_id AND (frame_id = NEW.frame_id OR ordinal = NEW.ordinal)) OR (command_id = NEW.command_id AND item_index = NEW.item_index))")}
${immutable("retained_evidence_command_authorizations", "project_id = NEW.project_id AND (command_id = NEW.command_id OR idempotency_key = NEW.idempotency_key OR event_id = NEW.event_id OR event_position = NEW.event_position)")}

CREATE TRIGGER retained_evidence_head_insert BEFORE INSERT ON retained_evidence_stream_heads
WHEN NEW.version <> 1 OR EXISTS (SELECT 1 FROM retained_evidence_stream_heads WHERE project_id = NEW.project_id
 AND target_session_id = NEW.target_session_id AND conversation_id = NEW.conversation_id)
 OR NOT EXISTS (SELECT 1 FROM retained_evidence_blobs WHERE project_id = NEW.project_id AND target_session_id = NEW.target_session_id
 AND conversation_id = NEW.conversation_id AND frame_id = NEW.last_frame_id AND ordinal = NEW.last_ordinal)
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_ORDER_CONFLICT'); END;
CREATE TRIGGER retained_evidence_head_update BEFORE UPDATE ON retained_evidence_stream_heads
WHEN NEW.project_id <> OLD.project_id OR NEW.target_session_id <> OLD.target_session_id OR NEW.conversation_id <> OLD.conversation_id
 OR NEW.version <> OLD.version + 1 OR NEW.last_ordinal <= OLD.last_ordinal
 OR NOT EXISTS (SELECT 1 FROM retained_evidence_blobs WHERE project_id = NEW.project_id AND target_session_id = NEW.target_session_id
 AND conversation_id = NEW.conversation_id AND frame_id = NEW.last_frame_id AND ordinal = NEW.last_ordinal)
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_ORDER_CONFLICT'); END;
CREATE TRIGGER retained_evidence_head_no_delete BEFORE DELETE ON retained_evidence_stream_heads
BEGIN SELECT RAISE(ABORT, 'RETAINED_EVIDENCE_IMMUTABLE'); END;
`,
};
