/**
 * Session persistence (Neon Postgres).
 *
 * Pipeline runs used to live only in an in-memory Map, so a Railway restart
 * wiped every in-flight run and the UI froze forever. We now persist each
 * session to a `pipeline_sessions` table so runs survive restarts and the
 * frontend can poll `/api/pipeline/session/:id` and always get real state.
 *
 * The DB is optional: if DATABASE_URL is unset the functions no-op and the
 * orchestrator falls back to its in-memory Map (dev / degraded mode).
 */
import { Pool } from "pg";
import type { LaunchSession } from "./types";

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

export function dbEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export async function initDb(): Promise<void> {
  const p = getPool();
  if (!p) {
    console.warn("[db] DATABASE_URL not set — sessions are in-memory only (lost on restart)");
    return;
  }
  await p.query(`
    CREATE TABLE IF NOT EXISTS pipeline_sessions (
      id TEXT PRIMARY KEY,
      brand_name TEXT,
      status TEXT NOT NULL,
      google_doc_url TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await p.query(
    `CREATE INDEX IF NOT EXISTS pipeline_sessions_created_idx ON pipeline_sessions (created_at DESC)`
  );
  console.log("[db] pipeline_sessions ready");

  const swept = await failStaleRunningSessions();
  if (swept) console.log(`[db] swept ${swept} stale running session(s) → failed`);
}

/**
 * On boot, any session still marked "running" is orphaned: this is a
 * single-instance service, so a fresh start means the process that was driving
 * that run is dead and nothing will re-drive it. Flip those to "failed" (and
 * mark their still-running steps failed) so the UI shows "Failed" instead of
 * spinning forever. Safe to call at startup only — before any new run begins.
 * Returns the number of sessions swept.
 */
export async function failStaleRunningSessions(): Promise<number> {
  const p = getPool();
  if (!p) return 0;
  const { rows } = await p.query(
    "SELECT data FROM pipeline_sessions WHERE status = 'running'"
  );
  let swept = 0;
  for (const row of rows) {
    const session = row.data as LaunchSession;
    session.status = "failed";
    session.updatedAt = new Date();
    for (const step of session.steps ?? []) {
      if (step.status === "running") {
        step.status = "failed";
        step.error = step.error ?? "Interrupted by a backend restart — please rerun.";
      }
    }
    const note = "Interrupted by a backend restart before finishing — please rerun.";
    session.outputs = session.outputs ?? {};
    session.outputs["_warnings"] = session.outputs["_warnings"]
      ? `${session.outputs["_warnings"]}, ${note}`
      : note;
    await saveSession(session);
    swept++;
  }
  return swept;
}

export async function saveSession(session: LaunchSession): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO pipeline_sessions (id, brand_name, status, google_doc_url, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE
       SET brand_name = EXCLUDED.brand_name,
           status = EXCLUDED.status,
           google_doc_url = EXCLUDED.google_doc_url,
           data = EXCLUDED.data,
           updated_at = now()`,
    [
      session.id,
      session.brandName ?? null,
      session.status,
      session.googleDocUrl ?? null,
      JSON.stringify(session),
      session.createdAt ?? new Date(),
    ]
  );
}

export async function loadSession(id: string): Promise<LaunchSession | undefined> {
  const p = getPool();
  if (!p) return undefined;
  const { rows } = await p.query("SELECT data FROM pipeline_sessions WHERE id = $1", [id]);
  return rows[0] ? (rows[0].data as LaunchSession) : undefined;
}

export async function loadAllSessions(limit = 50): Promise<LaunchSession[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    "SELECT data FROM pipeline_sessions ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return rows.map((r) => r.data as LaunchSession);
}
