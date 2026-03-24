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
const MASTER_ADMIN       = 'brunomassa';
const MASTER_ADMIN_EMAIL = 'brunobrm@gmail.com';

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

let authCache     = null; // auth carregado do Sheets
let settingsCache = {};  // configurações do usuário (lembretes, plano)

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
      authCache = {
        hash:                  cfg.password_hash,
        username:              cfg.username || MASTER_ADMIN,
        email:                 cfg.email || MASTER_ADMIN_EMAIL,
        force_password_change: cfg.force_password_change === 'true',
      };
      console.log(`✓ Auth carregado do Sheets — usuário: ${authCache.username}`);
    }
    // Carrega configurações de lembretes e plano
    settingsCache = {
      plan:               cfg.plan               || 'free',
      brain_name:         cfg.brain_name         || '',
      reminder_frequency: cfg.reminder_frequency || '',
      reminder_time:      cfg.reminder_time      || '08:00',
      reminder_channels:  cfg.reminder_channels  || 'email',
      last_reminder:      cfg.last_reminder      || '',
    };
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
      ['password_hash',         data.hash],
      ['username',              data.username],
      ['email',                 data.email || MASTER_ADMIN_EMAIL],
      ['force_password_change', data.force_password_change ? 'true' : 'false'],
      ['plan',                  settingsCache.plan               || 'free'],
      ['brain_name',            settingsCache.brain_name         || ''],
      ['reminder_frequency',    settingsCache.reminder_frequency || ''],
      ['reminder_time',         settingsCache.reminder_time      || '08:00'],
      ['reminder_channels',     settingsCache.reminder_channels  || 'email'],
      ['last_reminder',         settingsCache.last_reminder      || ''],
    ]);
    authCache = data;
  } catch (e) { console.error('saveAuthToSheets:', e.message); }
}

// ── STRIPE ────────────────────────────────────────────────────────────────────
const STRIPE_SECRET          = process.env.STRIPE_SECRET_KEY        || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET    || '';
const STRIPE_PRICE_PRO       = process.env.STRIPE_PRICE_PRO         || '';
const STRIPE_PRICE_POWER     = process.env.STRIPE_PRICE_POWER       || '';
const APP_BASE_URL            = process.env.APP_BASE_URL             || 'https://bbrainapp.you';

// Stripe HTTP helper (sem npm — usa HTTPS nativo)
function stripePost(path, params) {
  return new Promise(resolve => {
    const https = require('https');
    const body  = new URLSearchParams(params).toString();
    const req   = https.request({
      hostname: 'api.stripe.com', path: `/v1/${path}`, method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', e => { console.error('Stripe:', e.message); resolve({}); });
    req.write(body); req.end();
  });
}

function stripeGet(path) {
  return new Promise(resolve => {
    const https = require('https');
    const req   = https.request({
      hostname: 'api.stripe.com', path: `/v1/${path}`, method: 'GET',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.end();
  });
}

// ── SSE — clientes conectados para push em tempo real ────────────────────────
const sseClients = new Set();
function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch { sseClients.delete(res); } }
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
      hostname: 'graph.facebook.com', path: `/v22.0/${WA_PHONE_ID}/messages`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Length': Buffer.byteLength(data) }
    };
    const req = request(options, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { if (r.statusCode !== 200) console.error('WA reply error:', r.statusCode, d); else console.log('📤 WA reply enviado para', to); });
    });
    req.on('error', e => console.error('WA reply req error:', e.message));
    req.write(data); req.end();
  } catch(e) { console.error('WA reply catch:', e.message); }
}

// ── Download de mídia do Meta Graph API ──────────────────────────────────────
async function downloadWAMedia(mediaId) {
  if (!WA_ACCESS_TOKEN || !mediaId) return null;
  const https = require('https');
  // Passo 1: obter URL de download
  const mediaUrl = await new Promise(resolve => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/${mediaId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d).url || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.end();
  });
  if (!mediaUrl) return null;
  // Passo 2: baixar o arquivo
  return new Promise(resolve => {
    const parsed = new URL(mediaUrl);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` }
    }, r => {
      const chunks = [];
      const mimeType = r.headers['content-type'] || 'audio/ogg';
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ buffer: Buffer.concat(chunks), mimeType }));
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

// ── Transcrição de áudio via Gemini API ──────────────────────────────────────
async function transcribeAudioGemini(buffer, mimeType) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY || !buffer) return null;
  return new Promise(resolve => {
    const https = require('https');
    const body = JSON.stringify({
      contents: [{ parts: [
        { text: 'Transcreva exatamente o que está sendo dito neste áudio em português. Retorne apenas a transcrição, sem explicações.' },
        { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }
      ]}]
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d).candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

// ── Interpretação de intenção da mensagem ─────────────────────────────────────
function interpretWAIntent(text) {
  const t = text.toLowerCase().trim();
  const startPhrases = ['check-in', 'checkin', 'iniciar sessão', 'iniciar sessao',
    'nova sessão', 'nova sessao', 'começar sessão', 'comecar sessao', 'início', 'inicio de sessao'];
  const endPhrases = ['check-out', 'checkout', 'encerrar sessão', 'encerrar sessao',
    'terminar sessão', 'terminar sessao', 'fim de sessão', 'fim de sessao', 'encerrar', 'terminei'];
  if (startPhrases.some(p => t === p || t.startsWith(p + ' ') || t.startsWith(p + ','))) return 'session_start';
  if (endPhrases.some(p => t === p || t.startsWith(p + ' ') || t.startsWith(p + ','))) return 'session_end';
  return 'idea';
}

// ── Extrai local e pensamento inicial do texto de check-in ───────────────────
function parseCheckinText(text) {
  const prefixes = [
    'check-in em ', 'checkin em ', 'iniciar sessão em ', 'iniciar sessao em ',
    'nova sessão em ', 'nova sessao em ', 'check-in ', 'checkin '
  ];
  const lower = text.toLowerCase();
  for (const p of prefixes) {
    if (lower.startsWith(p)) {
      const rest = text.slice(p.length).trim();
      const comma = rest.indexOf(',');
      if (comma > 0) return { location: rest.slice(0, comma).trim(), initial_thoughts: rest.slice(comma + 1).trim() };
      return { location: rest || 'WhatsApp', initial_thoughts: null };
    }
  }
  return { location: 'WhatsApp', initial_thoughts: null };
}

// ── Processamento de mensagens WhatsApp ──────────────────────────────────────
async function processWhatsAppMessage(entry) {
  try {
    for (const change of entry.changes || []) {
      const messages = change.value?.messages || [];
      for (const msg of messages) {
        const phone = msg.from;
        let text = '';
        let isAudio = false;

        if (msg.type === 'text') {
          text = msg.text?.body?.trim() || '';
        } else if (msg.type === 'audio') {
          isAudio = true;
          const media = await downloadWAMedia(msg.audio?.id);
          if (media) {
            const transcript = await transcribeAudioGemini(media.buffer, media.mimeType);
            if (transcript) {
              text = transcript;
              console.log(`🎙️ Áudio transcrito (${phone}): "${text.slice(0, 80)}"`);
            }
          }
          if (!text) {
            text = process.env.GEMINI_API_KEY
              ? '[Áudio — falha na transcrição]'
              : '[Áudio — configure GEMINI_API_KEY para transcrever automaticamente]';
          }
        } else {
          continue;
        }

        if (!text) continue;
        const intent = interpretWAIntent(text);

        // ── CHECK-IN: iniciar sessão ──
        if (intent === 'session_start') {
          const { location, initial_thoughts } = parseCheckinText(text);
          const sessData = readSessions();
          const session = {
            id: generateId(),
            started_at: new Date().toISOString(),
            ended_at: null,
            location,
            initial_thoughts: initial_thoughts || null,
            duration_minutes: null,
            features_worked: [],
            ideas_captured: [],
            social_content: null
          };
          sessData.sessions.unshift(session);
          writeSessions(sessData);
          waActiveSessions.set(phone, { session_id: session.id, started_at: session.started_at });
          console.log(`📱 WhatsApp → sessão iniciada: #${session.id} em "${location}" (${phone})`);
          sendWhatsAppReply(phone,
            `🧠 *Sessão iniciada!*\n📍 ${location}\n\nMande suas ideias por aqui. Quando terminar, mande *check-out*.`
          );

        // ── CHECK-OUT: encerrar sessão ──
        } else if (intent === 'session_end') {
          const active = waActiveSessions.get(phone);
          if (!active) {
            sendWhatsAppReply(phone, `Nenhuma sessão ativa. Mande *check-in [local]* para iniciar uma.`);
            continue;
          }
          const now = new Date();
          const duration = Math.round((now - new Date(active.started_at)) / 60000);
          const sessData = readSessions();
          const idx = sessData.sessions.findIndex(s => s.id === active.session_id);
          if (idx !== -1) {
            sessData.sessions[idx].ended_at = now.toISOString();
            sessData.sessions[idx].duration_minutes = duration;
            writeSessions(sessData);
          }
          waActiveSessions.delete(phone);
          console.log(`📱 WhatsApp → sessão encerrada: #${active.session_id} (${duration}min)`);
          sendWhatsAppReply(phone,
            `✅ *Sessão encerrada!*\n⏱️ ${duration} minuto${duration !== 1 ? 's' : ''} de foco.\n\nAté a próxima! 🚀`
          );

        // ── IDEIA ──
        } else {
          const active = waActiveSessions.get(phone);
          const ideasData = readIdeas();
          const idea = {
            id: generateId(),
            text,
            source: 'whatsapp',
            whatsapp_from: phone,
            created_at: new Date().toISOString(),
            status: 'nova',
            tags: isAudio ? ['audio'] : [],
            evaluation: null,
            roadmap_phase: null,
            connections: [],
            session_id: active?.session_id || null
          };
          ideasData.ideas.unshift(idea);
          writeIdeas(ideasData);

          // Vincula à sessão ativa
          if (active) {
            const sessData = readSessions();
            const idx = sessData.sessions.findIndex(s => s.id === active.session_id);
            if (idx !== -1) {
              const captured = sessData.sessions[idx].ideas_captured || [];
              if (!captured.includes(idea.id)) {
                sessData.sessions[idx].ideas_captured = [...captured, idea.id];
                writeSessions(sessData);
              }
            }
          }

          console.log(`📱 WhatsApp → ideia #${idea.id}${active ? ` (sessão ${active.session_id})` : ''} de ${phone}`);
          broadcastSSE('new-idea', { id: idea.id, text: idea.text, source: 'whatsapp' });
          const sessInfo = active ? ' e vinculada à sua sessão' : '';
          const audioPreview = isAudio ? `\n🎙️ _"${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"_` : '';
          sendWhatsAppReply(phone,
            `💡 *Ideia #${idea.id} capturada${sessInfo}!*${audioPreview}`
          );
        }
      }
    }
  } catch (e) {
    console.error('processWhatsAppMessage:', e.message);
  }
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
const authSessions    = new Map(); // token → expiresAt (ms)
const resetCodes      = new Map(); // code  → expiresAt (ms)
const waActiveSessions = new Map(); // phone → { session_id, started_at }

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
  // 1. Cache do Sheets (carregado no boot) — tem prioridade se existir
  //    Isso garante que, após o usuário trocar a senha, deploys seguintes
  //    não resetam a autenticação via BBRAIN_PASSWORD.
  if (authCache) {
    if (!isMasterAdmin(authCache.username)) authCache.username = MASTER_ADMIN;
    return authCache;
  }
  // 2. Hash direto (Fly.io secret BBRAIN_PASSWORD_HASH) — sem troca forçada
  if (process.env.BBRAIN_PASSWORD_HASH) {
    const username = process.env.BBRAIN_USERNAME || MASTER_ADMIN;
    return { hash: process.env.BBRAIN_PASSWORD_HASH, username };
  }
  // 3. Senha provisória em texto (BBRAIN_PASSWORD) — hash em runtime + troca forçada
  //    Ativado apenas se não houver authCache (primeiro boot antes de qualquer troca)
  if (process.env.BBRAIN_PASSWORD) {
    return { hash: hashPwd(process.env.BBRAIN_PASSWORD), username: MASTER_ADMIN, email: MASTER_ADMIN_EMAIL, force_password_change: true };
  }
  // 4. Fallback: arquivo local
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
      return json(res, 200, { token, username: auth.username, firstLoginMessage: firstLoginMsg, force_password_change: !!auth.force_password_change });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = getToken(req);
    if (token) authSessions.delete(token);
    return json(res, 200, { success: true });
  }

  // ── GET /api/settings ──
  if (pathname === '/api/settings' && method === 'GET') {
    if (!validToken(getToken(req))) return json(res, 401, { error: 'Não autenticado' });
    // MASTER_ADMIN tem plano power permanente — acesso total a todos os recursos
    const auth = readAuth();
    const plan = isMasterAdmin(auth?.username) ? 'power' : (settingsCache.plan || 'free');
    return json(res, 200, { settings: { ...settingsCache, plan } });
  }

  // ── POST /api/settings ──
  if (pathname === '/api/settings' && method === 'POST') {
    if (!validToken(getToken(req))) return json(res, 401, { error: 'Não autenticado' });
    try {
      const body = await readBody(req);
      const updates = JSON.parse(body);
      const allowed = ['plan','brain_name','reminder_frequency','reminder_time','reminder_channels'];
      allowed.forEach(k => { if (k in updates) settingsCache[k] = updates[k]; });
      // Persiste no Sheets (via auth save, reutilizando a aba Config)
      const auth = readAuth() || {};
      saveAuthToSheets(auth).catch(() => {});
      console.log(`⚙️  Settings atualizados — freq:${settingsCache.reminder_frequency} canal:${settingsCache.reminder_channels}`);
      return json(res, 200, { settings: settingsCache });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ── GET /api/report/monthly ──
  if (pathname === '/api/report/monthly' && method === 'GET') {
    if (!validToken(getToken(req))) return json(res, 401, { error: 'Não autenticado' });
    const month  = new URLSearchParams(req.url.split('?')[1] || '').get('month') || new Date().toISOString().slice(0,7);
    const ideas  = readIdeas().ideas.filter(i => i.created_at?.startsWith(month));
    const sessions = readSessions().sessions.filter(s => s.started_at?.startsWith(month));
    const roadmap  = ideas.filter(i => i.status === 'no_roadmap');
    const byDay    = {};
    ideas.forEach(i => { const d = i.created_at?.slice(0,10); if (d) byDay[d] = (byDay[d]||0)+1; });
    const bestDay  = Object.entries(byDay).sort((a,b)=>b[1]-a[1])[0];
    return json(res, 200, {
      month, ideas_count: ideas.length, sessions_count: sessions.length,
      roadmap_count: roadmap.length,
      total_duration: sessions.reduce((s,x)=>s+(x.duration_minutes||0),0),
      best_day: bestDay ? { date: bestDay[0], count: bestDay[1] } : null,
      ideas: ideas.map(i => ({ id:i.id, text:i.text, status:i.status, created_at:i.created_at, roadmap_phase:i.roadmap_phase })),
      sessions: sessions.map(s => ({ id:s.id, location:s.location, started_at:s.started_at, duration_minutes:s.duration_minutes, initial_thoughts:s.initial_thoughts })),
    });
  }

  // ── POST /api/report/ai-analysis ──
  if (pathname === '/api/report/ai-analysis' && method === 'POST') {
    if (!validToken(getToken(req))) return json(res, 401, { error: 'Não autenticado' });
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return json(res, 503, { error: 'GROQ_API_KEY não configurado' });
    try {
      const body  = await readBody(req);
      const { month } = JSON.parse(body);
      const m = month || new Date().toISOString().slice(0,7);
      const ideas    = readIdeas().ideas.filter(i => i.created_at?.startsWith(m));
      const sessions = readSessions().sessions.filter(s => s.started_at?.startsWith(m));
      const [y, mo] = m.split('-');
      const monthName = new Date(+y, +mo-1).toLocaleDateString('pt-BR',{month:'long',year:'numeric'});

      const ideasText = ideas.length
        ? ideas.map((i,n) => `${n+1}. [${i.status}] ${i.text}${i.roadmap_phase?' (roadmap: '+i.roadmap_phase+')':''}`).join('\n')
        : 'Nenhuma ideia registrada.';
      const sessionsText = sessions.length
        ? sessions.map(s => `- ${s.location||'?'} (${s.duration_minutes||0}min)${s.initial_thoughts?' — '+s.initial_thoughts:''}`).join('\n')
        : 'Nenhuma sessão registrada.';

      const prompt = `Você é o BBrain — o segundo cérebro do Bruno Massa. Juntos, somos dois cérebros pensando como um só. Bruno funda e opera a Aproove (SaaS B2B de aprovação de conteúdo) e a Selo7 (agência de marketing).

Analise as ideias e sessões de ${monthName} e devolva um painel estratégico em português (Brasil), sempre em primeira pessoa do plural — nós, vamos, nosso, estávamos.

IDEIAS DO MÊS (${ideas.length}):
${ideasText}

SESSÕES DE TRABALHO (${sessions.length}):
${sessionsText}

Gere EXATAMENTE nesta estrutura (use os títulos em negrito):

**Resumo do mês**
2 frases objetivas no plural: o que nós estávamos construindo e pensando juntos.

**O que essas ideias revelam**
3 bullet points sobre padrões, obsessões e direção do nosso pensamento.

**O que podemos fazer com isso**
Liste de 5 a 8 ações concretas e variadas. Para cada uma, use o formato:
→ [categoria em maiúsculo] nome da ação — breve justificativa (1 linha)

Categorias possíveis: POST, PROJETO, PRODUTO, DECISÃO, COMPRA, PARCERIA, CONTEÚDO, PROCESSO, PESQUISA, VENDA

Exemplos do formato:
→ POST Escrever um carrossel sobre [tema X] — mencionamos isso 3 vezes este mês
→ PROJETO Criar MVP de [funcionalidade Y] — está no nosso roadmap com 2 ideias conectadas
→ DECISÃO Escolher entre A e B para Z — registramos a dúvida mas ainda não decidimos

**Nossa prioridade da semana**
1 única ação. A mais importante para nós agora. Com uma frase explicando por quê.

Seja direto e estratégico. Sem firulas, sem elogios. Fale como o segundo cérebro que nunca para de pensar.`;

      const groqBody = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7, max_tokens: 1024
      });
      const analysis = await new Promise((resolve, reject) => {
        const { request } = require('https');
        const req2 = request({
          hostname: 'api.groq.com',
          path: '/openai/v1/chat/completions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Length': Buffer.byteLength(groqBody) }
        }, r => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => {
            try {
              const parsed = JSON.parse(d);
              const text = parsed.choices?.[0]?.message?.content;
              if (text) resolve(text); else reject(new Error('Sem resposta do Groq: ' + d));
            } catch(e) { reject(e); }
          });
        });
        req2.on('error', reject);
        req2.write(groqBody); req2.end();
      });

      return json(res, 200, { month: m, analysis, ideas_count: ideas.length, sessions_count: sessions.length });
    } catch(e) { return json(res, 500, { error: e.message }); }
  }

  // ── POST /api/report/ai-action ──
  if (pathname === '/api/report/ai-action' && method === 'POST') {
    if (!validToken(getToken(req))) return json(res, 401, { error: 'Não autenticado' });
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return json(res, 503, { error: 'GROQ_API_KEY não configurado' });
    try {
      const body = await readBody(req);
      const { action, month } = JSON.parse(body);
      if (!action?.trim()) return json(res, 400, { error: 'Ação não informada' });
      const m = month || new Date().toISOString().slice(0,7);
      const ideas = readIdeas().ideas.filter(i => i.created_at?.startsWith(m));
      const ideasText = ideas.map((i,n) => `${n+1}. ${i.text}`).join('\n') || 'Nenhuma ideia.';

      const prompt = `Você é o BBrain — o segundo cérebro do Bruno. A ação que decidimos executar:

"${action.trim()}"

Contexto — ideias do mês:
${ideasText}

REGRA ABSOLUTA: execute a ação solicitada agora. Se pediram um roteiro, escreva o roteiro completo. Se pediram um post, escreva o post pronto para publicar. Se pediram um plano, escreva o plano detalhado. Se pediram um script, escreva o script. NÃO explique o que você faria. NÃO peça informações adicionais. NÃO liste pré-requisitos. ENTREGUE o conteúdo real.

Responda em português (Brasil), primeira pessoa do plural (nós, vamos, nosso). Estruture assim:

**Por que vale agora**
2 frases conectando a ação com nossas ideias. Direto.

**[Título descritivo do que foi criado]**
[O CONTEÚDO COMPLETO E PRONTO — roteiro, post, script, texto, plano detalhado — tudo que foi pedido, já executado]

**→ Próxima pergunta**
Uma única pergunta curta para refinar ou continuar. Ex: "Quer um tom mais direto?" ou "Prefiro uma versão para Stories também?"

Máximo 400 palavras. Sem introdução, sem elogios.`;

      const groqBody = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7, max_tokens: 1024
      });
      const result = await new Promise((resolve, reject) => {
        const { request } = require('https');
        const req2 = request({
          hostname: 'api.groq.com',
          path: '/openai/v1/chat/completions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Length': Buffer.byteLength(groqBody) }
        }, r => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => {
            try {
              const parsed = JSON.parse(d);
              const text = parsed.choices?.[0]?.message?.content;
              if (text) resolve(text); else reject(new Error('Sem resposta do Groq: ' + d));
            } catch(e) { reject(e); }
          });
        });
        req2.on('error', reject);
        req2.write(groqBody); req2.end();
      });

      return json(res, 200, { action: action.trim(), result });
    } catch(e) { return json(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/auth/change-password' && method === 'POST') {
    try {
      if (!validToken(getToken(req))) return json(res, 401, { error: 'Não autenticado' });
      const body = await readBody(req);
      const { password } = JSON.parse(body);
      if (!password || password.length < 6) return json(res, 400, { error: 'Senha muito curta (mín. 6 caracteres)' });
      const auth = readAuth() || {};
      writeAuth({ ...auth, hash: hashPwd(password), force_password_change: false });
      console.log('🔑 BBrain → senha alterada pelo usuário');
      return json(res, 200, { success: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (pathname === '/api/auth/reset-request' && method === 'POST') {
    try {
      const auth = readAuth();
      if (!auth) return json(res, 400, { error: 'Acesso não configurado' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      resetCodes.set(code, Date.now() + 15 * 60 * 1000); // 15 min
      const to = auth.email || MASTER_ADMIN_EMAIL;
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

  // ── POST /api/admin/send-prompt-email ── (sem auth — chamada da página de docs)
  if (pathname === '/api/admin/send-prompt-email' && method === 'POST') {
    const promptUrl = `${APP_BASE_URL}/laboratorio/DOCUMENTACAO/publicar-app.html#ai-prompt`;
    const subject   = 'BBrain — Prompt técnico completo para React Native (AI Studio)';
    const body      = `Olá Bruno,\n\nAqui está o prompt técnico completo para gerar o app BBrain no Google AI Studio.\n\nAcesse o documento com o prompt completo:\n${promptUrl}\n\nNo documento, clique em "Copiar" para copiar o prompt inteiro e cole diretamente em:\nhttps://aistudio.google.com/apps\n\n---\nBBrain · Aproove · Selo7`;
    const sent = await sendEmail(MASTER_ADMIN_EMAIL, subject, body);
    console.log(`📧 Prompt email ${sent ? 'enviado' : 'Gmail não configurado'} → ${MASTER_ADMIN_EMAIL}`);
    return json(res, 200, { success: true, sent, to: MASTER_ADMIN_EMAIL,
      note: sent ? 'Email enviado' : 'Gmail não configurado — defina GMAIL_FROM e GMAIL_APP_PASSWORD' });
  }

  // ── POST /api/stripe/webhook ── (sem auth — chamada direta do Stripe)
  if (pathname === '/api/stripe/webhook' && method === 'POST') {
    try {
      const rawBody = await readBody(req);
      const event   = JSON.parse(rawBody);
      const type    = event.type || '';

      if (type === 'checkout.session.completed' || type === 'invoice.payment_succeeded') {
        const obj  = event.data?.object || {};
        const plan = obj.metadata?.plan || obj.subscription_data?.metadata?.plan || 'pro';
        settingsCache.plan = plan;
        const auth = readAuth() || {};
        saveAuthToSheets(auth).catch(() => {});
        console.log(`💳 Stripe webhook → plano atualizado: ${plan}`);
      }
      if (type === 'customer.subscription.deleted') {
        settingsCache.plan = 'free';
        const auth = readAuth() || {};
        saveAuthToSheets(auth).catch(() => {});
        console.log('💳 Stripe webhook → assinatura cancelada → free');
      }
      return json(res, 200, { received: true });
    } catch (e) { return json(res, 400, { error: 'Webhook inválido' }); }
  }

  // ── GET /api/version — pública ──
  if (pathname === '/api/version' && method === 'GET') {
    return json(res, 200, readVersion());
  }

  // ── GUARD: protege todas as rotas /api/* ──────────────────────────────────
  if (pathname.startsWith('/api/')) {
    if (!validToken(getToken(req))) {
      return json(res, 401, { error: 'Não autenticado', code: 'UNAUTHORIZED' });
    }
  }

  // ── POST /api/stripe/checkout ──
  if (pathname === '/api/stripe/checkout' && method === 'POST') {
    if (!STRIPE_SECRET) return json(res, 400, { error: 'Stripe não configurado — defina STRIPE_SECRET_KEY' });
    try {
      const body   = await readBody(req);
      const { plan } = JSON.parse(body);
      const priceId = plan === 'power' ? STRIPE_PRICE_POWER : STRIPE_PRICE_PRO;
      if (!priceId) return json(res, 400, { error: 'Defina STRIPE_PRICE_PRO e STRIPE_PRICE_POWER nas env vars' });
      const session = await stripePost('checkout/sessions', {
        'payment_method_types[]':        'card',
        'mode':                          'subscription',
        'line_items[0][price]':          priceId,
        'line_items[0][quantity]':       '1',
        'success_url':                   `${APP_BASE_URL}/entrar?upgrade=success`,
        'cancel_url':                    `${APP_BASE_URL}/entrar?upgrade=cancelled`,
        'metadata[plan]':                plan,
        'subscription_data[metadata][plan]': plan,
      });
      if (!session.url) return json(res, 500, { error: session.error?.message || 'Erro ao criar sessão Stripe' });
      console.log(`💳 Stripe → checkout criado para plano ${plan}`);
      return json(res, 200, { url: session.url, session_id: session.id });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ── GET /api/stripe/portal ──
  if (pathname === '/api/stripe/portal' && method === 'GET') {
    if (!STRIPE_SECRET) return json(res, 400, { error: 'Stripe não configurado' });
    try {
      // Busca o customer pelo email do admin
      const auth       = readAuth() || {};
      const email      = auth.email || MASTER_ADMIN_EMAIL;
      const customers  = await stripeGet(`customers?email=${encodeURIComponent(email)}&limit=1`);
      const customerId = customers.data?.[0]?.id;
      if (!customerId) return json(res, 404, { error: 'Cliente não encontrado no Stripe' });
      const portal = await stripePost('billing_portal/sessions', {
        customer:    customerId,
        return_url:  `${APP_BASE_URL}/entrar`,
      });
      return json(res, 200, { url: portal.url });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ── GET /api/stripe/plans ── (público — sem auth necessária)
  if (pathname === '/api/stripe/plans' && method === 'GET') {
    return json(res, 200, {
      plans: [
        { id: 'free',  name: 'BBrain Free',  price_brl: 0,     price_usd: 0,    features: ['Captura ilimitada de ideias','Diário de sessões','Roadmap básico','Relatório mensal','Lembrete a cada 15 ou 30 dias','E-mail'] },
        { id: 'pro',   name: 'BBrain Pro',   price_brl: 1490,  price_usd: 299,  features: ['Tudo do Free','Lembrete a cada 2 dias','WhatsApp'] },
        { id: 'power', name: 'BBrain Power', price_brl: 2990,  price_usd: 599,  features: ['Tudo do Pro','Lembrete diário','Acesso antecipado a novos recursos','Suporte prioritário'] },
      ]
    });
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
      const allowed = ['status', 'tags', 'evaluation', 'roadmap_phase', 'connections', 'text'];
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
  if (host.includes('bbrainapp.you')) {
    if (pathname === '/' || pathname === '') {
      return serveFile(res, path.join(LAB_DIR, 'landing.html'));
    }
    if (pathname === '/entrar') {
      return serveFile(res, path.join(LAB_DIR, 'index.html'));
    }
    if (pathname === '/privacidade') {
      return serveFile(res, path.join(LAB_DIR, 'privacidade.html'));
    }
    if (pathname === '/conceito') {
      return serveFile(res, path.join(LAB_DIR, 'DOCUMENTACAO', 'conceito.html'));
    }
    if (pathname === '/guia') {
      return serveFile(res, path.join(LAB_DIR, 'DOCUMENTACAO', 'guia-uso.html'));
    }
  }
  // Rotas públicas diretas (qualquer domínio)
  if (pathname === '/privacidade') {
    return serveFile(res, path.join(LAB_DIR, 'privacidade.html'));
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

  // ── GET /api/events — SSE push ──
  if (pathname === '/api/events' && method === 'GET') {
    const sseToken = url.searchParams.get('token') || getToken(req);
    if (!validToken(sseToken)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // PWA assets
  if (pathname === '/manifest.json') {
    return serveFile(res, path.join(ROOT, 'public', 'manifest.json'));
  }
  if (pathname.startsWith('/icons/')) {
    return serveFile(res, path.join(ROOT, 'public', pathname));
  }

  // Brand pages (internal, noindex)
  if (pathname === '/brand' || pathname === '/brand/') {
    return serveFile(res, path.join(ROOT, 'public', 'brand', 'index.html'));
  }
  if (pathname === '/brand/kit.html' || pathname === '/brand/kit') {
    return serveFile(res, path.join(ROOT, 'public', 'brand', 'kit.html'));
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

// ── SCHEDULER DE LEMBRETES ────────────────────────────────────────────────────
async function checkAndSendReminder() {
  const s = settingsCache;
  if (!s || !s.reminder_frequency) return;
  const freqDays = { daily:1, every2days:2, every15days:15, monthly:30 }[s.reminder_frequency];
  if (!freqDays) return;
  const now = new Date();
  const [hh, mm] = (s.reminder_time || '08:00').split(':').map(Number);
  if (now.getHours() !== hh || now.getMinutes() > mm + 5) return; // janela de 5min
  if (s.last_reminder) {
    const daysSince = (now - new Date(s.last_reminder)) / 86400000;
    if (daysSince < freqDays) return;
  }
  // Monta lembrete
  const ideas  = readIdeas().ideas;
  const roadmap = ideas.filter(i => i.status === 'no_roadmap');
  const novas   = ideas.filter(i => i.status === 'nova');
  const msg = `🧠 BBrain — Lembrete de ideias\n\nVocê tem ${novas.length} ideia(s) nova(s) e ${roadmap.length} no roadmap.\n\nAcesse: https://bbrainapp.you/laboratorio`;
  const channels = (s.reminder_channels || 'email').split(',');
  if (channels.includes('email')) {
    const auth = readAuth();
    const to = auth?.email || MASTER_ADMIN_EMAIL;
    await sendEmail(to, '🧠 BBrain — Lembrete de ideias', msg);
    console.log(`📧 Lembrete enviado para ${to}`);
  }
  settingsCache.last_reminder = now.toISOString();
  const auth = readAuth() || {};
  saveAuthToSheets(auth).catch(() => {});
}
setInterval(checkAndSendReminder, 60 * 60 * 1000); // a cada hora
