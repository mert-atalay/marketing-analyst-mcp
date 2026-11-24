import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { statePath, warehousePath } from "./paths.ts";

export interface Context {
  warehouse: DatabaseSync; // synthetic marketing data, opened read-only
  state: DatabaseSync; // proposals and the audit log
}

export function openWarehouse(path = warehousePath()): DatabaseSync {
  if (!existsSync(path)) {
    throw new Error(`Warehouse not found at ${path}. Run "npm run build:db" first.`);
  }
  return new DatabaseSync(path, { readOnly: true });
}

const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  campaign TEXT NOT NULL,
  change_percent REAL NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  arguments TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

export function openState(path = statePath()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(STATE_SCHEMA);
  return db;
}

export function openContext(): Context {
  return { warehouse: openWarehouse(), state: openState() };
}

export function writeAudit(
  state: DatabaseSync,
  entry: { actor: string; action: string; arguments: unknown; ok: boolean; detail?: string },
): void {
  state
    .prepare("INSERT INTO audit_log (at, actor, action, arguments, ok, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      new Date().toISOString(),
      entry.actor,
      entry.action,
      JSON.stringify(entry.arguments ?? null),
      entry.ok ? 1 : 0,
      entry.detail ?? null,
    );
}
