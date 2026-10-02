// Database access. Production uses PostgreSQL via DATABASE_URL; local development without one
// falls back to PGlite (an in-process PostgreSQL build) stored in server/.pglite.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email        text NOT NULL UNIQUE,
    google_sub   text UNIQUE,
    name         text,
    status       text NOT NULL DEFAULT 'new',   -- new | pending | approved | rejected | suspended
    role         text NOT NULL DEFAULT 'user',  -- user | admin
    tag          text,                          -- 학생, 강사, 유료 ... (free text chosen by the admin)
    affiliation  text,
    note         text,
    applied_at   timestamptz,
    decided_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    ip         text,
    user_agent text
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS files (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       text NOT NULL,
    content    text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, name)
  )`,
];

export async function createDb() {
  let query;
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    query = (text, params) => pool.query(text, params);
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is not set');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { fileURLToPath } = await import('node:url');
    const lite = new PGlite(process.env.PGLITE_DIR || fileURLToPath(new URL('./.pglite', import.meta.url)));
    query = (text, params) => lite.query(text, params);
  }
  for (const stmt of SCHEMA) await query(stmt);
  return { query };
}
