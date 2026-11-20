CREATE TABLE tasks (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
 request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','starting','running','cancelling','succeeded','failed','cancelled','unknown')),
 pid INTEGER, exit_code INTEGER, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX task_queue ON tasks(state,created_at,id);
CREATE TABLE outbox (
 event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 terminal TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
);
