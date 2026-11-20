import { Effect } from 'effect';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { makeWithDefaults } from 'drizzle-orm/effect-sqlite-bun';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import migration from './migrations/001.sql' with { type: 'text' };

export const tasks = sqliteTable('tasks', {
  id: text().primaryKey(), request_id: text().notNull().unique(), fingerprint: text().notNull(),
  input: text().notNull(), state: text().notNull(), pid: integer(), exit_code: integer(),
  created: integer().notNull(), not_before: integer().notNull()
});
export type Task = typeof tasks.$inferSelect;
export const makeStore = (sql: SqliteClient.SqliteClient) => Effect.gen(function* () {
  const orm = yield* makeWithDefaults().pipe(Effect.provideService(SqliteClient.SqliteClient, sql));
  const init = sql.withTransaction(Effect.gen(function* () {
    for (const statement of migration.split(';').map(s => s.trim()).filter(Boolean)) {
      yield* sql.unsafe(statement);
    }
  }));
  return { sql, orm, init };
});
