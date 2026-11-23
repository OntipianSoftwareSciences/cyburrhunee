'use strict';
/* CyburrHunee server with a small JSON-file backend.
   Plain Node built-ins only: no framework, no cloud database, no calls out.
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

const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const HOST = PRODUCTION ? '0.0.0.0' : '127.0.0.1';
const PORT = Number(process.env.PORT) || 8000;

/* Only these exact paths exist — no directory listing, no source or data files. */
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/trustworthy-helper.html': { file: 'trustworthy-helper.html', type: 'text/html; charset=utf-8' },
  '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json' },
  '/sw.js': { file: 'sw.js', type: 'application/javascript; charset=utf-8' }
};
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'cyburrhunee.json');
const MAX_REQUESTS = 100;
const WINDOW_MS = 60 * 1000;
const CODE_MS = 10 * 60 * 1000;
const SESSION_MS = 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;

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
const sessions = new Map(); // token -> { username, expires }
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

/* ---------- local JSON store ---------- */
function emptyDB(){ return { users: {} }; }
function loadDB(){
  try{
    const o = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (o && o.users && typeof o.users === 'object') return o;
  }catch(e){ /* a missing or damaged file starts empty; never crash the local app */ }
  return emptyDB();
}
let db = loadDB();
function saveDB(){
  try{
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
  }catch(e){
    console.error('[error] could not save local database');
  }
}
/* Training data = learning items, saved models, training text and opted-in songs
   flagged as used for training. Accounts, password hashes and opt-ins stay. */
function trainingCountFor(user){
  const u = user || {};
  let n = Array.isArray(u.learning) ? u.learning.length : 0;
  if (u.model) n += 1;
  if (Array.isArray(u.optedInSongs)) n += u.optedInSongs.filter(function(s){ return s && s.usedForTraining; }).length;
  ['trainingText','dataset'].forEach(function(f){ if (u[f]) n += 1; });
  return n;
}
function countAllTraining(){
  return Object.keys(db.users || {}).reduce(function(n, k){ return n + trainingCountFor(db.users[k]); }, 0);
}
function deleteAllTraining(){
  let deleted = 0;
  Object.keys(db.users || {}).forEach(function(k){
    const u = db.users[k] || {};
    deleted += trainingCountFor(u);
    u.learning = [];
    u.model = null;
    if (Array.isArray(u.optedInSongs)) u.optedInSongs = u.optedInSongs.filter(function(s){ return !(s && s.usedForTraining); });
    ['trainingText','dataset'].forEach(function(f){ if (u[f]) u[f] = null; });
  });
  return deleted;
}
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
function makeSession(user){
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username: key(user.username), expires: Date.now() + SESSION_MS });
  return token;
}
function userFor(req, body){
  const h = req.headers.authorization || '';
  const token = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : (body && body.token) || '';
  const s = sessions.get(token);
  if (!s || Date.now() >= s.expires) return null;
  return db.users[s.username] || null;
}
function publicUser(user){
  return { ok: true, username: user.username, optins: user.optins || {} };
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
function resendCode(req, res, body){
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
  sendCodeEmail(pending.email, code).then(function(sent){
    if (!sent) return json(req, res, 502, { ok: false, error: 'I could not send the email right now. Please try again in a minute.' });
    user.code = { hash: hashCode(k, code), expires: Date.now() + CODE_MS, tries: 0 };
    saveDB();
    limit.count += 1;
    console.log('Code sent to ' + emailHash + ', expires in 10 minutes');
    return json(req, res, 200, { ok: true, message: 'We sent a new 6-digit code to your email. Enter it below. It expires in 10 minutes.' });
  }).catch(function(){
    return json(req, res, 502, { ok: false, error: 'I could not send the email right now. Please try again in a minute.' });
  });
}

const KNOWN_OPTINS = ['learnMusic','learnCode','learnText','learnEdits','learnRejections','rememberStyle'];
function cleanOptins(input){
  const out = {};
  KNOWN_OPTINS.forEach(function(k){ out[k] = !!(input && input[k] === true); });
  return out;
}
/* Idea votes: +1 up, -1 down, 0 cleared. Votes are keyed by idea id, so one
   card's vote never changes another. Confidence moves 10 from the card's
   starting value and returns to that value when the vote is cleared. */
function recordVote(req, res, body, expected, user){
  const ideaId=String(body.ideaId||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);
  const vote=Number(body.vote);
  if(!ideaId||vote!==expected) return json(req,res,400,{ok:false,error:'That vote was not valid.'});
  const base=Math.max(0,Math.min(100,Number(body.baseConfidence)||50));
  if(!user.votes||typeof user.votes!=='object') user.votes={};
  const prev=user.votes[ideaId]||{};
  const baseConfidence=Number.isFinite(prev.baseConfidence)?prev.baseConfidence:base;
  const confidence=Math.max(0,Math.min(100,baseConfidence+vote*10));
  user.votes[ideaId]={vote:vote,baseConfidence:baseConfidence,confidence:confidence,date:new Date().toISOString()};
  saveDB();
  return json(req,res,200,{ok:true,ideaId:ideaId,vote:vote,confidence:confidence});
}
function api(req, res, pathname, method){
  let body;
  readBody(req, function(parsed){
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
      sendCodeEmail(email, code).then(function(sent){
        if (!sent) return json(req, res, 502, { ok: false, error: 'I could not send the email right now. Please try again in a minute.' });
        db.users[k] = user;
        saveDB();
        limit.count += 1;
        pendingEmails.set(k, { email: email, expires: Date.now() + HOUR_MS });
        console.log('Code sent to ' + emailHash + ', expires in 10 minutes');
        return json(req, res, 200, { ok: true, message: 'We sent a 6-digit code to your email. Enter it below. It expires in 10 minutes.' });
      }).catch(function(){
        return json(req, res, 502, { ok: false, error: 'I could not send the email right now. Please try again in a minute.' });
      });
      return;
    }

    if ((pathname === '/api/send-code' || pathname === '/api/resend-code') && method === 'POST'){
      return resendCode(req, res, body);
    }

    if (pathname === '/api/verify-code' && method === 'POST'){
      const k = key(body.username);
      const user = db.users[k];
      if (!user || !user.code || user.verified) return json(req, res, 401, { ok: false, error: 'Ask for a new code first.' });
      if (Date.now() > user.code.expires){
        user.code = null; saveDB();
        return json(req, res, 401, { ok: false, error: 'That code expired. Ask for a new code.' });
      }
      if (String(body.code || '').trim() !== '' && hashCode(k, String(body.code).trim()) === user.code.hash){
        user.verified = true;
        user.code = null;
        pendingEmails.delete(k); // plain email exists only in memory until this moment
        saveDB();
        const token = makeSession(user);
        return json(req, res, 200, Object.assign(publicUser(user), { token: token }));
      }
      user.code.tries += 1;
      if (user.code.tries >= 3){
        user.code = null; saveDB();
        return json(req, res, 401, { ok: false, error: '3 tries used. Ask for a new code.', triesLeft: 0 });
      }
      saveDB();
      return json(req, res, 401, { ok: false, error: 'That code did not match.', triesLeft: 3 - user.code.tries });
    }

    if (pathname === '/api/login' && method === 'POST'){
      const user = db.users[key(body.username)];
      if (!user || !checkPassword(body.password, user.passwordHash)){
        return json(req, res, 401, { ok: false, error: 'That username or password did not match' });
      }
      if (!user.verified) return json(req, res, 401, { ok: false, error: 'Please verify your account first. Check your email for the code.' });
      return json(req, res, 200, Object.assign(publicUser(user), { token: makeSession(user) }));
    }

    /* --- every endpoint below needs the session token --- */
    const user = userFor(req, body);
    if (!user) return json(req, res, 401, { ok: false, error: 'Please log in first.' });

    if (pathname === '/api/session' && method === 'GET'){
      return json(req, res, 200, Object.assign(publicUser(user), { online: true }));
    }
    if (pathname === '/api/logout' && method === 'POST'){
      const h = req.headers.authorization || '';
      const token = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : (body.token || '');
      sessions.delete(token);
      return json(req, res, 200, { ok: true });
    }
    if (pathname === '/api/optins' && method === 'POST'){
      user.optins = cleanOptins(body.optins);
      saveDB();
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
      else allowed = !!(body.optin === 'learnCode' ? user.optins.learnCode : body.optin === 'learnMusic' ? user.optins.learnMusic : user.optins.learnText);
      if (!allowed) return json(req, res, 403, { ok: false, error: 'That learning switch is off — nothing saved.' });
      const item = {
        id: crypto.randomBytes(8).toString('hex'),
        kind: kind,
        text: text,
        confidence: String(body.confidence || 'your opt-in').slice(0, 160),
        source: String(body.source || 'your input only').slice(0, 160),
        date: new Date().toISOString()
      };
      user.learning.push(item);
      saveDB();
      return json(req, res, 200, { ok: true, item: item });
    }
    if (pathname === '/api/crystallized' && method === 'GET'){
      return json(req, res, 200, { ok: true, items: user.learning || [] });
    }
    if (pathname.indexOf('/api/learn/') === 0 && method === 'DELETE'){
      const id = decodeURIComponent(pathname.slice('/api/learn/'.length));
      const before = (user.learning || []).length;
      user.learning = (user.learning || []).filter(function(it){ return it.id !== id; });
      saveDB();
      if (user.learning.length === before) return json(req, res, 404, { ok: false, error: 'That saved item was not found.' });
      console.log('[crystallized] one saved item removed');
      return json(req, res, 200, { ok: true });
    }
    if (pathname === '/api/delete-all' && method === 'POST'){
      user.learning = [];
      user.model = null;
      saveDB();
      console.log('[crystallized] all training data and saved model deleted for a user');
      return json(req, res, 200, { ok: true });
    }
    /* Entire-database delete: any signed-in user may do it, but only after the
       browser confirm step. The log records count, who and when — never the text. */
    if (pathname === '/api/admin/training-count' && method === 'GET'){
      return json(req, res, 200, { ok: true, count: countAllTraining() });
    }
    if (pathname === '/api/admin/delete-all-training' && method === 'POST'){
      const deleted = deleteAllTraining();
      saveDB();
      console.log('Admin delete-all training data: '+deleted+' items, by '+user.username+', '+new Date().toISOString().slice(0,10));
      return json(req, res, 200, { ok: true, deleted: deleted });
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

server.listen(PORT, HOST, function(){
  console.log('CyburrHunee ' + (PRODUCTION ? 'Render server' : 'local-only server') + ': http://' + HOST + ':' + PORT + '/');
  console.log('Local database: ' + DB_FILE);
  console.log('Email sending: ' + (RESEND_KEY ? 'configured via Resend' : 'not set up yet (add RESEND_API_KEY to .env)'));
  console.log('Stop with Ctrl+C (or: pkill -f "node server.js")');
});
