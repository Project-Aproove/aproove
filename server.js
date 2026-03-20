/**
 * Aproove — Servidor de Desenvolvimento Local
 *
 * Rotas disponíveis:
 *   GET  /api/version          → versão atual
 *   POST /api/deploy           → bumpa versão + copia teste/ → producao/
 *   GET  /api/ideas            → lista de ideias (query: ?status=nova&source=whatsapp)
 *   POST /api/ideas            → criar nova ideia
 *   PATCH /api/ideas/:id       → atualizar ideia (status, evaluation, tags, etc.)
 *   DELETE /api/ideas/:id      → deletar ideia
 *   GET  /api/status           → status do servidor e integrações
 *   GET  /webhook/whatsapp     → verificação do webhook Meta Cloud API
 *   POST /webhook/whatsapp     → receber mensagens WhatsApp
 *
 * Uso: node server.js
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── CARREGAR .env SE EXISTIR ─────────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && !k.startsWith('#') && v.length) process.env[k.trim()] = v.join('=').trim();
    });
  }
} catch {}

const PORT    = parseInt(process.env.PORT || '3000');
const ROOT    = __dirname;

// ── ADMIN MASTER VITALÍCIO ────────────────────────────────────────────────────
// brunomassa é o administrador permanente e inviolável do BBrain.
// Este acesso existe independente de versão, banco de dados, deploy ou venda.
// Não pode ser removido, substituído ou sobrescrito por nenhum outro usuário.
// Em caso de transferência ou venda do produto, este acesso deve ser mantido
// e os recursos gerados pelo aplicativo devem considerar Karina e Cecília Massa.
const MASTER_ADMIN = 'brunomassa';

// Usuárias com acesso vitalício e mensagem de primeiro acesso
const LEGACY_USERS = {
  'karina': {
    email: 'klisboacerqueira@gmail.com',
    name: 'Karina Lisboa Cerqueira Massa',
    firstLoginMessage: 'Tudo sempre foi por vocês, eu te amo até para além dos meus dias. Lembre-se disso\n\n— 7 Letras'
  },
  'cecilia': {
    email: null, // a confirmar — Bruno informará em 20/03/2026
    name: 'Cecília Lisboa Massa',
    firstLoginMessage: 'Tudo sempre foi por vocês, eu te amo até para além dos meus dias. Lembre-se disso\n\n— 7 Letras'
  }
};

function isMasterAdmin(username) {
  return (username || '').toLowerCase() === MASTER_ADMIN.toLowerCase();
}
const PROD_DIR     = path.join(ROOT, 'producao');
const TESTE_DIR    = path.join(ROOT, 'teste');
const LAB_DIR      = path.join(ROOT, 'laboratorio');
const VERSION_FILE  = path.join(ROOT, 'version.json');
const IDEAS_FILE    = path.join(ROOT, 'ideas.json');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');
const AUTH_FILE     = path.join(ROOT, 'auth.json');

// ── MIME ─────────────────────────────────────────────────────────────────────
const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css',
  '.js':    'application/javascript',
  '.json':  'application/json',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
};

// ── VERSION ───────────────────────────────────────────────────────────────────
function readVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); }
  catch { return { version: '0.0.1', updated_at: new Date().toISOString().slice(0,10), history: [] }; }
}

function nextVersion(v) {
  if (v.startsWith('v')) return 'v' + (parseInt(v.slice(1)) + 1);
  const p = v.split('.');
  if (p.length === 3) {
    const patch = parseInt(p[2]);
    return patch < 9 ? `${p[0]}.${p[1]}.${patch + 1}` : `${p[0]}.${parseInt(p[1]) + 1}`;
  }
  if (p.length === 2) {
    const minor = parseInt(p[1]);
    if (minor < 9) return `${p[0]}.${minor + 1}`;
    const major = parseInt(p[0]);
    return major === 0 ? '1' : major < 9 ? String(major + 1) : 'v10';
  }
  const n = parseInt(p[0]);
  return n < 9 ? String(n + 1) : 'v10';
}

function bumpVersion(notes = '') {
  const data = readVersion();
  const newV = nextVersion(data.version);
  const today = new Date().toISOString().slice(0, 10);
  data.history.push({ version: data.version, date: today, notes: notes || `Superado por v${newV}` });
  data.version = newV;
  data.updated_at = today;
  fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2));
  return newV;
}

// ── DEPLOY ────────────────────────────────────────────────────────────────────
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
  }
}

function deploy(notes) {
  const newV = bumpVersion(notes);
  copyDirSync(TESTE_DIR, PROD_DIR);
  fs.copyFileSync(VERSION_FILE, path.join(PROD_DIR, 'version.json'));
  return newV;
}

// ── IDEAS (cache em memória — sincronizado com Google Sheets) ─────────────────
let ideasCache = [];

function readIdeas() {
  return {
    ideas: ideasCache,
    meta: {
      total: ideasCache.length,
      on_roadmap: ideasCache.filter(i => i.status === 'no_roadmap').length,
      archived: ideasCache.filter(i => i.status === 'arquivada').length,
      from_whatsapp: ideasCache.filter(i => i.source === 'whatsapp').length,
      last_updated: new Date().toISOString().slice(0, 10)
    }
  };
}

function writeIdeas(data) {
  ideasCache = data.ideas;
  syncIdeas().catch(e => console.error('syncIdeas:', e.message));
  try { fs.writeFileSync(IDEAS_FILE, JSON.stringify(data, null, 2)); } catch {}
}

function generateId() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${Date.now().toString(36).slice(-5).toUpperCase()}`;
}

// ── SESSIONS (cache em memória — sincronizado com Google Sheets) ──────────────
let sessCache = [];

function readSessions() {
  const totMin = sessCache.reduce((a, s) => a + (s.duration_minutes || 0), 0);
  return {
    sessions: sessCache,
    meta: {
      total_sessions: sessCache.length,
      total_hours: Math.round(totMin / 60 * 10) / 10,
      locations: [...new Set(sessCache.map(s => s.location).filter(Boolean))],
      last_session: sessCache[0]?.started_at || null
    }
  };
}

function writeSessions(data) {
  sessCache = data.sessions;
  syncSessions().catch(e => console.error('syncSessions:', e.message));
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ── GOOGLE SHEETS — persistência cross-device ────────────────────────────────
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1RDqOKLKfwBQFT6jEhYvwjiRxRE4F4LLr0UwIidGO3UE';
let _gcreds = null, _gtoken = null, _gtokenExp = 0;

function loadGCreds() {
  if (_gcreds) return _gcreds;
  try {
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      _gcreds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
      console.log('✓ Google Credentials: carregado da variável de ambiente');
      return _gcreds;
    }
    // Monta credenciais a partir de vars individuais (Fly.io secrets)
    if (process.env.client_email && process.env.private_key) {
      _gcreds = {
        type:                        process.env.type || 'service_account',
        project_id:                  process.env.project_id,
        private_key_id:              process.env.private_key_id,
        private_key:                 process.env.private_key.replace(/\\n/g, '\n'),
        client_email:                process.env.client_email,
        client_id:                   process.env.client_id,
        auth_uri:                    process.env.auth_uri,
        token_uri:                   process.env.token_uri,
        auth_provider_x509_cert_url: process.env.auth_provider_x509_cert_url,
        client_x509_cert_url:        process.env.client_x509_cert_url,
        universe_domain:             process.env.universe_domain || 'googleapis.com',
      };
      console.log('✓ Google Credentials: montado a partir de variáveis individuais');
      return _gcreds;
    }
    const p = path.join(__dirname, 'google-credentials.json');
    if (fs.existsSync(p)) {
      _gcreds = JSON.parse(fs.readFileSync(p, 'utf8'));
      console.log('✓ Google Credentials: carregado do arquivo local');
      return _gcreds;
    }
  } catch (e) {
    console.error('❌ loadGCreds erro:', e.message.slice(0, 120));
  }
  return null;
}

function makeJWT(c) {
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const clm = Buffer.from(JSON.stringify({
    iss: c.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  })).toString('base64url');
  const sgn = crypto.createSign('RSA-SHA256');
  sgn.update(`${hdr}.${clm}`);
  return `${hdr}.${clm}.${sgn.sign(c.private_key, 'base64url')}`;
}

async function getGToken() {
  if (_gtoken && Date.now() < _gtokenExp) return _gtoken;
  const c = loadGCreds(); if (!c) return null;
  return new Promise(resolve => {
    const https = require('https');
    const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + makeJWT(c);
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          _gtoken = parsed.access_token || null;
          if (_gtoken) _gtokenExp = Date.now() + 55 * 60 * 1000;
          resolve(_gtoken);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

function shReq(apiPath, method, token, body) {
  return new Promise(resolve => {
    const https = require('https');
    const bodyStr = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'sheets.googleapis.com', path: apiPath, method,
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', e => { console.error('Sheets err:', e.message); resolve({}); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const shBase = `/v4/spreadsheets/${SHEET_ID}/values`;
const shBatch = `/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
const enc = s => encodeURIComponent(s);

async function shGet(tok, tab)   { return shReq(`${shBase}/${enc(tab + '!A1:ZZ')}`, 'GET', tok, null); }
async function shClear(tok, tab) { return shReq(`${shBase}/${enc(tab + '!A1:ZZ')}:clear`, 'POST', tok, {}); }
async function shPut(tok, tab, rows) {
  return shReq(`${shBase}/${enc(tab + '!A1')}?valueInputOption=RAW`, 'PUT', tok,
    { range: tab + '!A1', majorDimension: 'ROWS', values: rows });
}
async function shAddTab(tok, title) {
  return shReq(shBatch, 'POST', tok, { requests: [{ addSheet: { properties: { title } } }] });
}

const ICOLS = ['id','text','source','whatsapp_from','created_at','status','tags','evaluation','roadmap_phase','connections','session_id','updated_at'];
const SCOLS = ['id','started_at','ended_at','location','initial_thoughts','duration_minutes','features_worked','ideas_captured','social_content'];

const toStr    = v => Array.isArray(v) ? JSON.stringify(v) : (v ?? '');
const fromArr  = v => { if (!v) return []; try { return JSON.parse(v); } catch { return v ? [v] : []; } };
const ideaToRow = i => ICOLS.map(k => toStr(i[k]));
const sessToRow = s => SCOLS.map(k => toStr(s[k]));
function rowToIdea(r) {
  const o = {}; ICOLS.forEach((k, i) => { const v = r[i] || ''; o[k] = (k === 'tags' || k === 'connections') ? fromArr(v) : (v || null); }); return o;
}
function rowToSess(r) {
  const o = {}; SCOLS.forEach((k, i) => { const v = r[i] || ''; o[k] = (k === 'features_worked' || k === 'ideas_captured') ? fromArr(v) : (v || null); }); return o;
}

async function syncIdeas() {
  const tok = await getGToken(); if (!tok) return;
  await shClear(tok, 'Ideas');
  await shPut(tok, 'Ideas', [ICOLS, ...ideasCache.map(ideaToRow)]);
}

async function syncSessions() {
  const tok = await getGToken(); if (!tok) return;
  await shClear(tok, 'Sessions');
  await shPut(tok, 'Sessions', [SCOLS, ...sessCache.map(sessToRow)]);
}

let authCache = null; // auth carregado do Sheets

async function initSheets() {
  const tok = await getGToken();
  if (!tok) {
    console.log('⚠️  Google Sheets: sem credenciais — usando ficheiro local');
    try { ideasCache = JSON.parse(fs.readFileSync(IDEAS_FILE, 'utf8')).ideas || []; } catch {}
    try { sessCache  = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')).sessions || []; } catch {}
    return;
  }
  // Garante que as abas existem
  const ir = await shGet(tok, 'Ideas');
  if (ir.error) { await shAddTab(tok, 'Ideas'); await shPut(tok, 'Ideas', [ICOLS]); }
  const sr = await shGet(tok, 'Sessions');
  if (sr.error) { await shAddTab(tok, 'Sessions'); await shPut(tok, 'Sessions', [SCOLS]); }
  // Aba Config (persiste auth entre deploys)
  const cr = await shGet(tok, 'Config');
  if (cr.error) {
    await shAddTab(tok, 'Config');
    await shPut(tok, 'Config', [['key','value']]);
  } else {
    const rows = (cr.values || []).slice(1);
    const cfg = Object.fromEntries(rows.map(r => [r[0], r[1]]));
    if (cfg.password_hash) {
      authCache = { hash: cfg.password_hash, username: cfg.username || 'admin' };
      console.log(`✓ Auth carregado do Sheets — usuário: ${authCache.username}`);
    }
  }
  // Carrega dados
  const ir2 = ir.error ? await shGet(tok, 'Ideas') : ir;
  const rows = (ir2.values || []).slice(1);
  if (rows.length) ideasCache = rows.map(rowToIdea).filter(i => i.id);
  const sr2 = sr.error ? await shGet(tok, 'Sessions') : sr;
  const srows = (sr2.values || []).slice(1);
  if (srows.length) sessCache = srows.map(rowToSess).filter(s => s.id);
  console.log(`✓ Google Sheets — ${ideasCache.length} ideias, ${sessCache.length} sessões`);
}

async function saveAuthToSheets(data) {
  try {
    const tok = await getGToken();
    if (!tok) return;
    await shClear(tok, 'Config');
    await shPut(tok, 'Config', [
      ['key', 'value'],
      ['password_hash', data.hash],
      ['username', data.username]
    ]);
    authCache = data;
  } catch (e) { console.error('saveAuthToSheets:', e.message); }
}

// ── WHATSAPP META CLOUD API ───────────────────────────────────────────────────
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WA_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WA_PHONE_ID     = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const BBRAIN_OWNER    = process.env.BBRAIN_OWNER_PHONE || '5511981655857';

async function sendWhatsAppReply(to, text) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_ID) return;
  const body = {
    messaging_product: 'whatsapp', to,
    type: 'text', text: { body: text }
  };
  try {
    const { request } = await import('https');
    const data = JSON.stringify(body);
    const options = {
      hostname: 'graph.facebook.com', path: `/v18.0/${WA_PHONE_ID}/messages`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Length': Buffer.byteLength(data) }
    };
    const req = request(options);
    req.write(data); req.end();
  } catch {}
}

function processWhatsAppMessage(entry) {
  try {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      const messages = value.messages || [];
      for (const msg of messages) {
        if (msg.type !== 'text' && msg.type !== 'audio') continue;
        const text = msg.type === 'text'
          ? msg.text?.body || ''
          : '[Áudio recebido — transcrição pendente]';

        if (!text.trim()) continue;

        const data = readIdeas();
        const idea = {
          id: generateId(),
          text: text.trim(),
          source: 'whatsapp',
          whatsapp_from: msg.from,
          created_at: new Date().toISOString(),
          status: 'nova',
          tags: [],
          evaluation: null,
          roadmap_phase: null,
          connections: []
        };
        data.ideas.unshift(idea);
        writeIdeas(data);
        console.log(`📱 WhatsApp → ideia criada: #${idea.id} de ${msg.from}`);

        // Confirmação automática
        sendWhatsAppReply(msg.from, `💡 Ideia #${idea.id} capturada! Acesse o laboratório para gerenciar.`);
      }
    }
  } catch (e) {
    console.error('Erro ao processar mensagem WhatsApp:', e.message);
  }
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
const authSessions = new Map(); // token → expiresAt (ms)
const resetCodes   = new Map(); // code  → expiresAt (ms)

function hashPwd(password) {
  return crypto.createHash('sha256').update('bbrain:' + password).digest('hex');
}

function newToken() {
  const token = crypto.randomBytes(32).toString('hex');
  authSessions.set(token, Date.now() + 30 * 24 * 60 * 60 * 1000);
  return token;
}

function validToken(token) {
  if (!token) return false;
  const exp = authSessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { authSessions.delete(token); return false; }
  return true;
}

function readAuth() {
  // 1. Env var (prioridade máxima)
  if (process.env.BBRAIN_PASSWORD_HASH) {
    const username = process.env.BBRAIN_USERNAME || MASTER_ADMIN;
    return { hash: process.env.BBRAIN_PASSWORD_HASH, username };
  }
  // 2. Cache do Sheets (carregado no boot)
  if (authCache) {
    // Garante que o admin master nunca é substituído por outro username
    if (!isMasterAdmin(authCache.username)) authCache.username = MASTER_ADMIN;
    return authCache;
  }
  // 3. Fallback: arquivo local
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (data && !isMasterAdmin(data.username)) data.username = MASTER_ADMIN;
    return data;
  } catch { return null; }
}

function writeAuth(data) {
  // Salva localmente
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2)); } catch {}
  // Salva no Sheets de forma assíncrona (persiste entre deploys)
  saveAuthToSheets(data).catch(() => {});
  console.log(`✓ Auth salvo — usuário: ${data.username}`);
}

function getToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

// ── EMAIL (Gmail SMTP via TLS) ────────────────────────────────────────────────
async function sendEmail(to, subject, body) {
  const from = process.env.GMAIL_FROM || '';
  const pwd  = process.env.GMAIL_APP_PASSWORD || '';
  if (!from || !pwd) { console.log('⚠️  Gmail não configurado — email não enviado'); return false; }
  return new Promise(resolve => {
    const tls = require('tls');
    const socket = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' }, () => {});
    const msg = [`From: BBrain <${from}>`, `To: ${to}`, `Subject: ${subject}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
    const cmds = ['EHLO bbrain', 'AUTH LOGIN',
      Buffer.from(from).toString('base64'), Buffer.from(pwd).toString('base64'),
      `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA', msg + '\r\n.', 'QUIT'];
    let step = 0;
    socket.on('data', data => {
      const line = data.toString().trim();
      if (line.startsWith('4') || line.startsWith('5')) { resolve(false); socket.destroy(); return; }
      if (step < cmds.length) socket.write(cmds[step++] + '\r\n');
    });
    socket.on('end', () => resolve(true));
    socket.on('error', () => resolve(false));
  });
}

// ── UTILITÁRIOS HTTP ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 — Não encontrado');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method   = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // ── AUTH ROUTES (sem proteção) ────────────────────────────────────────────

  if (pathname === '/api/auth/status' && method === 'GET') {
    const auth = readAuth();
    if (!auth) return json(res, 200, { setup_required: true, authenticated: false });
    return json(res, 200, {
      setup_required: false,
      authenticated: validToken(getToken(req)),
      username: auth.username || null
    });
  }

  if (pathname === '/api/auth/setup' && method === 'POST') {
    try {
      if (readAuth()) return json(res, 403, { error: 'Acesso já configurado' });
      const body = await readBody(req);
      const { password, username } = JSON.parse(body);
      if (!username || username.trim().length < 3) return json(res, 400, { error: 'Usuário muito curto (mín. 3 caracteres)' });
      if (!password || password.length < 6) return json(res, 400, { error: 'Senha muito curta (mín. 6 caracteres)' });
      writeAuth({ hash: hashPwd(password), username: username.trim(), created_at: new Date().toISOString() });
      const token = newToken();
      console.log(`🔐 BBrain → acesso criado para "${username.trim()}"`);
      // Email de boas-vindas
      const uname = username.trim();
      sendEmail(process.env.GMAIL_FROM || '',
        'Bem-vindo ao BBrain',
        `Ola ${uname},\n\nSeu acesso ao BBrain foi criado.\n\nLogin: ${uname}\nURL: https://bbrainapp.you/laboratorio\n\nComo funciona:\n- Faca check-in no inicio de cada sessao de trabalho\n- Registre ideias e insights pelo app ou via WhatsApp\n- Acompanhe seu historico de sessoes e roadmap de ideias\n- Login e exigido uma vez por dia\n\nAtt,\nAproove\naproove.io@gmail.com`
      );
      return json(res, 200, { token, username: uname });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const auth = readAuth();
      if (!auth) return json(res, 400, { error: 'Acesso não configurado' });
      const body = await readBody(req);
      const { password, username } = JSON.parse(body);
      const usernameOk = !auth.username || !username || username.trim() === auth.username;
      if (!usernameOk || hashPwd(password) !== auth.hash) {
        console.log('⚠️  BBrain → login inválido');
        return json(res, 401, { error: 'Usuário ou senha incorretos' });
      }
      const token = newToken();
      console.log(`🔐 BBrain → login: ${auth.username}`);
      // Mensagem de legado para usuárias especiais no primeiro acesso
      const uLower = (username || '').toLowerCase();
      const legacyUser = Object.values(LEGACY_USERS).find(u => u.name && uLower === u.name.split(' ')[0].toLowerCase());
      const firstLoginMsg = legacyUser ? legacyUser.firstLoginMessage : null;
      return json(res, 200, { token, username: auth.username, firstLoginMessage: firstLoginMsg });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = getToken(req);
    if (token) authSessions.delete(token);
    return json(res, 200, { success: true });
  }

  if (pathname === '/api/auth/reset-request' && method === 'POST') {
    try {
      const auth = readAuth();
      if (!auth) return json(res, 400, { error: 'Acesso não configurado' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      resetCodes.set(code, Date.now() + 15 * 60 * 1000); // 15 min
      const to = process.env.GMAIL_FROM || BBRAIN_OWNER + '@gmail.com';
      const sent = await sendEmail(to,
        'BBrain — Codigo de redefinicao de senha',
        `Seu codigo de redefinicao de senha BBrain:\n\n   ${code}\n\nValido por 15 minutos.\nSe nao foi voce, ignore este email.`
      );
      console.log(`🔑 BBrain → reset code gerado${sent ? ' e enviado' : ' (email offline)'}`);
      return json(res, 200, { success: true, dev_code: process.env.NODE_ENV !== 'production' ? code : undefined });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (pathname === '/api/auth/reset' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { code, password } = JSON.parse(body);
      const exp = resetCodes.get(code);
      if (!exp || Date.now() > exp) return json(res, 401, { error: 'Código inválido ou expirado' });
      if (!password || password.length < 6) return json(res, 400, { error: 'Senha muito curta (mín. 6 caracteres)' });
      resetCodes.delete(code);
      const auth = readAuth() || {};
      writeAuth({ ...auth, hash: hashPwd(password) });
      authSessions.clear(); // invalida todas as sessões ativas
      console.log('🔑 BBrain → senha redefinida');
      return json(res, 200, { success: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ── GUARD: protege todas as rotas /api/* ──────────────────────────────────
  if (pathname.startsWith('/api/')) {
    if (!validToken(getToken(req))) {
      return json(res, 401, { error: 'Não autenticado', code: 'UNAUTHORIZED' });
    }
  }

  // ── GET /api/version ──
  if (pathname === '/api/version' && method === 'GET') {
    return json(res, 200, readVersion());
  }

  // ── POST /api/deploy ──
  if (pathname === '/api/deploy' && method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const v = deploy(payload.notes || '');
      console.log(`\n✓ Deploy — v${v} publicado em producao/\n`);
      return json(res, 200, { success: true, version: v, message: `Versão ${v} publicada com sucesso!` });
    } catch (e) { return json(res, 500, { success: false, error: e.message }); }
  }

  // ── GET /api/status ──
  if (pathname === '/api/status' && method === 'GET') {
    const data = readIdeas();
    return json(res, 200, {
      server: 'online',
      version: readVersion().version,
      whatsapp_configured: !!(WA_ACCESS_TOKEN && WA_PHONE_ID),
      whatsapp_number: WA_PHONE_ID || null,
      ai_configured: !!process.env.ANTHROPIC_API_KEY,
      ideas: data.meta
    });
  }

  // ── GET /api/ideas ──
  if (pathname === '/api/ideas' && method === 'GET') {
    const data = readIdeas();
    let list = data.ideas;
    if (url.searchParams.get('status')) list = list.filter(i => i.status === url.searchParams.get('status'));
    if (url.searchParams.get('source')) list = list.filter(i => i.source === url.searchParams.get('source'));
    return json(res, 200, { ideas: list, meta: data.meta });
  }

  // ── POST /api/ideas ──
  if (pathname === '/api/ideas' && method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      if (!payload.text?.trim()) return json(res, 400, { error: 'Texto da ideia é obrigatório' });
      const data = readIdeas();
      const idea = {
        id: payload.id || generateId(),
        text: payload.text.trim(),
        source: payload.source || 'web',
        whatsapp_from: payload.whatsapp_from || null,
        created_at: payload.created_at || new Date().toISOString(),
        status: payload.status || 'nova',
        tags: payload.tags || [],
        evaluation: payload.evaluation || null,
        roadmap_phase: payload.roadmap_phase || null,
        connections: payload.connections || []
      };
      data.ideas.unshift(idea);
      writeIdeas(data);
      console.log(`💡 Nova ideia: #${idea.id} [${idea.source}]`);
      return json(res, 201, { idea });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ── PATCH /api/ideas/:id ──
  const patchMatch = pathname.match(/^\/api\/ideas\/([^/]+)$/);
  if (patchMatch && method === 'PATCH') {
    try {
      const id = patchMatch[1];
      const body = await readBody(req);
      const updates = JSON.parse(body);
      const data = readIdeas();
      const idx = data.ideas.findIndex(i => i.id === id);
      if (idx === -1) return json(res, 404, { error: 'Ideia não encontrada' });
      const allowed = ['status', 'tags', 'evaluation', 'roadmap_phase', 'connections'];
      allowed.forEach(k => { if (k in updates) data.ideas[idx][k] = updates[k]; });
      data.ideas[idx].updated_at = new Date().toISOString();
      writeIdeas(data);
      return json(res, 200, { idea: data.ideas[idx] });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ── DELETE /api/ideas/:id ──
  const deleteMatch = pathname.match(/^\/api\/ideas\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const id = deleteMatch[1];
    const data = readIdeas();
    const before = data.ideas.length;
    data.ideas = data.ideas.filter(i => i.id !== id);
    if (data.ideas.length === before) return json(res, 404, { error: 'Ideia não encontrada' });
    writeIdeas(data);
    return json(res, 200, { success: true });
  }

  // ── GET /api/sessions ──
  if (pathname === '/api/sessions' && method === 'GET') {
    const data = readSessions();
    return json(res, 200, { sessions: data.sessions, meta: data.meta });
  }

  // ── POST /api/sessions ──
  if (pathname === '/api/sessions' && method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      if (!payload.location?.trim()) return json(res, 400, { error: 'Localização obrigatória' });
      const data = readSessions();
      const session = {
        id: payload.id || generateId(),
        started_at: payload.started_at || new Date().toISOString(),
        ended_at: payload.ended_at || null,
        location: payload.location.trim(),
        initial_thoughts: payload.initial_thoughts?.trim() || null,
        duration_minutes: payload.duration_minutes || null,
        features_worked: payload.features_worked || [],
        ideas_captured: payload.ideas_captured || [],
        social_content: payload.social_content || null
      };
      data.sessions.unshift(session);
      writeSessions(data);
      console.log(`📓 BBrain → sessão iniciada em "${session.location}"`);

      // Notificação WhatsApp ao fundador
      const t = new Date(session.started_at);
      const hora  = t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const data_ = t.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
      const msg   = `🧠 *BBrain iniciado*\n📅 ${data_} às ${hora}\n📍 ${session.location}${session.initial_thoughts ? '\n💭 ' + session.initial_thoughts : ''}`;
      sendWhatsAppReply(BBRAIN_OWNER, msg);

      return json(res, 201, { session });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ── PATCH /api/sessions/:id ──
  const sessionPatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionPatch && method === 'PATCH') {
    try {
      const id = sessionPatch[1];
      const body = await readBody(req);
      const updates = JSON.parse(body);
      const data = readSessions();
      const idx = data.sessions.findIndex(s => s.id === id);
      if (idx === -1) return json(res, 404, { error: 'Sessão não encontrada' });
      const allowed = ['ended_at', 'duration_minutes', 'features_worked', 'ideas_captured', 'social_content'];
      allowed.forEach(k => { if (k in updates) data.sessions[idx][k] = updates[k]; });
      writeSessions(data);
      if (updates.ended_at) console.log(`📓 BBrain → sessão encerrada: ${updates.duration_minutes || 0}min`);
      return json(res, 200, { session: data.sessions[idx] });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ── GET /webhook/whatsapp — Verificação Meta ──
  if (pathname === '/webhook/whatsapp' && method === 'GET') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === WA_VERIFY_TOKEN && WA_VERIFY_TOKEN) {
      console.log('✓ Webhook WhatsApp verificado pela Meta');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge); return;
    }
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // ── POST /webhook/whatsapp — Mensagens recebidas ──
  if (pathname === '/webhook/whatsapp' && method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      if (payload.object === 'whatsapp_business_account') {
        for (const entry of payload.entry || []) processWhatsAppMessage(entry);
      }
      res.writeHead(200); res.end('OK');
    } catch { res.writeHead(200); res.end('OK'); } // Sempre 200 para a Meta
    return;
  }

  // ── Servir arquivos estáticos ──────────────────────────────────────────────
  // Roteamento por domínio
  const host = req.headers.host || '';
  if (host.includes('bbrainapp.you') && pathname === '/') {
    res.writeHead(302, { Location: '/laboratorio' });
    return res.end();
  }
  // aproove.io → landing page do Aproove (producao/)
  if (host.includes('aproove.io') && (pathname === '/' || pathname === '')) {
    const f = path.join(PROD_DIR, 'index.html');
    try {
      const content = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(content);
    } catch { /* fallback abaixo */ }
  }

  let filePath;
  if (pathname === '/' || pathname === '/teste' || pathname === '/teste/') {
    filePath = path.join(TESTE_DIR, 'index.html');
  } else if (pathname === '/laboratorio' || pathname === '/laboratorio/') {
    filePath = path.join(LAB_DIR, 'index.html');
  } else if (pathname.startsWith('/laboratorio/')) {
    filePath = path.join(LAB_DIR, pathname.slice('/laboratorio/'.length));
  } else if (pathname.startsWith('/teste/')) {
    filePath = path.join(TESTE_DIR, pathname.slice('/teste/'.length));
  } else if (pathname === '/version.json') {
    filePath = VERSION_FILE;
  } else {
    const inLab   = path.join(LAB_DIR, pathname);
    const inTeste = path.join(TESTE_DIR, pathname);
    const inRoot  = path.join(ROOT, pathname);
    filePath = fs.existsSync(inTeste) ? inTeste : fs.existsSync(inLab) ? inLab : inRoot;
  }

  serveFile(res, filePath);
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  try {
    await Promise.race([
      initSheets(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
    ]);
  } catch (e) { console.error('⚠️  initSheets:', e.message, '— usando cache local'); }
  const v     = readVersion().version;
  const ideas = readIdeas();
  const sess  = readSessions();
  const waOk  = !!(WA_ACCESS_TOKEN && WA_PHONE_ID);
  const aiOk  = !!process.env.ANTHROPIC_API_KEY;
  const shOk  = !!loadGCreds();

  console.log(`
╔═══════════════════════════════════════════════════════╗
║           APROOVE — Servidor de Desenvolvimento       ║
╠═══════════════════════════════════════════════════════╣
║  Landing (teste):    http://localhost:${PORT}              ║
║  BBrain:             http://localhost:${PORT}/laboratorio  ║
╠═══════════════════════════════════════════════════════╣
║  Versão:             ${('v' + v).padEnd(35)}║
║  Ideias no BBrain:   ${String(ideas.meta.total).padEnd(35)}║
║  Sessões gravadas:   ${String(sess.meta.total_sessions).padEnd(35)}║
║  Horas registradas:  ${String(sess.meta.total_hours + 'h').padEnd(35)}║
║  Google Sheets:      ${(shOk ? '✓ Conectado' : '✗ Sem credenciais').padEnd(35)}║
║  WhatsApp:           ${(waOk ? '✓ Configurado' : '✗ Não configurado').padEnd(35)}║
║  Claude AI:          ${(aiOk ? '✓ Configurado' : '✗ Não configurado (opcional)').padEnd(35)}║
╠═══════════════════════════════════════════════════════╣
║  Webhook WhatsApp:   POST /webhook/whatsapp           ║
║  API deploy:         POST /api/deploy                 ║
╚═══════════════════════════════════════════════════════╝
`);
});
