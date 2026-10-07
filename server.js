const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');
const pty = require('node-pty');
const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const app = express();

// ---------- HTTPS (потрібен браузеру для мікрофона) ----------
const TLS_DIR = path.join(__dirname, 'data', 'tls');
const TLS_CERT = process.env.UMOLK_TLS_CERT || path.join(TLS_DIR, 'cert.pem');
const TLS_KEY = process.env.UMOLK_TLS_KEY || path.join(TLS_DIR, 'key.pem');
const USE_TLS = process.env.UMOLK_HTTP !== '1';

function ensureSelfSigned() {
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) return;
  const os = require('os');
  const { execFileSync } = require('child_process');
  fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
  const ips = new Set(['127.0.0.1']);
  const dns = new Set(['localhost']);
  Object.values(os.networkInterfaces()).flat().forEach(i => { if (i && i.family === 'IPv4') ips.add(i.address); });
  (process.env.UMOLK_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean).forEach(h => {
    (/^[\d.]+$/.test(h) ? ips : dns).add(h);
  });
  const san = [...Array.from(dns).map(d => `DNS:${d}`), ...Array.from(ips).map(i => `IP:${i}`)].join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
    '-subj', '/CN=UmolkTerm', '-addext', `subjectAltName=${san}`,
    '-keyout', TLS_KEY, '-out', TLS_CERT], { stdio: 'ignore' });
  try { fs.chmodSync(TLS_KEY, 0o600); } catch (e) {}
  console.log(`🔒 Згенеровано самопідписаний TLS-сертифікат (${san})`);
}

let server;
if (USE_TLS) {
  ensureSelfSigned();
  server = require('https').createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app);
} else {
  server = http.createServer(app);
}

const PORT = process.env.PORT || 7681;
const DATA_DIR = path.join(__dirname, 'data');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SNIPPETS_FILE = path.join(DATA_DIR, 'snippets.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function writeSecure(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) {}
}

if (!fs.existsSync(CONNECTIONS_FILE)) writeSecure(CONNECTIONS_FILE, '[]');
if (!fs.existsSync(SNIPPETS_FILE)) writeSecure(SNIPPETS_FILE, '[]');

function getSnippets() {
  try {
    return JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8'));
  } catch (err) {
    return [];
  }
}

function saveSnippets(snippets) {
  writeSecure(SNIPPETS_FILE, JSON.stringify(snippets, null, 2));
}

// ---------- AUTH ----------
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}

function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  writeSecure(AUTH_FILE, JSON.stringify({ salt, hash: hashPassword(pw, salt) }));
}

if (process.env.UMOLK_PASSWORD) {
  setPassword(process.env.UMOLK_PASSWORD);
} else if (!fs.existsSync(AUTH_FILE)) {
  const generated = crypto.randomBytes(9).toString('base64url');
  setPassword(generated);
  console.log('=======================================================');
  console.log(' 🔑 Згенеровано пароль для входу в UmolkTerm:');
  console.log(`    ${generated}`);
  console.log(' Змінити: UMOLK_PASSWORD=новий_пароль node server.js');
  console.log('=======================================================');
}

if (!fs.existsSync(SECRET_FILE)) writeSecure(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

function getAuthData() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveAuthData(data) {
  writeSecure(AUTH_FILE, JSON.stringify(data, null, 2));
}

function checkPassword(pw) {
  try {
    const { salt, hash } = getAuthData();
    if (!salt || !hash) return false;
    const a = Buffer.from(hashPassword(String(pw || ''), salt), 'hex');
    return crypto.timingSafeEqual(a, Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}

function isTwoFactorEnabled() {
  const auth = getAuthData();
  return Boolean(auth.totpSecret && auth.totpEnabled);
}

function verifyTwoFactor(token) {
  const auth = getAuthData();
  if (!auth.totpSecret) return false;
  try {
    return authenticator.check(String(token || '').trim(), auth.totpSecret);
  } catch (e) {
    return false;
  }
}

function signToken(exp) {
  const mac = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  return `${exp}.${mac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
  if (good.length !== mac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(good), Buffer.from(mac));
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  return verifyToken(parseCookies(req.headers.cookie).umolk_session);
}

// Login rate limiting (per IP)
const loginFails = new Map();
function rateLimited(ip) {
  const rec = loginFails.get(ip);
  return rec && rec.count >= 5 && Date.now() < rec.until;
}
function registerFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  rec.until = Date.now() + 5 * 60 * 1000;
  loginFails.set(ip, rec);
}

// One-time tickets for quick-connect (keeps passwords out of URLs/logs)
const tickets = new Map();
function createTicket(cfg) {
  const t = crypto.randomBytes(16).toString('hex');
  tickets.set(t, { cfg, exp: Date.now() + 60000 });
  return t;
}
function takeTicket(t) {
  const rec = tickets.get(t);
  tickets.delete(t);
  return rec && rec.exp > Date.now() ? rec.cfg : null;
}

const wss = new WebSocket.Server({
  server,
  path: '/terminal',
  verifyClient: (info, done) => {
    done(isAuthed(info.req), 401, 'Unauthorized');
  }
});

// Helpers for data reading/writing
function getConnections() {
  try {
    const data = fs.readFileSync(CONNECTIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function saveConnections(conns) {
  writeSecure(CONNECTIONS_FILE, JSON.stringify(conns, null, 2));
}

function getKeys() {
  try {
    const data = fs.readFileSync(KEYS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function saveKeys(keys) {
  writeSecure(KEYS_FILE, JSON.stringify(keys, null, 2));
}

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    aiModel: 'auto',
    theme: 'umolk',
    fontSize: 15,
    fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, monospace"
  };
}

function saveSettings(settings) {
  writeSecure(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// Public assets needed by the login page
app.use('/fonts', express.static(path.join(__dirname, 'public/fonts')));
app.get('/login.css', (req, res) => res.sendFile(path.join(__dirname, 'public/login.css')));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    success: true,
    twoFactorEnabled: isTwoFactorEnabled()
  });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (rateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'Забагато спроб. Спробуйте через 5 хвилин.' });
  }
  const { password, twoFactorCode } = req.body || {};
  if (!checkPassword(password)) {
    registerFail(ip);
    return res.status(401).json({ success: false, error: 'Невірний пароль' });
  }

  if (isTwoFactorEnabled()) {
    if (!twoFactorCode) {
      return res.json({ success: false, requireTwoFactor: true });
    }
    if (!verifyTwoFactor(twoFactorCode)) {
      registerFail(ip);
      return res.status(401).json({ success: false, requireTwoFactor: true, error: 'Невірний 2FA код Google Authenticator' });
    }
  }

  loginFails.delete(ip);
  const token = signToken(Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie',
    `umolk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${req.secure ? '; Secure' : ''}`);
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'umolk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ success: true });
});

// Everything below requires authentication
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, error: 'Потрібна авторизація' });
  res.redirect('/login');
});

// Quick connect: exchange credentials for a one-time ticket
app.post('/api/quick-ticket', (req, res) => {
  const { host, port, username, password } = req.body || {};
  if (!host || !username) return res.status(400).json({ success: false, error: 'Не вказано хост або користувача' });
  res.json({ success: true, ticket: createTicket({ host, port: parseInt(port, 10) || 22, username, password: password || '', authType: 'password' }) });
});

// ---------- ГОЛОС: Whisper (якщо є ключ OpenAI) ----------
app.post('/api/voice/transcribe',
  express.raw({ type: () => true, limit: '15mb' }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {
      return res.status(400).json({ success: false, error: 'Порожній аудіозапис' });
    }
    try {
      const mime = (req.headers['content-type'] || 'audio/webm').split(';')[0];
      const r = await fetch('http://127.0.0.1:7682/transcribe?lang=uk', {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: req.body
      });
      const data = await r.json();
      if (!r.ok) {
        return res.status(502).json({ success: false, error: data.error || 'Помилка локального Whisper' });
      }
      res.json({ success: true, text: (data.text || '').trim() });
    } catch (e) {
      res.status(502).json({ success: false, error: `Local Whisper: ${e.message}` });
    }
  });

// Static assets
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use(express.static(path.join(__dirname, 'public')));

// REST API for connections
app.get('/api/connections', (req, res) => {
  const list = getConnections().map(c => {
    // Mask sensitive secrets in client listing
    const { password, privateKey, ...safe } = c;
    return {
      ...safe,
      hasPassword: Boolean(password),
      hasPrivateKey: Boolean(privateKey)
    };
  });
  res.json({ success: true, connections: list });
});

app.post('/api/connections', (req, res) => {
  const { name, host, port, username, authType, password, privateKey, keyId, passphrase, group, color, notes } = req.body;
  if (!name || !host || !username) {
    return res.status(400).json({ success: false, error: "Обов'язкові поля: назва, хост та користувач" });
  }

  const connections = getConnections();
  const newConn = {
    id: uuidv4(),
    name: name.trim(),
    host: host.trim(),
    port: parseInt(port, 10) || 22,
    username: username.trim(),
    authType: authType || 'password',
    password: password || '',
    privateKey: privateKey || '',
    keyId: keyId || '',
    passphrase: passphrase || '',
    group: group ? group.trim() : 'Servers',
    color: color || '#bd93f9',
    notes: notes || '',
    createdAt: new Date().toISOString()
  };

  connections.push(newConn);
  saveConnections(connections);

  const { password: _, privateKey: __, ...safe } = newConn;
  res.json({ success: true, connection: safe });
});

app.put('/api/connections/:id', (req, res) => {
  const id = req.params.id;
  const connections = getConnections();
  const index = connections.findIndex(c => c.id === id);
  if (index === -1) {
    return res.status(400).json({ success: false, error: 'Підключення не знайдено' });
  }

  const old = connections[index];
  const update = req.body;

  connections[index] = {
    ...old,
    name: update.name !== undefined ? update.name.trim() : old.name,
    host: update.host !== undefined ? update.host.trim() : old.host,
    port: update.port !== undefined ? (parseInt(update.port, 10) || 22) : old.port,
    username: update.username !== undefined ? update.username.trim() : old.username,
    authType: update.authType !== undefined ? update.authType : old.authType,
    password: update.password !== undefined ? update.password : old.password,
    privateKey: update.privateKey !== undefined ? update.privateKey : old.privateKey,
    keyId: update.keyId !== undefined ? update.keyId : old.keyId,
    passphrase: update.passphrase !== undefined ? update.passphrase : old.passphrase,
    group: update.group !== undefined ? update.group.trim() : old.group,
    color: update.color !== undefined ? update.color : old.color,
    notes: update.notes !== undefined ? update.notes : old.notes,
    updatedAt: new Date().toISOString()
  };

  saveConnections(connections);
  const { password: _, privateKey: __, ...safe } = connections[index];
  res.json({ success: true, connection: safe });
});

app.delete('/api/connections/:id', (req, res) => {
  const id = req.params.id;
  let connections = getConnections();
  const initialLen = connections.length;
  connections = connections.filter(c => c.id !== id);

  if (connections.length === initialLen) {
    return res.status(404).json({ success: false, error: 'Підключення не знайдено' });
  }

  saveConnections(connections);
  res.json({ success: true, message: 'Видалено успішно' });
});

// Keys API
app.get('/api/keys', (req, res) => {
  const list = getKeys().map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }));
  res.json({ success: true, keys: list });
});

app.post('/api/keys', (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) return res.status(400).json({ success: false, error: 'Назва та контент обов\'язкові' });
  const keys = getKeys();
  const newKey = { id: uuidv4(), name: name.trim(), content, createdAt: new Date().toISOString() };
  keys.push(newKey);
  saveKeys(keys);
  res.json({ success: true, key: { id: newKey.id, name: newKey.name, createdAt: newKey.createdAt } });
});

app.delete('/api/keys/:id', (req, res) => {
  const id = req.params.id;
  let keys = getKeys();
  const initialLen = keys.length;
  keys = keys.filter(k => k.id !== id);
  if (keys.length === initialLen) return res.status(404).json({ success: false, error: 'Ключ не знайдено' });
  saveKeys(keys);
  res.json({ success: true, message: 'Видалено успішно' });
});

// ---------- SNIPPETS API ----------
app.get('/api/snippets', (req, res) => {
  res.json({ success: true, snippets: getSnippets() });
});

app.post('/api/snippets', (req, res) => {
  const { title, command, group } = req.body || {};
  if (!command) return res.status(400).json({ success: false, error: 'Команда обов\'язкова' });
  const snippets = getSnippets();
  const newSnippet = {
    id: uuidv4(),
    title: (title || '').trim() || command.trim().slice(0, 30),
    command: command.trim(),
    group: (group || '').trim() || 'Загальні',
    createdAt: new Date().toISOString()
  };
  snippets.push(newSnippet);
  saveSnippets(snippets);
  res.json({ success: true, snippet: newSnippet });
});

app.put('/api/snippets/:id', (req, res) => {
  const id = req.params.id;
  const snippets = getSnippets();
  const idx = snippets.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Сніппет не знайдено' });
  const { title, command, group } = req.body || {};
  snippets[idx] = {
    ...snippets[idx],
    title: title !== undefined ? title.trim() : snippets[idx].title,
    command: command !== undefined ? command.trim() : snippets[idx].command,
    group: group !== undefined ? group.trim() : snippets[idx].group,
    updatedAt: new Date().toISOString()
  };
  saveSnippets(snippets);
  res.json({ success: true, snippet: snippets[idx] });
});

app.delete('/api/snippets/:id', (req, res) => {
  const id = req.params.id;
  let snippets = getSnippets();
  const initLen = snippets.length;
  snippets = snippets.filter(s => s.id !== id);
  if (snippets.length === initLen) return res.status(404).json({ success: false, error: 'Сніппет не знайдено' });
  saveSnippets(snippets);
  res.json({ success: true, message: 'Сніппет видалено' });
});

// ---------- 2FA GOOGLE AUTHENTICATOR API ----------
app.get('/api/2fa/status', (req, res) => {
  res.json({
    success: true,
    enabled: isTwoFactorEnabled()
  });
});

app.post('/api/2fa/setup', async (req, res) => {
  try {
    const auth = getAuthData();
    const secret = authenticator.generateSecret();
    auth.totpPendingSecret = secret;
    saveAuthData(auth);

    const otpauth = authenticator.keyuri('UmolkTerm', 'UmolkTerm Admin', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    res.json({
      success: true,
      secret,
      qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/2fa/enable', (req, res) => {
  const { code } = req.body || {};
  const auth = getAuthData();
  if (!auth.totpPendingSecret) {
    return res.status(400).json({ success: false, error: 'Спочатку ініціалізуйте налаштування 2FA' });
  }
  const isValid = authenticator.check(String(code || '').trim(), auth.totpPendingSecret);
  if (!isValid) {
    return res.status(400).json({ success: false, error: 'Невірний 6-значний код Google Authenticator' });
  }
  auth.totpSecret = auth.totpPendingSecret;
  auth.totpEnabled = true;
  delete auth.totpPendingSecret;
  saveAuthData(auth);
  res.json({ success: true, message: 'Google 2FA успішно активовано!' });
});

app.post('/api/2fa/disable', (req, res) => {
  const { password, code } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ success: false, error: 'Невірний пароль для підтвердження' });
  }
  if (!verifyTwoFactor(code)) {
    return res.status(400).json({ success: false, error: 'Невірний код 2FA для відключення' });
  }
  const auth = getAuthData();
  delete auth.totpSecret;
  delete auth.totpEnabled;
  delete auth.totpPendingSecret;
  saveAuthData(auth);
  res.json({ success: true, message: '2FA успішно вимкнено' });
});

// Test SSH connection
app.post('/api/connections/test', (req, res) => {
  let { host, port, username, authType, password, privateKey, keyId, passphrase, id } = req.body;

  if (id && (!host || !username)) {
    const conn = getConnections().find(c => c.id === id);
    if (conn) {
      host = conn.host;
      port = conn.port;
      username = conn.username;
      authType = conn.authType;
      password = conn.password;
      privateKey = conn.privateKey;
      keyId = conn.keyId;
      passphrase = conn.passphrase;
    }
  }
  
  if (keyId) {
    const k = getKeys().find(x => x.id === keyId);
    if (k) privateKey = k.content;
  }

  if (!host || !username) {
    return res.status(400).json({ success: false, error: 'Не вказано хост або користувача' });
  }

  const conn = new Client();
  let finished = false;

  const timeout = setTimeout(() => {
    if (!finished) {
      finished = true;
      try { conn.end(); } catch(e) {}
      res.json({ success: false, error: 'Час очікування підключення вичерпано (Timeout 8s)' });
    }
  }, 8000);

  conn.on('ready', () => {
    if (!finished) {
      finished = true;
      clearTimeout(timeout);
      conn.end();
      res.json({ success: true, message: 'Успішне підключення до сервера!' });
    }
  });

  conn.on('error', (err) => {
    if (!finished) {
      finished = true;
      clearTimeout(timeout);
      res.json({ success: false, error: `Помилка SSH: ${err.message}` });
    }
  });

  try {
    const config = {
      host,
      port: parseInt(port, 10) || 22,
      username,
      readyTimeout: 7000
    };

    if (authType === 'key' && privateKey) {
      config.privateKey = privateKey;
      if (passphrase) config.passphrase = passphrase;
    } else if (password) {
      config.password = password;
    }

    conn.connect(config);
  } catch (err) {
    clearTimeout(timeout);
    res.json({ success: false, error: err.message });
  }
});

// Settings API
app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  const { openaiApiKey, geminiApiKey, ...safeSettings } = settings;
  res.json({
    success: true,
    settings: {
      ...safeSettings,
      hasOpenaiKey: Boolean(settings.openaiApiKey || process.env.OPENAI_API_KEY),
      hasGeminiKey: Boolean(settings.geminiApiKey || process.env.GEMINI_API_KEY)
    }
  });
});

app.get('/api/export', (req, res) => {
  res.json({
    success: true,
    connections: getConnections(),
    keys: getKeys(),
    snippets: getSnippets()
  });
});

app.post('/api/import', (req, res) => {
  const { connections, keys, snippets } = req.body;
  
  if (Array.isArray(keys)) {
    const existing = getKeys();
    keys.forEach(k => {
      const idx = existing.findIndex(e => e.id === k.id);
      if (idx > -1) existing[idx] = k;
      else existing.push(k);
    });
    saveKeys(existing);
  }
  
  if (Array.isArray(connections)) {
    const existing = getConnections();
    connections.forEach(c => {
      const idx = existing.findIndex(e => e.id === c.id);
      if (idx > -1) existing[idx] = c;
      else existing.push(c);
    });
    saveConnections(existing);
  }

  if (Array.isArray(snippets)) {
    const existing = getSnippets();
    snippets.forEach(s => {
      const idx = existing.findIndex(e => e.id === s.id);
      if (idx > -1) existing[idx] = s;
      else existing.push(s);
    });
    saveSnippets(existing);
  }
  
  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  const current = getSettings();
  const updated = {
    ...current,
    ...req.body
  };
  saveSettings(updated);
  const { openaiApiKey, geminiApiKey, ...safeUpdated } = updated;
  res.json({ success: true, settings: safeUpdated });
});

app.post('/api/settings/whisper', (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ success: false, error: 'Модель не вказана' });
  
  // Write to .env
  let envContent = '';
  if (require('fs').existsSync('.env')) envContent = require('fs').readFileSync('.env', 'utf8');
  
  const lines = envContent.split('\n').filter(l => !l.startsWith('UMOLK_WHISPER_MODEL='));
  lines.push(`UMOLK_WHISPER_MODEL="${model}"`);
  require('fs').writeFileSync('.env', lines.join('\n'));
  
  // Kill whisper worker and spawn it again
  require('child_process').exec("pkill -f 'whisper/worker.py' || true; nohup whisper/venv/bin/python whisper/worker.py > whisper.log 2>&1 &", (err) => {
    if (err) console.error("Помилка перезапуску воркера:", err);
  });
  
  res.json({ success: true, message: 'Модель змінено. Воркер перезапускається у фоні.' });
});

// AI Copilot endpoint
app.post('/api/ai/ask', async (req, res) => {
  const { prompt, model: requestedModel } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, error: 'Введіть запит' });
  }

  const settings = getSettings();
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY;
  const geminiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;

  // 1. If OpenAI key is available and requested
  if (openaiKey && (requestedModel === 'openai' || requestedModel === 'auto')) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Ти — помічник системного адміністратора Linux. Користувач задає питання або описує завдання українською мовою. 
Відповідай ВИКЛЮЧНО валідним JSON форматом:
{
  "command": "команда bash/zsh для терміналу",
  "explanation": "коротке чітке пояснення (1-3 речення) українською",
  "warning": "попередження, якщо команда небезпечна (або null)"
}`
            },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1
        })
      });

      if (response.ok) {
        const data = await response.json();
        const parsed = JSON.parse(data.choices[0].message.content);
        return res.json({ success: true, source: 'openai', ...parsed });
      }
    } catch (e) {
      console.error('OpenAI API error:', e.message);
    }
  }

  // 2. If Gemini key is available and requested
  if (geminiKey && (requestedModel === 'gemini' || requestedModel === 'auto')) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Ти — експерт Linux та ZSH. Згенеруй команду для запиту: "${prompt}".
Відповідай JSON:
{
  "command": "команда",
  "explanation": "пояснення українською",
  "warning": null
}`
            }]
          }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          return res.json({ success: true, source: 'gemini', ...parsed });
        }
      }
    } catch (e) {
      console.error('Gemini API error:', e.message);
    }
  }

  // 3. Built-in Smart Intelligent Heuristic Model (always works offline/without key!)
  const lower = prompt.toLowerCase();
  let cmd = '';
  let exp = '';
  let warning = null;

  if (lower.includes('порт') || lower.includes('port')) {
    cmd = 'sudo ss -tulpn | grep LISTEN';
    exp = 'Показує всі активні відкриті порти та процеси, які їх слухають.';
  } else if (lower.includes('пам') || lower.includes('ram') || lower.includes('memory')) {
    cmd = 'free -h --si';
    exp = 'Виводить поточне використання оперативної пам’яті (RAM) та Swap у зрозумілому форматі.';
  } else if (lower.includes('диск') || lower.includes('місц') || lower.includes('disk') || lower.includes('df')) {
    cmd = 'df -h -x tmpfs -x devtmpfs';
    exp = 'Відображає вільне та зайняте місце на всіх підключених дисках і розділах.';
  } else if (lower.includes('топ') || lower.includes('процес') || lower.includes('навантаж') || lower.includes('cpu')) {
    cmd = 'ps aux --sort=-%cpu | head -n 15';
    exp = 'Список топ-15 процесів, які найбільше навантажують процесор.';
  } else if (lower.includes('великі файл') || lower.includes('знайти файл') || lower.includes('пошук файл')) {
    cmd = 'find . -type f -size +100M -exec ls -lh {} + 2>/dev/null';
    exp = 'Шукає всі файли розміром понад 100 МБ у поточному каталозі та підкаталогах.';
  } else if (lower.includes('перезавантаж') || lower.includes('reboot')) {
    cmd = 'sudo systemctl reboot';
    exp = 'Перезавантаження сервера.';
    warning = 'Увага! Сервер буде перезавантажено негайно, поточні сесії закриються.';
  } else if (lower.includes('docker') && (lower.includes('контейнер') || lower.includes('список') || lower.includes('ps'))) {
    cmd = 'docker ps -a --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"';
    exp = 'Виводить компактну таблицю всіх запущених та зупинених Docker-контейнерів.';
  } else if (lower.includes('лог') || lower.includes('log') || lower.includes('journal')) {
    cmd = 'sudo journalctl -xe -n 50';
    exp = 'Показує останні 50 системних записів журналу systemd з детальними помилками.';
  } else if (lower.includes('онов') || lower.includes('update') || lower.includes('upgrade')) {
    cmd = 'sudo apt update && sudo apt upgrade -y';
    exp = 'Оновлення списку пакетів репозиторіїв та встановлення оновлень програмного забезпечення.';
  } else if (lower.includes('ip') || lower.includes('айпі') || lower.includes('адрес') || lower.includes('мережа')) {
    cmd = 'ip -brief address show && curl -s ifconfig.me';
    exp = 'Показує внутрішні мережеві IP-адреси інтерфейсів та зовнішню публічну IP-адресу.';
  } else if (lower.includes('користувач') || lower.includes('user') || lower.includes('who')) {
    cmd = 'w';
    exp = 'Показує користувачів, які зараз залогінені в системі, та їхню активність.';
  } else if (lower.includes('очистити') || lower.includes('сміття') || lower.includes('кеш')) {
    cmd = 'sudo apt clean && sudo apt autoremove --purge -y';
    exp = 'Очищення кешу завантажених пакетів apt та видалення невикористовуваних залежностей.';
  } else if (lower.includes('zsh') || lower.includes('оболонк') || lower.includes('shell')) {
    cmd = 'echo $SHELL && zsh --version';
    exp = 'Перевіряє поточну оболонку та встановлену версію ZSH.';
  } else {
    // Generates a general helpful command based on keywords
    cmd = `man -k "${prompt.replace(/["\\]/g, '')}" 2>/dev/null || apropos "${prompt.replace(/["\\]/g, '')}"`;
    exp = `Шукає системні команди та довідку, пов'язані з запитом: "${prompt}".`;
  }

  res.json({
    success: true,
    source: 'builtin-smart',
    command: cmd,
    explanation: exp,
    warning: warning,
    hint: !openaiKey && !geminiKey ? 'Підказка: додайте OpenAI або Gemini API Key у Налаштуваннях для повного розуміння довільних запитів!' : null
  });
});

// WebSocket Terminal handler
wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const connType = urlObj.searchParams.get('type') || 'local'; // 'local' or 'ssh'
  const connId = urlObj.searchParams.get('id');

  let ptyProcess = null;
  let sshClient = null;
  let sshStream = null;

  // Local ZSH session
  if (connType === 'local') {
    const shell = fs.existsSync('/usr/bin/zsh') ? '/usr/bin/zsh' : (process.env.SHELL || '/bin/bash');
    
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: process.env.HOME || '/home/admin',
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !['UMOLK_PASSWORD','OPENAI_API_KEY','GEMINI_API_KEY'].includes(k))),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8'
        }
      });

      ptyProcess.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }));
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode, signal }));
          ws.close();
        }
      });

      ws.send(JSON.stringify({
        type: 'connected',
        title: 'Local ZSH',
        shell: shell
      }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: `Помилка запуску локальної оболонки: ${err.message}` }));
      ws.close();
      return;
    }
  } 
  // Remote SSH session
  else if (connType === 'ssh') {
    let host = null;
    let port = 22;
    let username = null;
    let password = null;
    let authType = 'password';
    let privateKey = null;
    let passphrase = null;

    const ticket = urlObj.searchParams.get('ticket');
    if (ticket) {
      const cfg = takeTicket(ticket);
      if (!cfg) {
        ws.send(JSON.stringify({ type: 'error', message: 'Тікет підключення недійсний або прострочений' }));
        ws.close();
        return;
      }
      ({ host, port, username, password, authType } = cfg);
    } else if (connId) {
      const saved = getConnections().find(c => c.id === connId);
      if (saved) {
        host = saved.host;
        port = saved.port;
        username = saved.username;
        authType = saved.authType;
        password = saved.password;
        privateKey = saved.privateKey;
        passphrase = saved.passphrase;
        if (saved.keyId) {
          const k = getKeys().find(x => x.id === saved.keyId);
          if (k) privateKey = k.content;
        }
      } else {
        ws.send(JSON.stringify({ type: 'error', message: `SSH підключення з ID ${connId} не знайдено` }));
        ws.close();
        return;
      }
    }

    if (!host || !username) {
      ws.send(JSON.stringify({ type: 'error', message: 'Не вказано хост або користувача SSH' }));
      ws.close();
      return;
    }

    ws.send(JSON.stringify({
      type: 'status',
      message: `\r\n\x1b[38;2;189;147;249m[UmolkTerm]\x1b[0m Підключення до \x1b[1;36m${username}@${host}:${port}\x1b[0m...\r\n`
    }));

    sshClient = new Client();

    sshClient.on('ready', () => {
      ws.send(JSON.stringify({
        type: 'status',
        message: `\x1b[38;2;80;250;123m✓ SSH з'єднання встановлено успішно!\x1b[0m Запуск інтерактивної оболонки...\r\n`
      }));

      sshClient.shell({
        term: 'xterm-256color',
        cols: 100,
        rows: 30
      }, (err, stream) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Помилка відкриття shell: ${err.message}` }));
          ws.close();
          return;
        }

        sshStream = stream;

        ws.send(JSON.stringify({
          type: 'connected',
          title: `${username}@${host}`,
          remote: true
        }));

        stream.on('data', (data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', data: data.toString('utf8') }));
          }
        });

        stream.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', message: 'SSH сесія завершена.' }));
            ws.close();
          }
          sshClient.end();
        });
      });
    });

    sshClient.on('error', (err) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: `\r\n\x1b[38;2;255;85;85m[Помилка SSH]\x1b[0m ${err.message}\r\n`
        }));
        ws.close();
      }
    });

    sshClient.on('end', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', message: 'SSH відключено.' }));
      }
    });

    try {
      const sshOpts = {
        host,
        port,
        username,
        readyTimeout: 10000,
        keepaliveInterval: 15000
      };

      if (authType === 'key' && privateKey) {
        sshOpts.privateKey = privateKey;
        if (passphrase) sshOpts.passphrase = passphrase;
      } else if (password) {
        sshOpts.password = password;
      }

      sshClient.connect(sshOpts);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: `Помилка ініціалізації SSH: ${e.message}` }));
      ws.close();
    }
  }

  // Incoming client messages
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'input') {
        if (ptyProcess) {
          ptyProcess.write(msg.data);
        } else if (sshStream) {
          sshStream.write(msg.data);
        }
      } else if (msg.type === 'resize') {
        const cols = parseInt(msg.cols, 10) || 80;
        const rows = parseInt(msg.rows, 10) || 24;
        if (ptyProcess) {
          ptyProcess.resize(cols, rows);
        } else if (sshStream) {
          sshStream.setWindow(rows, cols, 0, 0);
        }
      }
    } catch (err) {
      console.error('WebSocket message parsing error:', err);
    }
  });

  ws.on('close', () => {
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch(e) {}
    }
    if (sshStream) {
      try { sshStream.end(); } catch(e) {}
    }
    if (sshClient) {
      try { sshClient.end(); } catch(e) {}
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🦇 UmolkTerm запущено на:`);
  const scheme = USE_TLS ? 'https' : 'http';
  console.log(`   ${scheme}://localhost:${PORT}`);
  console.log(`   Shell за замовчуванням: /usr/bin/zsh`);
  console.log(`=======================================================`);
});
