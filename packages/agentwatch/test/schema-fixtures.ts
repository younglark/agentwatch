import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
// Historical development DB fixtures from 2c57edc; never imported by production.
export const legacyInitial=`CREATE TABLE tasks (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
 request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','starting','running','cancelling','succeeded','failed','cancelled','unknown')),
 pid INTEGER, exit_code INTEGER, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX task_queue ON tasks(state,created_at,id);
CREATE TABLE outbox (
 event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 terminal TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
);
`;
export const legacyNotifications=`ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','inflight','accepted','rejected','not_dispatched','unknown'));
ALTER TABLE outbox ADD COLUMN message_id TEXT;
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN receipt TEXT;
ALTER TABLE outbox ADD COLUMN last_code TEXT;
ALTER TABLE outbox ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;
UPDATE outbox SET state='unknown',last_code='LEGACY_DELIVERY_UNVERIFIED' WHERE delivered<>0;
CREATE INDEX outbox_pending ON outbox(state,next_attempt_at,event_id);
`;

export function seedLegacyDatabase(state:string,version:1|2) {
  const file=join(state,'tasks.sqlite'),raw=new Database(file);
  try{
    raw.exec(legacyInitial);raw.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');
    raw.query('INSERT INTO migrations VALUES(1,?)').run(createHash('sha256').update(legacyInitial).digest('hex'));
    for(const [id,delivered] of [['11111111-1111-4111-8111-111111111111',0],['22222222-2222-4222-8222-222222222222',1]] as const){
      raw.query('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,id,'old-fingerprint',JSON.stringify({request_id:id,bot:'test-bot',cwd:state,argv:['claude']}),'succeeded',null,0,null,1,1);
      raw.query('INSERT INTO outbox VALUES(?,?,?,?,?)').run(id+':terminal:1',id,'succeeded',JSON.stringify({version:1,event_id:id+':terminal:1',task_id:id,state:'succeeded',exit_code:0,error_code:null}),delivered);
    }
    if(version===2){raw.exec(legacyNotifications);raw.query('INSERT INTO migrations VALUES(2,?)').run(createHash('sha256').update(legacyNotifications).digest('hex'));}
    return {file,records:{tasks:raw.query('SELECT * FROM tasks ORDER BY id').all(),outbox:raw.query('SELECT * FROM outbox ORDER BY event_id').all()}};
  }finally{raw.close();chmodSync(file,0o600);}
}
