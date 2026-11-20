ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','inflight','accepted','rejected','not_dispatched','unknown'));
ALTER TABLE outbox ADD COLUMN message_id TEXT;
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN receipt TEXT;
ALTER TABLE outbox ADD COLUMN last_code TEXT;
ALTER TABLE outbox ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;
UPDATE outbox SET state='unknown',last_code='LEGACY_DELIVERY_UNVERIFIED' WHERE delivered<>0;
CREATE INDEX outbox_pending ON outbox(state,next_attempt_at,event_id);
