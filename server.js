'use strict';
/* CyburrHunee server: one small Postgres pool, JSON file only as local fallback.
   Plain Node built-ins plus pg: no framework, no calls out except verification email
   and one ethical, cached Wikipedia lookup for general questions.
   Local dev binds 127.0.0.1 only. Render sets NODE_ENV=production/PORT, then we
   bind 0.0.0.0 so Render's HTTPS proxy can reach us. No hardcoded host in the app. */

/* Render terminates TLS for us. On a bare VPS you must put this behind HTTPS
   with a real certificate; never expose plain http to the internet. */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const URL = require('url').URL;

/* Phase 2 email. The key is read from the process environment or a local .env
   file. It is never sent to the browser and never written to a log. */
function loadEnvFile(){
  try{
    const text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    text.split(/\r?\n/).forEach(function(line){
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) return;
      let value = m[2].trim();
      if ((value[0] === '"' && value[value.length - 1] === '"') ||
          (value[0] === "'" && value[value.length - 1] === "'")) value = value.slice(1, -1);
      process.env[m[1]] = value;
    });
  }catch(e){ /* a missing .env file is fine: email setup just reports "not set up" */ }
}
loadEnvFile();

const RESEND_KEY = String(process.env.RESEND_API_KEY || '').trim();
/* onboarding@resend.dev is Resend's allowed test sender until a domain is verified.
   Set RESEND_FROM in .env to use a verified sender such as hello@cyburrhunee.com. */
const EMAIL_FROM = String(process.env.RESEND_FROM || 'CyburrHunee <onboarding@resend.dev>').trim();
const RESEND_URL = String(process.env.RESEND_API_URL || 'https://api.resend.com/emails');
const EMAIL_SETUP_ERROR = 'Email sending is not set up yet, ask Scarlet to add the email key.';
const TOO_MANY_CODES = 'Too many codes sent, wait an hour and try again';

/* Public Wikipedia API: no key. One request at a time, one-hour cache, fixed host. */
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_UA = 'CyburrHunee/0.3 (ethical general-question lookup; local app)';
const WIKI_CACHE_MS = 60 * 60 * 1000;
const wikiCache = new Map();
let wikiQueue = Promise.resolve();

const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const HOST = PRODUCTION ? '0.0.0.0' : '127.0.0.1';
const PORT = Number(process.env.PORT) || 8000;

/* Only these exact paths exist — no directory listing, no source or data files. */
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/trustworthy-helper.html': { file: 'trustworthy-helper.html', type: 'text/html; charset=utf-8' },
  '/assets/bork.webp': { file: 'assets/bork.webp', type: 'image/webp' },
  '/assets/bork-emoji-happy.png': { file: 'assets/bork-emoji-happy.png', type: 'image/png' },
  '/assets/bork-emoji-love.png': { file: 'assets/bork-emoji-love.png', type: 'image/png' },
  '/assets/bork-emoji-sleepy.png': { file: 'assets/bork-emoji-sleepy.png', type: 'image/png' },
  '/assets/bork-emoji-laugh.png': { file: 'assets/bork-emoji-laugh.png', type: 'image/png' },
  '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json' },
  '/sw.js': { file: 'sw.js', type: 'application/javascript; charset=utf-8' }
};
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'cyburrhunee.json');
const MAX_REQUESTS = 100;
const WINDOW_MS = 60 * 1000;
const CODE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_REMEMBER_MS = 90 * DAY_MS;   // Remember me on
const SESSION_SHORT_MS = 7 * DAY_MS;       // Remember me off
const SESSION_SAVE_THRESHOLD_MS = 60 * 1000; // avoid a database write on every request
const MAX_BODY = 64 * 1024;
const MAX_ROYALTY_RECORDS = 200;

/* The app is one HTML file with inline scripts and onclick handlers, so script-src
   needs 'unsafe-inline'. It still cannot load any external script, font or tracker. */
const BASE_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store'
};

const visitors = new Map(); // IP -> { count, reset }
const emailSends = new Map(); // email hash -> { count, reset }
const signupAttempts = new Map(); // IP -> { count, reset }
const pendingEmails = new Map(); // username -> { email, expires } — memory only, deleted on verify
const HOUR_MS = 60 * 60 * 1000;

function clientIP(req){
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}
function hourlyRecord(map, k){
  const now = Date.now();
  let r = map.get(k);
  if (!r || now >= r.reset){ r = { count: 0, reset: now + HOUR_MS }; map.set(k, r); }
  return r;
}

/* One small HTTPS POST to Resend. No library, no key in the body, no logging. */
function sendCodeEmail(email, code){
  return new Promise(function(resolve){
    if (!RESEND_KEY) return resolve(false);
    let url;
    try{ url = new URL(RESEND_URL); }catch(e){ return resolve(false); }
    const payload = JSON.stringify({
      from: EMAIL_FROM,
      to: email,
      subject: 'Your CyburrHunee verification code',
      text: 'Hi, your CyburrHunee code is ' + code + '. It expires in 10 minutes. ' +
            'If you did not ask for this, ignore this email. We do not save your email after verification.'
    });
    const transport = url.protocol === 'http:' ? http : https;
    const out = transport.request({
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res){
      let size = 0;
      res.on('data', function(chunk){ size += chunk.length; if (size > 4096) res.destroy(); });
      res.on('end', function(){ resolve(res.statusCode >= 200 && res.statusCode < 300); });
    });
    out.setTimeout(10000, function(){ out.destroy(); });
    out.on('error', function(){ resolve(false); });
    out.write(payload);
    out.end();
  });
}

/* ---------- storage: Postgres when configured, JSON file as local fallback ---------- */
function emptyDB(){ return { users: {}, sessions: {}, meta: {} }; }
function loadDB(){
  try{
    const o = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (o && o.users && typeof o.users === 'object'){
      if (!o.sessions || typeof o.sessions !== 'object' || Array.isArray(o.sessions)) o.sessions = {};
      if (!o.meta || typeof o.meta !== 'object' || Array.isArray(o.meta)) o.meta = {};
      return o;
    }
  }catch(e){ /* a missing or damaged file starts empty; never crash the local app */ }
  return emptyDB();
}
let db = emptyDB();
let pool = null;
const jsonDB = loadDB();
/* Smallest schema that still runs every existing feature. users.username and
   sessions.token_hash are primary keys, so those are the only two indexes.
   Values are always passed as parameters; pg sends them as prepared statements. */
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS users (
     username TEXT PRIMARY KEY,
     password_hash TEXT NOT NULL,
     email_hash TEXT,
     created_at BIGINT NOT NULL,
     extra JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE TABLE IF NOT EXISTS training (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     confidence TEXT,
     source TEXT,
     created_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
     expires_at BIGINT NOT NULL,
     remember_me BOOLEAN NOT NULL DEFAULT false
   )`
];
const INSERT_USER_SQL = `INSERT INTO users (username,password_hash,email_hash,created_at,extra)
   VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING RETURNING username`;
const UPSERT_USER_SQL = `INSERT INTO users (username,password_hash,email_hash,created_at,extra)
   VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO UPDATE SET
   password_hash=EXCLUDED.password_hash, email_hash=EXCLUDED.email_hash,
   created_at=EXCLUDED.created_at, extra=EXCLUDED.extra`;
const INSERT_TRAINING_SQL = `INSERT INTO training (id,username,kind,text,confidence,source,created_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`;
const DELETE_TRAINING_SQL = `DELETE FROM training WHERE id=$1 AND username=$2`;
const CLEAR_TRAINING_SQL = `WITH removed AS (DELETE FROM training WHERE username=$1)
   UPDATE users SET extra=$2 WHERE username=$1`;
const INSERT_SESSION_SQL = `INSERT INTO sessions (token_hash,username,expires_at,remember_me)
   VALUES ($1,$2,$3,$4) ON CONFLICT (token_hash) DO NOTHING`;
const DELETE_SESSION_SQL = `DELETE FROM sessions WHERE token_hash=$1`;
const SESSION_CHECK_SQL = `UPDATE sessions SET expires_at=GREATEST(expires_at,$2)
   WHERE token_hash=$1 AND expires_at>$3 RETURNING username,expires_at,remember_me`;
/* One-time JSON import: only runs while the target table is still empty. */
const MIGRATE_USERS_SQL = `INSERT INTO users (username,password_hash,email_hash,created_at,extra)
   SELECT u.username,u.password_hash,u.email_hash,u.created_at,u.extra
   FROM jsonb_to_recordset($1::jsonb) AS u(username text,password_hash text,email_hash text,created_at bigint,extra jsonb)
   WHERE NOT EXISTS (SELECT 1 FROM users) ON CONFLICT (username) DO NOTHING`;
const MIGRATE_TRAINING_SQL = `INSERT INTO training (id,username,kind,text,confidence,source,created_at)
   SELECT t.id,t.username,t.kind,t.text,t.confidence,t.source,t.created_at
   FROM jsonb_to_recordset($1::jsonb) AS t(id text,username text,kind text,text text,confidence text,source text,created_at bigint)
   WHERE NOT EXISTS (SELECT 1 FROM training) ON CONFLICT (id) DO NOTHING`;
const MIGRATE_SESSIONS_SQL = `INSERT INTO sessions (token_hash,username,expires_at,remember_me)
   SELECT s.token_hash,s.username,s.expires_at,s.remember_me
   FROM jsonb_to_recordset($1::jsonb) AS s(token_hash text,username text,expires_at bigint,remember_me boolean)
   WHERE NOT EXISTS (SELECT 1 FROM sessions) ON CONFLICT (token_hash) DO NOTHING`;
/* Feature fields that do not need their own column live in one JSONB value. */
function extraFor(u){
  return {
    verified: !!u.verified, code: u.code || null, optins: u.optins || {}, votes: u.votes || {},
    model: u.model == null ? null : u.model, trainingText: u.trainingText || null,
    dataset: u.dataset || null, optedInSongs: u.optedInSongs || [],
    royalties: Array.isArray(u.royalties) ? u.royalties.slice(-MAX_ROYALTY_RECORDS) : []
  };
}
function userParams(u){
  const created = Date.parse(u.created);
  return [key(u.username), String(u.passwordHash || ''), u.emailHash || null,
    Number.isFinite(created) ? created : Date.now(), JSON.stringify(extraFor(u))];
}
function rowToUser(r){
  const e = (r.extra && typeof r.extra === 'object') ? r.extra : {};
  return {
    username: r.username, passwordHash: r.password_hash, emailHash: r.email_hash || undefined,
    created: new Date(Number(r.created_at)).toISOString(), verified: !!e.verified,
    code: e.code || null, optins: e.optins || {}, votes: e.votes || {},
    model: e.model == null ? null : e.model, trainingText: e.trainingText || null,
    dataset: e.dataset || null, optedInSongs: e.optedInSongs || [],
    royalties: Array.isArray(e.royalties) ? e.royalties : [], learning: []
  };
}
function sessionParams(s){ return [s.tokenHash || s.hash, s.username, s.expires, !!s.remember]; }
function itemParams(item, username){
  const date = Date.parse(item.date);
  return [String(item.id), username, String(item.kind || 'Accepted'), String(item.text || '').slice(0, 4000),
    String(item.confidence || ''), String(item.source || ''), Number.isFinite(date) ? date : Date.now()];
}
function rowToItem(r){
  return { id: r.id, kind: r.kind, text: r.text, confidence: r.confidence || '', source: r.source || '',
    date: new Date(Number(r.created_at)).toISOString() };
}
function rowToSession(r){
  return { hash: r.token_hash, tokenHash: r.token_hash, username: r.username,
    created: Date.now(), expires: Number(r.expires_at), remember: !!r.remember_me };
}
async function q(sql, params){
  if (!pool) return null;
  try{ return await pool.query(sql, params); }
  catch(e){ console.error('[error] Postgres query failed'); return null; }
}
async function saveUser(u){ await q(UPSERT_USER_SQL, userParams(u)); }
async function saveSession(s){
  /* A session must really be in Postgres before we tell the browser it logged in.
     One retry covers a brief connection hiccup; a second failure is logged. */
  let r = await q(INSERT_SESSION_SQL, sessionParams(s));
  if (pool && !r) r = await q(INSERT_SESSION_SQL, sessionParams(s));
  if (pool && !r) console.error('[error] session could not be saved to Postgres');
}
function saveJSON(){
  try{
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
  }catch(e){
    console.error('[error] could not save local database');
  }
}
async function migrateJSON(){
  const legacyUsers = Object.keys(jsonDB.users || {});
  const users = legacyUsers.map(function(k){
    const u = jsonDB.users[k];
    return { username: u.username || k, password_hash: String(u.passwordHash || ''),
      email_hash: u.emailHash || null, created_at: Date.parse(u.created) || Date.now(),
      extra: JSON.stringify(extraFor(u)) };
  });
  if (users.length) await q(MIGRATE_USERS_SQL, [JSON.stringify(users)]);
  const training = [];
  legacyUsers.forEach(function(k){
    const u = jsonDB.users[k];
    (u.learning || []).forEach(function(it){
      training.push({ id: String(it.id), username: key(u.username || k), kind: String(it.kind || 'Accepted'),
        text: String(it.text || ''), confidence: String(it.confidence || ''),
        source: String(it.source || ''), created_at: Date.parse(it.date) || Date.now() });
    });
  });
  if (training.length) await q(MIGRATE_TRAINING_SQL, [JSON.stringify(training)]);
  const sessions = Object.keys(jsonDB.sessions || {}).map(function(h){
    const s = jsonDB.sessions[h];
    return { token_hash: h, username: s.username, expires_at: Number(s.expires) || 0, remember_me: !!s.remember };
  }).filter(function(s){ return s.username && s.expires_at > 0; });
  if (sessions.length) await q(MIGRATE_SESSIONS_SQL, [JSON.stringify(sessions)]);
}
async function loadPostgres(){
  const out = emptyDB();
  const users = await q('SELECT username,password_hash,email_hash,created_at,extra FROM users');
  for (const r of (users && users.rows) || []) out.users[key(r.username)] = rowToUser(r);
  const training = await q('SELECT id,username,kind,text,confidence,source,created_at FROM training');
  for (const r of (training && training.rows) || []){
    const u = out.users[key(r.username)];
    if (u) u.learning.push(rowToItem(r));
  }
  const sessions = await q('SELECT token_hash,username,expires_at,remember_me FROM sessions');
  for (const r of (sessions && sessions.rows) || []) out.sessions[r.token_hash] = rowToSession(r);
  await migrateJSON();
  /* Make records imported on this first boot visible without another query. */
  for (const k of Object.keys(jsonDB.users || {})){
    if (!out.users[k]) out.users[k] = JSON.parse(JSON.stringify(jsonDB.users[k]));
  }
  for (const k of Object.keys(jsonDB.users || {})){
    const u = out.users[k];
    if (u && !u.learning.length && (jsonDB.users[k].learning || []).length){
      u.learning = JSON.parse(JSON.stringify(jsonDB.users[k].learning));
    }
  }
  for (const h of Object.keys(jsonDB.sessions || {})){
    if (!out.sessions[h]) out.sessions[h] = JSON.parse(JSON.stringify(jsonDB.sessions[h]));
  }
  return out;
}
async function initStorage(){
  const url = process.env.DATABASE_URL;
  if (!url){ console.log('Using local JSON database, Postgres not set'); db = jsonDB; }
  else try{
    const pg = require('pg');
    /* One reused pool only. Two connections are enough for this app; idle
       connections close in 10s so Neon can scale down, and connect waits 5s. */
    pool = new pg.Pool({
      connectionString: url,
      ssl: PRODUCTION ? { rejectUnauthorized: false } : false,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000
    });
    for (const sql of SCHEMA_SQL) await pool.query(sql);
    db = await loadPostgres();
    console.log('Using Postgres database');
  }catch(e){
    pool = null;
    /* On Render the JSON file is ephemeral. Falling back to it would lose
       accounts and sessions on every restart, so fail startup instead. */
    if (PRODUCTION) throw e;
    db = jsonDB;
    console.error('[error] Postgres unavailable; using local JSON database');
  }
  /* Boot id is only used to explain a stale session; it is not a credential. */
  db.meta.bootId = crypto.randomBytes(8).toString('hex');
  db.meta.bootAt = Date.now();
}
const storageReady = initStorage();
function key(name){ return String(name || '').trim().toLowerCase(); }
function hashEmail(email){
  return crypto.createHash('sha256').update('cyburrhunee-email:' + String(email).trim().toLowerCase()).digest('hex');
}
function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function checkPassword(password, stored){
  try{
    const parts = String(stored).split(':');
    if (parts.length !== 2) return false;
    const want = Buffer.from(parts[1], 'hex');
    const got = crypto.scryptSync(String(password), parts[0], want.length);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }catch(e){ return false; }
}
function hashCode(username, code){
  return crypto.createHash('sha256').update('cyburrhunee-code:' + key(username) + ':' + String(code)).digest('hex');
}
function newCode(){
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashToken(token){
  return crypto.createHash('sha256').update('cyburrhunee-session:' + String(token)).digest('hex');
}
function sessionLifetime(remember){ return remember ? SESSION_REMEMBER_MS : SESSION_SHORT_MS; }
function sessionMeta(s){
  return { expires: s.expires, remember: !!s.remember, bootId: db.meta.bootId };
}
let activeSession = null;
let lastSessionEndReason = '';
/* Session checks are cached per token for 60s. Postgres is touched only when
   that cache expires, or on login/logout; page loads do not refresh expiry.
   A failed Postgres check is not a logout: we keep the last known session. */
const SESSION_CACHE_MS = 60 * 1000;
const sessionCache = new Map(); // tokenHash -> { rec, checked }
function cacheSession(rec){ sessionCache.set(rec.tokenHash, { rec: rec, checked: Date.now() }); }
function uncacheSession(h){ sessionCache.delete(h); }
function logSessionEnd(reason){
  /* Reason only — never a token, password, code or email. */
  console.info('[session] ended: ' + reason);
}
async function makeSession(user, remember){
  const token = crypto.randomBytes(24).toString('hex');
  const h = hashToken(token);
  const now = Date.now();
  const rec = {
    username: key(user.username),
    tokenHash: h,
    created: now,
    expires: now + sessionLifetime(!!remember),
    remember: !!remember
  };
  db.sessions[h] = rec;
  await saveSession(rec);
  cacheSession(rec);
  activeSession = rec;
  return { token: token, meta: sessionMeta(rec) };
}
async function userFor(req, body, activity){
  const h = req.headers.authorization || '';
  const token = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : (body && body.token) || '';
  activeSession = null;
  lastSessionEndReason = '';
  if (!token) return null;
  const hash = hashToken(token);
  let s = null;
  const cached = sessionCache.get(hash);
  if (cached && Date.now() - cached.checked < SESSION_CACHE_MS) s = cached.rec;
  else if (pool){
    /* One query: refresh the sliding expiry only when real activity moved it. */
    const minExpiry = cached ? Number(cached.rec.expires) || 0 : 0;
    const r = await q(SESSION_CHECK_SQL, [hash, minExpiry, Date.now()]);
    if (r && r.rows && r.rows.length){
      s = rowToSession({ token_hash: hash, username: r.rows[0].username,
        expires_at: r.rows[0].expires_at, remember_me: r.rows[0].remember_me });
      db.sessions[hash] = s;
      cacheSession(s);
    }else if (r === null){
      /* q() returns null only when the query failed. One failed request must
         never clear a login: keep the cached/boot-loaded session for now. */
      s = cached ? cached.rec : db.sessions[hash] || null;
      if (s) cacheSession(s);
    }else{
      uncacheSession(hash);
      delete db.sessions[hash];
    }
  }else{
    s = db.sessions[hash] || null;
    if (s) cacheSession(s);
  }
  if (!s){
    const sentBoot = String(req.headers['x-session-boot'] || (body && body.bootId) || '');
    lastSessionEndReason = (sentBoot && db.meta.bootId && sentBoot !== db.meta.bootId) ? 'server restarted' : 'invalid';
    logSessionEnd(lastSessionEndReason);
    return null;
  }
  if (Date.now() >= s.expires){
    uncacheSession(hash);
    delete db.sessions[hash];
    lastSessionEndReason = 'expired';
    logSessionEnd(lastSessionEndReason);
    return null;
  }
  /* Sliding expiry moves in memory on activity; the next cache-expiry query
     persists it, so page loads never write to the database. */
  if (activity){
    const next = Date.now() + sessionLifetime(s.remember);
    if (next - s.expires >= SESSION_SAVE_THRESHOLD_MS) s.expires = next;
  }
  activeSession = s;
  return db.users[s.username] || null;
}
function publicUser(user){
  const out = { ok: true, username: user.username, optins: user.optins || {} };
  if (activeSession) Object.assign(out, sessionMeta(activeSession));
  return out;
}

/* ---------- responses ---------- */
function send(req, res, status, body, type){
  const text = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const headers = Object.assign({}, BASE_HEADERS, {
    'Content-Type': type,
    'Content-Length': text.length
  });
  // Only add HSTS when HTTPS is really in use (Render forwards the original
  // protocol in X-Forwarded-Proto). Plain http localhost must not send it.
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (req.socket.encrypted || forwarded === 'https') headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  res.writeHead(status, headers);
  res.end(text);
}
function json(req, res, status, obj){
  send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}
function readBody(req, cb){
  let size = 0;
  const chunks = [];
  req.on('data', function(chunk){
    size += chunk.length;
    if (size > MAX_BODY){ cb(null); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', function(){
    if (!chunks.length) return cb({});
    try{ cb(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch(e){ cb(null); }
  });
  req.on('error', function(){ cb(null); });
}

/* ---------- API ---------- */
async function resendCode(req, res, body){
  if (!RESEND_KEY) return json(req, res, 503, { ok: false, error: EMAIL_SETUP_ERROR });
  const k = key(body.username), user = db.users[k];
  if (!user || user.verified) return json(req, res, 200, { ok: true, message: 'If that account needs a code, it was emailed.' });
  const pending = pendingEmails.get(k);
  if (!pending || Date.now() >= pending.expires){
    return json(req, res, 400, { ok: false, error: 'Please sign up again to get a new code.' });
  }
  const emailHash = user.emailHash || hashEmail(pending.email);
  const limit = hourlyRecord(emailSends, emailHash);
  if (limit.count >= 3) return json(req, res, 429, { ok: false, error: TOO_MANY_CODES });
  const code = newCode();
  let sent = false;
  try{ sent = await sendCodeEmail(pending.email, code); }catch(e){ sent = false; }
  if (!sent) return json(req, res, 502, { ok: false, error: 'I could not send the email right now. Please try again in a minute.' });
  user.code = { hash: hashCode(k, code), expires: Date.now() + CODE_MS, tries: 0 };
  await saveUser(user);
  limit.count += 1;
  console.log('Code sent to ' + emailHash + ', expires in 10 minutes');
  return json(req, res, 200, { ok: true, message: 'We sent a new 6-digit code to your email. Enter it below. It expires in 10 minutes.' });
}

const KNOWN_OPTINS = ['learnMusic','learnCode','learnText','learnEdits','learnRejections','rememberStyle','useWikipedia','learnWikipedia'];
function cleanOptins(input){
  const out = {};
  KNOWN_OPTINS.forEach(function(k){
    /* Wikipedia lookup is on by default; an explicit false turns it off. */
    out[k] = input && typeof input[k] === 'boolean' ? input[k] : (k === 'useWikipedia');
  });
  return out;
}
/* Royalty ledger seam for a future paid training run. Only work the owner
   explicitly opted into can be recorded; the ledger keeps an item id, kind,
   username, date and run id — never the work's text and never an amount. */
const ROYALTY_OPTINS = ['learnMusic','learnCode','learnText','learnEdits','learnRejections','learnWikipedia'];
function royaltyOptinFor(user, item, requested){
  if (ROYALTY_OPTINS.indexOf(requested) >= 0) return user.optins[requested] ? requested : null;
  const fallback = item.kind === 'Rejected' ? 'learnRejections'
    : item.kind === 'Remembered' ? 'learnText'
    : item.kind === 'Edit' ? 'learnEdits' : 'learnText';
  return user.optins[fallback] ? fallback : null;
}
function wikiKey(raw){
  return String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
}
function wikiOnce(url){
  const run = wikiQueue.then(function(){
    const ctl = new AbortController();
    const timer = setTimeout(function(){ ctl.abort(); }, 8000);
    return fetch(url, { headers: { 'User-Agent': WIKI_UA }, signal: ctl.signal })
      .finally(function(){ clearTimeout(timer); });
  });
  wikiQueue = run.catch(function(){});
  return run;
}
async function lookupWikipedia(rawQ){
  const topic = wikiKey(rawQ);
  if (!topic) return { ok: true, found: false };
  const hit = wikiCache.get(topic);
  if (hit && Date.now() - hit.at < WIKI_CACHE_MS) return hit.data;
  const u = new URL(WIKI_API);
  u.searchParams.set('action', 'query');
  u.searchParams.set('generator', 'search');
  u.searchParams.set('gsrsearch', topic);
  u.searchParams.set('gsrnamespace', '0');
  u.searchParams.set('gsrlimit', '1');
  u.searchParams.set('prop', 'extracts');
  u.searchParams.set('explaintext', '1');
  u.searchParams.set('exintro', '1');
  u.searchParams.set('exsentences', '4');
  u.searchParams.set('redirects', '1');
  u.searchParams.set('format', 'json');
  u.searchParams.set('formatversion', '2');
  let result;
  try{
    const r = await wikiOnce(u.toString());
    if (!r.ok) throw new Error('Wikipedia returned ' + r.status);
    result = await r.json();
  }catch(e){
    return { ok: false, found: false, error: 'Wikipedia is not reachable right now.' };
  }
  const page = result && result.query && result.query.pages && result.query.pages[0];
  const title = page && page.title ? String(page.title) : '';
  const extract = page && page.extract ? String(page.extract).replace(/\s+/g, ' ').trim().slice(0, 1800) : '';
  const data = (title && extract)
    ? { ok: true, found: true, title: title, extract: extract,
        url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')) }
    : { ok: true, found: false };
  wikiCache.set(topic, { at: Date.now(), data: data });
  return data;
}
/* Idea votes: +1 up, -1 down, 0 cleared. Votes are keyed by idea id, so one
   card's vote never changes another. Confidence moves 10 from the card's
   starting value and returns to that value when the vote is cleared. */
async function recordVote(req, res, body, expected, user){
  const ideaId=String(body.ideaId||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);
  const vote=Number(body.vote);
  if(!ideaId||vote!==expected) return json(req,res,400,{ok:false,error:'That vote was not valid.'});
  const base=Math.max(0,Math.min(100,Number(body.baseConfidence)||50));
  if(!user.votes||typeof user.votes!=='object') user.votes={};
  const prev=user.votes[ideaId]||{};
  const baseConfidence=Number.isFinite(prev.baseConfidence)?prev.baseConfidence:base;
  const confidence=Math.max(0,Math.min(100,baseConfidence+vote*10));
  user.votes[ideaId]={vote:vote,baseConfidence:baseConfidence,confidence:confidence,date:new Date().toISOString()};
  await saveUser(user);
  return json(req,res,200,{ok:true,ideaId:ideaId,vote:vote,confidence:confidence});
}
function api(req, res, pathname, method){
  let body;
  readBody(req, async function(parsed){
    body = parsed || {};
    if (parsed === null) return json(req, res, 400, { ok: false, error: 'Bad request' });

    /* --- public endpoints --- */
    if (pathname === '/api/signup' && method === 'POST'){
      const attempt = hourlyRecord(signupAttempts, 'ip:' + clientIP(req));
      attempt.count += 1;
      if (attempt.count > 5) return json(req, res, 429, { ok: false, error: TOO_MANY_CODES });
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const email = String(body.email || '').trim();
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return json(req, res, 400, { ok: false, error: 'Use 3-32 letters, numbers, dot, dash or underscore for your username.' });
      if (password.length < 8) return json(req, res, 400, { ok: false, error: 'Password must be at least 8 characters.' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(req, res, 400, { ok: false, error: 'Please enter a valid email for verification.' });
      if (!RESEND_KEY) return json(req, res, 503, { ok: false, error: EMAIL_SETUP_ERROR });
      const k = key(username);
      if (db.users[k]) return json(req, res, 409, { ok: false, error: 'That username is already taken.' });
      const emailHash = hashEmail(email);
      const limit = hourlyRecord(emailSends, emailHash);
      if (limit.count >= 3) return json(req, res, 429, { ok: false, error: TOO_MANY_CODES });
      const code = newCode();
      const user = {
        username: username,
        passwordHash: hashPassword(password),
        emailHash: emailHash,
        created: new Date().toISOString(),
        verified: false,
        optins: cleanOptins(body.optins),
        code: { hash: hashCode(k, code), expires: Date.now() + CODE_MS, tries: 0 },
        learning: [],
        votes: {},
        model: null
      };
      let sent = false;
      try{ sent = await sendCodeEmail(email, code); }catch(e){ sent = false; }
      if (!sent) return json(req, res, 502, { ok: false, error: 'I could not send the email right now. Please try again in a minute.' });
      const inserted = await q(INSERT_USER_SQL, userParams(user));
      if (pool && !inserted){
        return json(req, res, 503, { ok: false, error: 'I could not save your account right now. Please try again in a minute.' });
      }
      if (pool && inserted && (!inserted.rows || !inserted.rows.length)){
        return json(req, res, 409, { ok: false, error: 'That username is already taken.' });
      }
      db.users[k] = user;
      limit.count += 1;
      pendingEmails.set(k, { email: email, expires: Date.now() + HOUR_MS });
      console.log('Code sent to ' + emailHash + ', expires in 10 minutes');
      return json(req, res, 200, { ok: true, message: 'We sent a 6-digit code to your email. Enter it below. It expires in 10 minutes.' });
    }

    if ((pathname === '/api/send-code' || pathname === '/api/resend-code') && method === 'POST'){
      return resendCode(req, res, body);
    }

    if (pathname === '/api/verify-code' && method === 'POST'){
      const k = key(body.username);
      const user = db.users[k];
      if (!user || !user.code || user.verified) return json(req, res, 401, { ok: false, error: 'Ask for a new code first.' });
      if (Date.now() > user.code.expires){
        user.code = null; await saveUser(user);
        return json(req, res, 401, { ok: false, error: 'That code expired. Ask for a new code.' });
      }
      if (String(body.code || '').trim() !== '' && hashCode(k, String(body.code).trim()) === user.code.hash){
        user.verified = true;
        user.code = null;
        pendingEmails.delete(k); // plain email exists only in memory until this moment
        await saveUser(user);
        const made = await makeSession(user, body.remember);
        return json(req, res, 200, Object.assign(publicUser(user), { token: made.token }));
      }
      user.code.tries += 1;
      if (user.code.tries >= 3){
        user.code = null; await saveUser(user);
        return json(req, res, 401, { ok: false, error: '3 tries used. Ask for a new code.', triesLeft: 0 });
      }
      await saveUser(user);
      return json(req, res, 401, { ok: false, error: 'That code did not match.', triesLeft: 3 - user.code.tries });
    }

    if (pathname === '/api/login' && method === 'POST'){
      const user = db.users[key(body.username)];
      if (!user || !checkPassword(body.password, user.passwordHash)){
        return json(req, res, 401, { ok: false, error: 'That username or password did not match' });
      }
      if (!user.verified) return json(req, res, 401, { ok: false, error: 'Please verify your account first. Check your email for the code.' });
      const made = await makeSession(user, body.remember);
      return json(req, res, 200, Object.assign(publicUser(user), { token: made.token }));
    }

    /* Ethical Wikipedia lookup: fixed public API host, no key, no user URL.
       Placed before the session gate so a plain general question works too. */
    if (pathname === '/api/wikipedia' && method === 'GET'){
      const full = new URL(req.url || '/', 'http://localhost');
      return json(req, res, 200, await lookupWikipedia(full.searchParams.get('q')));
    }

    /* --- every endpoint below needs the session token --- */
    const user = await userFor(req, body, method !== 'GET');
    if (!user) return json(req, res, 401, { ok: false, error: 'Please log in first.', reason: lastSessionEndReason || 'invalid' });

    if (pathname === '/api/session' && method === 'GET'){
      return json(req, res, 200, Object.assign(publicUser(user), { online: true }));
    }
    if (pathname === '/api/logout' && method === 'POST'){
      const h = req.headers.authorization || '';
      const token = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : (body.token || '');
      if (token){
        const h = hashToken(token);
        delete db.sessions[h];
        uncacheSession(h);
        await q(DELETE_SESSION_SQL, [h]);
      }
      return json(req, res, 200, { ok: true });
    }
    if (pathname === '/api/optins' && method === 'POST'){
      user.optins = cleanOptins(body.optins);
      await saveUser(user);
      return json(req, res, 200, publicUser(user));
    }
    /* Each direction has its own path, and the body must carry the matching
       vote. Down sends -1 and stores -1 with a lower confidence. */
    if ((pathname === '/api/upvote' || pathname === '/api/downvote' || pathname === '/api/unvote') && method === 'POST'){
      const expected = pathname === '/api/upvote' ? 1 : pathname === '/api/downvote' ? -1 : 0;
      return recordVote(req, res, body, expected, user);
    }
    if (pathname === '/api/learn' && method === 'POST'){
      const kind = ['Accepted','Rejected','Remembered','Edit'].indexOf(body.kind) >= 0 ? body.kind : 'Accepted';
      const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (!text) return json(req, res, 400, { ok: false, error: 'Nothing to save.' });
      let allowed = false;
      if (kind === 'Rejected') allowed = !!user.optins.learnRejections;
      else if (kind === 'Remembered') allowed = !!user.optins.learnText;
      else if (kind === 'Edit') allowed = !!user.optins.learnEdits;
      else allowed = !!(body.optin === 'learnCode' ? user.optins.learnCode
        : body.optin === 'learnMusic' ? user.optins.learnMusic
        : body.optin === 'learnWikipedia' ? user.optins.learnWikipedia
        : user.optins.learnText);
      if (!allowed) return json(req, res, 403, { ok: false, error: 'That learning switch is off — nothing saved.' });
      /* Remember this: one copy of a given idea, even on a double click or reload. */
      if (kind === 'Remembered'){
        const existing = (user.learning || []).filter(function(it){ return it.kind === 'Remembered' && it.text === text; })[0];
        if (existing) return json(req, res, 200, { ok: true, item: existing, duplicate: true });
      }
      const item = {
        id: crypto.randomBytes(8).toString('hex'),
        kind: kind,
        text: text,
        confidence: String(body.confidence || 'your opt-in').slice(0, 160),
        source: String(body.source || 'your input only').slice(0, 160),
        date: new Date().toISOString()
      };
      user.learning.push(item);
      await q(INSERT_TRAINING_SQL, itemParams(item, key(user.username)));
      return json(req, res, 200, { ok: true, item: item });
    }
    if (pathname === '/api/crystallized' && method === 'GET'){
      return json(req, res, 200, { ok: true, items: user.learning || [] });
    }
    if (pathname === '/api/royalties' && method === 'GET'){
      return json(req, res, 200, { ok: true, items: user.royalties || [], payment: 'none — no live payments' });
    }
    /* Code only, not a checkout: a future paid training run sends the ids of the
       opted-in items it used. We keep a record for a human to calculate a cut
       later. No money is taken, no amount is invented, no work text is stored. */
    if (pathname === '/api/royalty/usage' && method === 'POST'){
      if (body.paid !== true) return json(req, res, 400, { ok: false, error: 'Only a paid training run can record usage.' });
      const runId = String(body.runId || '').trim().slice(0, 100);
      if (!runId) return json(req, res, 400, { ok: false, error: 'A run id is needed for the record.' });
      const requested = Array.isArray(body.items) ? body.items : [];
      if (!requested.length) return json(req, res, 400, { ok: false, error: 'No items were listed for this run.' });
      const seen = new Set();
      const records = [];
      for (const entry of requested){
        const id = String(entry && entry.id ? entry.id : entry || '').trim().slice(0, 100);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const item = (user.learning || []).filter(function(it){ return it.id === id; })[0];
        if (!item) continue;
        const usedOptin = royaltyOptinFor(user, item, entry && entry.optin ? String(entry.optin) : null);
        if (!usedOptin) continue;
        records.push({
          username: key(user.username), itemId: id, kind: String(item.kind || ''),
          optin: usedOptin, runId: runId, date: new Date().toISOString(), amount: null
        });
      }
      if (!records.length) return json(req, res, 403, { ok: false, error: 'None of those items is opted in — nothing recorded.' });
      user.royalties = (user.royalties || []).concat(records).slice(-MAX_ROYALTY_RECORDS);
      await saveUser(user);
      console.log('[royalty] recorded '+records.length+' opted-in item use(s) for a paid run; no payment made');
      return json(req, res, 200, { ok: true, recorded: records.length, payment: 'not calculated — no live payments' });
    }
    if (pathname.indexOf('/api/learn/') === 0 && method === 'DELETE'){
      const id = decodeURIComponent(pathname.slice('/api/learn/'.length));
      const before = (user.learning || []).length;
      user.learning = (user.learning || []).filter(function(it){ return it.id !== id; });
      await q(DELETE_TRAINING_SQL, [id, key(user.username)]);
      if (user.learning.length === before) return json(req, res, 404, { ok: false, error: 'That saved item was not found.' });
      console.log('[crystallized] one saved item removed');
      return json(req, res, 200, { ok: true });
    }
    if (pathname === '/api/delete-all' && method === 'POST'){
      user.learning = [];
      user.model = null;
      await q(CLEAR_TRAINING_SQL, [key(user.username), JSON.stringify(extraFor(user))]);
      console.log('[crystallized] all training data and saved model deleted for a user');
      return json(req, res, 200, { ok: true });
    }
    return json(req, res, 404, { ok: false, error: 'No such API endpoint' });
  });
}

/* ---------- request routing ---------- */
const server = http.createServer(function(req, res){
  // Render puts every visitor behind one proxy, so use the forwarded client IP
  // for the per-IP limit. Locally X-Forwarded-Proto is not set, so this is just us.
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let record = visitors.get(ip);
  if (!record || now >= record.reset){
    record = { count: 0, reset: now + WINDOW_MS };
    visitors.set(ip, record);
  }
  record.count += 1;
  if (record.count > MAX_REQUESTS){
    // Never log URLs or bodies — they could contain a password or a magic code.
    console.log('[rate-limit] 429 too many requests from ' + ip);
    return send(req, res, 429, 'Too many requests, wait a minute and try again', 'text/plain; charset=utf-8');
  }

  const pathname = (req.url || '/').split('?')[0];
  const method = (req.method || 'GET').toUpperCase();

  if (pathname.indexOf('/api/') === 0) return api(req, res, pathname, method);

  // No directory listing: only the allowlisted paths exist. Everything else is 404.
  const asset = STATIC_FILES[pathname];
  if (!asset || (method !== 'GET' && method !== 'HEAD')){
    return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  fs.readFile(path.join(__dirname, asset.file), function(err, data){
    if (err){
      console.error('[error] could not read ' + asset.file);
      return send(req, res, 500, 'Server error', 'text/plain; charset=utf-8');
    }
    send(req, res, 200, data, asset.type);
  });
});

storageReady.then(function(){
  server.listen(PORT, HOST, function(){
    console.log('CyburrHunee ' + (PRODUCTION ? 'Render server' : 'local-only server') + ': http://' + HOST + ':' + PORT + '/');
    console.log('Email sending: ' + (RESEND_KEY ? 'configured via Resend' : 'not set up yet (add RESEND_API_KEY to .env)'));
    console.log('Stop with Ctrl+C (or: pkill -f "node server.js")');
  });
});
