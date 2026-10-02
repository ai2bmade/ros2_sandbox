// ROS2 Sandbox server: serves the built front end with COOP/COEP headers and provides the
// API for Google login, sign-up approval, per-user file storage and the admin page.
// User code never runs here; it runs in the learner's browser.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import { createDb } from './db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.DIST_DIR || path.resolve(HERE, '../dist');
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const DEV_LOGIN = !PROD && process.env.DEV_LOGIN === '1';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || '').split(/[\s,;]+/).map(normEmail).filter(Boolean));

const SESSION_DAYS = 30;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 200 * 1024;
const FILE_NAME = /^[\w.-]{1,64}$/;
const STATUSES = new Set(['new', 'pending', 'approved', 'rejected', 'suspended']);

function normEmail(e) { return String(e || '').trim().toLowerCase(); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

const db = await createDb();
const app = Fastify({ trustProxy: true, logger: { level: PROD ? 'info' : 'warn' }, bodyLimit: 4 * 1024 * 1024 });

await app.register(fastifyCookie);
await app.register(fastifyCompress, { global: true, threshold: 1024 });

// Python runs on SharedArrayBuffer, which the browser only allows on cross-origin isolated pages.
app.addHook('onSend', async (req, reply, payload) => {
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  return payload;
});

// ---- sessions ---------------------------------------------------------------

app.decorateRequest('user', null);
app.addHook('onRequest', async (req) => {
  const token = req.cookies.sid;
  if (!token) return;
  const { rows } = await db.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
  if (!rows[0]) return;
  req.user = rows[0];
  if (!req.user.last_seen_at || Date.now() - new Date(req.user.last_seen_at).getTime() > 5 * 60_000) {
    db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [req.user.id]).catch(() => {});
  }
});

const cookieOpts = (req, maxAge) => ({ path: '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge });

async function startSession(req, reply, userId) {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [sha256(token), userId, SESSION_DAYS, req.ip, clip(req.headers['user-agent'], 300)]);
  reply.setCookie('sid', token, cookieOpts(req, SESSION_DAYS * 86400));
}

// Find or create the user for a verified Google identity; ADMIN_EMAILS are always approved admins.
async function upsertGoogleUser({ sub, email, name }) {
  email = normEmail(email);
  let { rows } = await db.query('SELECT * FROM users WHERE google_sub = $1 OR email = $2 ORDER BY google_sub IS NULL LIMIT 1', [sub, email]);
  let user = rows[0];
  if (!user) {
    ({ rows } = await db.query('INSERT INTO users (email, google_sub, name) VALUES ($1, $2, $3) RETURNING *', [email, sub, clip(name, 50)]));
    user = rows[0];
  } else {
    ({ rows } = await db.query(
      'UPDATE users SET google_sub = $2, email = $3, name = COALESCE(name, $4) WHERE id = $1 RETURNING *',
      [user.id, sub, email, clip(name, 50)]));
    user = rows[0];
  }
  if (ADMIN_EMAILS.has(email) && (user.role !== 'admin' || user.status !== 'approved')) {
    ({ rows } = await db.query(
      `UPDATE users SET role = 'admin', status = 'approved', decided_at = COALESCE(decided_at, now()) WHERE id = $1 RETURNING *`, [user.id]));
    user = rows[0];
  }
  return user;
}

// ---- guards -----------------------------------------------------------------

function requireLogin(req, reply, done) {
  if (!req.user) return reply.code(401).send({ error: 'login_required' });
  done();
}
function requireApproved(req, reply, done) {
  if (!req.user) return reply.code(401).send({ error: 'login_required' });
  if (req.user.status !== 'approved') return reply.code(403).send({ error: 'not_approved', status: req.user.status });
  done();
}
function requireAdmin(req, reply, done) {
  if (!req.user) return reply.code(401).send({ error: 'login_required' });
  if (req.user.role !== 'admin' || req.user.status !== 'approved') return reply.code(403).send({ error: 'admin_only' });
  done();
}
// Same-origin check on state-changing requests (CSRF defence on top of SameSite=Lax cookies).
app.addHook('preHandler', async (req, reply) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && origin !== `${req.protocol}://${req.host}`) return reply.code(403).send({ error: 'bad_origin' });
});

// ---- Google login -----------------------------------------------------------

const redirectUri = (req) => `${req.protocol}://${req.host}/api/auth/google/callback`;

app.get('/api/auth/google', async (req, reply) => {
  if (!GOOGLE_CLIENT_ID) return reply.redirect('/welcome/?error=config');
  const state = randomToken();
  reply.setCookie('oauth_state', state, cookieOpts(req, 600));
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: redirectUri(req), response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account',
  });
  return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
});

app.get('/api/auth/google/callback', async (req, reply) => {
  const { code, state, error } = req.query;
  const expected = req.cookies.oauth_state;
  reply.clearCookie('oauth_state', { path: '/' });
  if (error) return reply.redirect('/welcome/?error=cancelled');
  if (!code || !state || !expected || state !== expected) return reply.redirect('/welcome/?error=state');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(req), grant_type: 'authorization_code',
      }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok || !tok.access_token) throw new Error(`token exchange failed: ${tok.error || tokenRes.status}`);
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } });
    const info = await infoRes.json();
    if (!infoRes.ok || !info.sub || !info.email) throw new Error('userinfo failed');
    if (!info.email_verified) return reply.redirect('/welcome/?error=unverified');
    const user = await upsertGoogleUser(info);
    await startSession(req, reply, user.id);
    return reply.redirect(user.status === 'approved' ? '/' : '/welcome/');
  } catch (e) {
    req.log.error(e);
    return reply.redirect('/welcome/?error=google');
  }
});

// Local development only: log in as any email without Google (DEV_LOGIN=1, never in production).
if (DEV_LOGIN) {
  app.get('/api/auth/dev', async (req, reply) => {
    const email = normEmail(req.query.email);
    if (!email) return reply.code(400).send({ error: 'email' });
    const user = await upsertGoogleUser({ sub: `dev:${email}`, email, name: email.split('@')[0] });
    await startSession(req, reply, user.id);
    return reply.redirect(user.status === 'approved' ? '/' : '/welcome/');
  });
}

app.post('/api/auth/logout', async (req, reply) => {
  if (req.cookies.sid) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(req.cookies.sid)]);
  reply.clearCookie('sid', { path: '/' });
  return { ok: true };
});

// ---- me + sign-up request ---------------------------------------------------

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, status: u.status, role: u.role,
  tag: u.tag, affiliation: u.affiliation, note: u.note, appliedAt: u.applied_at,
});

app.get('/api/me', { preHandler: requireLogin }, async (req) => ({ user: publicUser(req.user) }));

app.post('/api/apply', { preHandler: requireLogin }, async (req, reply) => {
  if (!['new', 'rejected'].includes(req.user.status)) return reply.code(409).send({ error: 'already', status: req.user.status });
  const b = req.body || {};
  const name = clip(b.name, 50);
  if (!name) return reply.code(400).send({ error: 'name_required' });
  const { rows } = await db.query(
    `UPDATE users SET name = $2, affiliation = $3, tag = $4, note = $5, status = 'pending', applied_at = now()
      WHERE id = $1 RETURNING *`,
    [req.user.id, name, clip(b.affiliation, 100), clip(b.tag, 30), clip(b.note, 500)]);
  return { user: publicUser(rows[0]) };
});

// ---- files (approved users) -------------------------------------------------

app.get('/api/files', { preHandler: requireApproved }, async (req) => {
  const { rows } = await db.query('SELECT name, content FROM files WHERE user_id = $1', [req.user.id]);
  return { files: Object.fromEntries(rows.map((r) => [r.name, r.content])) };
});

async function fileCount(userId) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM files WHERE user_id = $1', [userId]);
  return rows[0].n;
}

app.put('/api/files/:name', { preHandler: requireApproved }, async (req, reply) => {
  const { name } = req.params;
  const content = req.body?.content;
  if (!FILE_NAME.test(name)) return reply.code(400).send({ error: 'bad_name' });
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) return reply.code(413).send({ error: 'too_large' });
  const exists = await db.query('SELECT 1 FROM files WHERE user_id = $1 AND name = $2', [req.user.id, name]);
  if (!exists.rows[0] && await fileCount(req.user.id) >= MAX_FILES) return reply.code(409).send({ error: 'too_many_files' });
  await db.query(
    `INSERT INTO files (user_id, name, content) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
    [req.user.id, name, content]);
  return { ok: true };
});

app.delete('/api/files/:name', { preHandler: requireApproved }, async (req) => {
  await db.query('DELETE FROM files WHERE user_id = $1 AND name = $2', [req.user.id, req.params.name]);
  return { ok: true };
});

// First visit: seed the account with the examples (and any files left in this browser). Existing files win.
app.post('/api/files/seed', { preHandler: requireApproved }, async (req, reply) => {
  const files = req.body?.files;
  if (!files || typeof files !== 'object') return reply.code(400).send({ error: 'files' });
  let room = MAX_FILES - await fileCount(req.user.id);
  for (const [name, content] of Object.entries(files)) {
    if (room <= 0) break;
    if (!FILE_NAME.test(name) || typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) continue;
    const r = await db.query(
      'INSERT INTO files (user_id, name, content) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.user.id, name, content]);
    room -= r.rowCount ?? r.affectedRows ?? 0;
  }
  const { rows } = await db.query('SELECT name, content FROM files WHERE user_id = $1', [req.user.id]);
  return { files: Object.fromEntries(rows.map((r) => [r.name, r.content])) };
});

// ---- admin ------------------------------------------------------------------

app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
  const { rows } = await db.query(
    `SELECT u.*, (SELECT count(*)::int FROM files f WHERE f.user_id = u.id) AS file_count
       FROM users u
      ORDER BY (u.status = 'pending') DESC, COALESCE(u.applied_at, u.created_at) DESC`);
  return {
    users: rows.map((u) => ({
      ...publicUser(u), createdAt: u.created_at, decidedAt: u.decided_at, lastSeenAt: u.last_seen_at,
      fileCount: u.file_count, linked: !!u.google_sub,
    })),
  };
});

// Add emails to the allow list (approved before they ever log in).
app.post('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
  const emails = [...new Set(String(req.body?.emails || '').split(/[\s,;]+/).map(normEmail))]
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (!emails.length) return reply.code(400).send({ error: 'no_valid_emails' });
  const tag = clip(req.body?.tag, 30);
  for (const email of emails) {
    await db.query(
      `INSERT INTO users (email, status, tag, decided_at) VALUES ($1, 'approved', $2, now())
       ON CONFLICT (email) DO UPDATE SET status = 'approved', tag = COALESCE($2, users.tag), decided_at = now()`,
      [email, tag]);
  }
  return { added: emails.length };
});

app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params;
  const b = req.body || {};
  const self = id === req.user.id;
  const sets = [];
  const vals = [id];
  if (b.status !== undefined) {
    if (!STATUSES.has(b.status)) return reply.code(400).send({ error: 'bad_status' });
    if (self && b.status !== 'approved') return reply.code(400).send({ error: 'self' });
    vals.push(b.status); sets.push(`status = $${vals.length}`, 'decided_at = now()');
  }
  if (b.role !== undefined) {
    if (!['user', 'admin'].includes(b.role)) return reply.code(400).send({ error: 'bad_role' });
    if (self && b.role !== 'admin') return reply.code(400).send({ error: 'self' });
    vals.push(b.role); sets.push(`role = $${vals.length}`);
  }
  if (b.tag !== undefined) { vals.push(clip(b.tag, 30)); sets.push(`tag = $${vals.length}`); }
  if (!sets.length) return reply.code(400).send({ error: 'nothing' });
  const { rows } = await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
  if (['suspended', 'rejected'].includes(rows[0].status)) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  return { user: publicUser(rows[0]) };
});

app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
  if (req.params.id === req.user.id) return reply.code(400).send({ error: 'self' });
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  return { ok: true };
});

app.get('/api/health', async () => {
  await db.query('SELECT 1');
  return { ok: true };
});

// ---- pages ------------------------------------------------------------------

await app.register(fastifyStatic, {
  root: DIST,
  index: false,
  wildcard: true,
  setHeaders(reply, file) {
    if (file.includes(`${path.sep}assets${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    else if (file.includes(`${path.sep}pyodide${path.sep}`)) reply.header('Cache-Control', 'public, max-age=604800');
    else reply.header('Cache-Control', 'no-cache');
  },
});

const page = (reply, file) => reply.header('Cache-Control', 'no-cache').sendFile(file);
const approved = (u) => u && u.status === 'approved';

for (const p of ['/', '/index.html']) {
  app.get(p, (req, reply) => (approved(req.user) ? page(reply, 'index.html') : reply.redirect('/welcome/')));
}
for (const p of ['/welcome', '/welcome/']) {
  app.get(p, (req, reply) => (approved(req.user) ? reply.redirect('/') : page(reply, 'welcome/index.html')));
}
for (const p of ['/admin', '/admin/', '/admin/index.html']) {
  app.get(p, (req, reply) => (approved(req.user) && req.user.role === 'admin' ? page(reply, 'admin/index.html') : reply.redirect('/')));
}
for (const p of ['/privacy', '/privacy/']) app.get(p, (req, reply) => page(reply, 'privacy/index.html'));

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
  return reply.redirect('/');
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`ROS2 Sandbox server on :${PORT} (${PROD ? 'production' : 'development'}${DEV_LOGIN ? ', DEV_LOGIN on' : ''})`);
