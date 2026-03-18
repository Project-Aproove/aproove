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

const http = require('http');
const fs   = require('fs');
const path = require('path');

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
const PROD_DIR     = path.join(ROOT, 'producao');
const TESTE_DIR    = path.join(ROOT, 'teste');
const LAB_DIR      = path.join(ROOT, 'laboratorio');
const VERSION_FILE  = path.join(ROOT, 'version.json');
const IDEAS_FILE    = path.join(ROOT, 'ideas.json');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');

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

// ── IDEAS ─────────────────────────────────────────────────────────────────────
function readIdeas() {
  try { return JSON.parse(fs.readFileSync(IDEAS_FILE, 'utf8')); }
  catch { return { ideas: [], meta: { total:0, on_roadmap:0, archived:0, from_whatsapp:0 } }; }
}

function writeIdeas(data) {
  data.meta = {
    total: data.ideas.length,
    on_roadmap: data.ideas.filter(i => i.status === 'no_roadmap').length,
    archived: data.ideas.filter(i => i.status === 'arquivada').length,
    from_whatsapp: data.ideas.filter(i => i.source === 'whatsapp').length,
    last_updated: new Date().toISOString().slice(0, 10)
  };
  fs.writeFileSync(IDEAS_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${Date.now().toString(36).slice(-5).toUpperCase()}`;
}

// ── SESSIONS (BBrain — Diário do Fundador) ────────────────────────────────────
function readSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return { sessions: [], meta: { total_sessions: 0, total_hours: 0, locations: [], last_session: null } }; }
}

function writeSessions(data) {
  const total   = data.sessions.length;
  const totMin  = data.sessions.reduce((a, s) => a + (s.duration_minutes || 0), 0);
  const locs    = [...new Set(data.sessions.map(s => s.location).filter(Boolean))];
  const last    = data.sessions[0]?.started_at || null;
  data.meta = { total_sessions: total, total_hours: Math.round(totMin / 60 * 10) / 10, locations: locs, last_session: last };
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

// ── WHATSAPP META CLOUD API ───────────────────────────────────────────────────
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WA_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WA_PHONE_ID     = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

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
        id: generateId(),
        text: payload.text.trim(),
        source: payload.source || 'web',
        whatsapp_from: null,
        created_at: new Date().toISOString(),
        status: 'nova',
        tags: payload.tags || [],
        evaluation: null,
        roadmap_phase: null,
        connections: []
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
        ended_at: null,
        location: payload.location.trim(),
        initial_thoughts: payload.initial_thoughts?.trim() || null,
        duration_minutes: null,
        features_worked: [],
        ideas_captured: [],
        social_content: null
      };
      data.sessions.unshift(session);
      writeSessions(data);
      console.log(`📓 BBrain → sessão iniciada em "${session.location}"`);
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
server.listen(PORT, () => {
  const v        = readVersion().version;
  const ideas    = readIdeas();
  const sess     = readSessions();
  const waOk     = !!(WA_ACCESS_TOKEN && WA_PHONE_ID);
  const aiOk     = !!process.env.ANTHROPIC_API_KEY;

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
║  WhatsApp:           ${(waOk ? '✓ Configurado' : '✗ Não configurado').padEnd(35)}║
║  Claude AI:          ${(aiOk ? '✓ Configurado' : '✗ Não configurado (opcional)').padEnd(35)}║
╠═══════════════════════════════════════════════════════╣
║  Webhook WhatsApp:   POST /webhook/whatsapp           ║
║  API deploy:         POST /api/deploy                 ║
╚═══════════════════════════════════════════════════════╝
`);
});
