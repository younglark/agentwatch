CREATE TABLE schema_info (
 version INTEGER PRIMARY KEY CHECK(version=1), checksum TEXT NOT NULL
);
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
 request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','starting','running','cancelling','succeeded','failed','cancelled','unknown')),
 pid INTEGER, exit_code INTEGER, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX task_queue ON tasks(state,created_at,id);
CREATE TABLE outbox (
 event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 terminal TEXT NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','inflight','accepted','rejected','not_dispatched','unknown')),
 message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 receipt TEXT, last_code TEXT, reconcile_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending ON outbox(state,next_attempt_at,event_id);
