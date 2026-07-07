const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, isJidUser } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

const logs = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 200) logs.shift();
}

log('Iniciando servidor...');
log(`Node: ${process.version}`);
log(`Platform: ${process.platform}`);
log(`Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);

// ===== DATA FILES =====
const CONTACTS_PATH = path.join(__dirname, 'contacts.json');
const CONVERSATIONS_PATH = path.join(__dirname, 'conversations.json');
const SETTINGS_PATH = path.join(__dirname, 'database', 'settings.json');
const SAVED_CONTACTS_PATH = path.join(__dirname, 'database', 'saved-contacts.json');
const PREDEFINED_TEXTS_PATH = path.join(__dirname, 'database', 'predefined-texts.json');
const BOT_KNOWLEDGE_PATH = path.join(__dirname, 'bot-knowledge.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let contacts = loadJSON(CONTACTS_PATH, []);
let conversations = loadJSON(CONVERSATIONS_PATH, {});
let savedContacts = loadJSON(SAVED_CONTACTS_PATH, []);
let predefinedTexts = loadJSON(PREDEFINED_TEXTS_PATH, []);
let settings = loadJSON(SETTINGS_PATH, { calls: { enabled: true } });
let botKnowledge = loadJSON(BOT_KNOWLEDGE_PATH, {});

function saveContacts() { saveJSON(CONTACTS_PATH, contacts); }
function saveConversations() { saveJSON(CONVERSATIONS_PATH, conversations); }
function saveSavedContacts() { saveJSON(SAVED_CONTACTS_PATH, savedContacts); }
function savePredefinedTexts() { saveJSON(PREDEFINED_TEXTS_PATH, predefinedTexts); }
function saveSettings() { saveJSON(SETTINGS_PATH, settings); }

// ===== HELPERS =====
function normalizeNumber(value) {
  const raw = String(value || '').trim();
  if (raw.includes('@')) return raw.replace(/@c\.us|@g\.us|@lid/g, '');
  return raw.replace(/\D/g, '').replace(/^00/, '');
}

function toChatId(number) {
  return `${normalizeNumber(number)}@c.us`;
}

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function upsertContact(number, name, lastMessage, lastInteraction, incoming = false) {
  const num = normalizeNumber(number);
  const existing = contacts.find(c => normalizeNumber(c.number) === num);
  const ts = lastInteraction || new Date().toISOString();

  if (existing) {
    existing.name = name || existing.name || num;
    existing.lastMessage = lastMessage || existing.lastMessage || '';
    existing.lastInteraction = ts;
    existing.unreadCount = incoming ? (existing.unreadCount || 0) + 1 : 0;
  } else {
    contacts.push({
      number: num, name: name || num, lastMessage,
      lastInteraction: ts, unreadCount: incoming ? 1 : 0,
      botEnabled: true, notes: ''
    });
  }
  saveContacts();
}

function emitContacts() {
  contacts.sort((a, b) => new Date(b.lastInteraction || 0) - new Date(a.lastInteraction || 0));
  io.emit('contacts', contacts);
}

// ===== ROUTES =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
  res.json({
    node: process.version, platform: process.platform,
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    whatsappStatus: status, hasQR: !!qrCodeDataURL,
    contacts: contacts.length, logs: logs.slice(-30)
  });
});

app.get('/api/saved-contacts', (req, res) => res.json(savedContacts));
app.post('/api/saved-contacts', (req, res) => {
  const c = { id: `sc_${Date.now()}`, ...req.body, createdAt: new Date().toISOString() };
  savedContacts.push(c); saveSavedContacts(); res.json({ success: true, contact: c });
});
app.put('/api/saved-contacts/:id', (req, res) => {
  const i = savedContacts.findIndex(c => c.id === req.params.id);
  if (i === -1) return res.status(404).json({ success: false });
  savedContacts[i] = { ...savedContacts[i], ...req.body }; saveSavedContacts();
  res.json({ success: true });
});
app.delete('/api/saved-contacts/:id', (req, res) => {
  savedContacts = savedContacts.filter(c => c.id !== req.params.id);
  saveSavedContacts(); res.json({ success: true });
});

app.get('/api/predefined-texts', (req, res) => res.json(predefinedTexts));
app.post('/api/predefined-texts', (req, res) => {
  const t = { id: `pt_${Date.now()}`, useCount: 0, ...req.body };
  predefinedTexts.push(t); savePredefinedTexts(); res.json({ success: true, text: t });
});
app.put('/api/predefined-texts/:id', (req, res) => {
  const i = predefinedTexts.findIndex(t => t.id === req.params.id);
  if (i === -1) return res.status(404).json({ success: false });
  predefinedTexts[i] = { ...predefinedTexts[i], ...req.body }; savePredefinedTexts();
  res.json({ success: true });
});
app.delete('/api/predefined-texts/:id', (req, res) => {
  predefinedTexts = predefinedTexts.filter(t => t.id !== req.params.id);
  savePredefinedTexts(); res.json({ success: true });
});

app.get('/api/settings', (req, res) => res.json(settings));
app.put('/api/settings', (req, res) => {
  settings = { ...settings, ...req.body }; saveSettings();
  res.json({ success: true, settings });
});

app.get('/api/conversations', (req, res) => res.json(conversations));
app.get('/api/conversations/:number', (req, res) => {
  res.json(conversations[normalizeNumber(req.params.number)] || []);
});
app.delete('/api/conversations/:number', (req, res) => {
  delete conversations[normalizeNumber(req.params.number)]; saveConversations();
  res.json({ success: true });
});

// ===== BOT STATE =====
let qrCodeDataURL = null;
let status = 'starting';
let sock = null;

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  log('Cliente web conectado: ' + socket.id);
  socket.emit('status', status);
  socket.emit('contacts', contacts);
  socket.emit('conversations', conversations);

  if (qrCodeDataURL && status === 'qr') {
    socket.emit('qr-code', qrCodeDataURL);
  }

  socket.on('disconnect', () => log('Cliente web desconectado'));

  socket.on('mark-read', (data) => {
    const num = normalizeNumber(data.number);
    const c = contacts.find(x => normalizeNumber(x.number) === num);
    if (c) { c.unreadCount = 0; saveContacts(); emitContacts(); }
  });

  socket.on('toggle-read-status', (data) => {
    const num = normalizeNumber(data.number);
    const c = contacts.find(x => normalizeNumber(x.number) === num);
    if (c) { c.unreadCount = c.unreadCount > 0 ? 0 : 1; saveContacts(); emitContacts(); }
  });

  socket.on('update-contact-notes', (data) => {
    const num = normalizeNumber(data.number);
    const c = contacts.find(x => normalizeNumber(x.number) === num);
    if (c) { c.notes = data.notes || ''; saveContacts(); emitContacts(); }
  });

  socket.on('set-bot-enabled', (data) => {
    const num = normalizeNumber(data.number);
    const c = contacts.find(x => normalizeNumber(x.number) === num);
    if (c) { c.botEnabled = Boolean(data.enabled); saveContacts(); emitContacts(); }
  });

  socket.on('add-contact', (data) => {
    const num = normalizeNumber(data.number);
    if (!num) return socket.emit('send-result', { success: false, message: 'Numero invalido' });
    upsertContact(num, data.name || num, '', new Date().toISOString(), false);
    emitContacts();
    socket.emit('send-result', { success: true, message: `Contacto ${num} agregado` });
  });

  socket.on('delete-chat', (data) => {
    const num = normalizeNumber(data.number);
    delete conversations[num];
    contacts = contacts.filter(c => normalizeNumber(c.number) !== num);
    saveContacts(); saveConversations(); emitContacts();
    io.emit('conversations', conversations);
    socket.emit('send-result', { success: true, message: `Chat ${num} eliminado` });
  });

  socket.on('send-message', async (data) => {
    const num = normalizeNumber(data.number);
    const message = data.message || '';
    if (!num || !message) return socket.emit('send-result', { success: false, message: 'Faltan datos' });

    try {
      await sock.sendMessage(toChatId(num), { text: message });
      const ts = new Date().toISOString();
      const msgData = { id: createMessageId(), type: 'manual', from: 'Tu', number: num, body: message, timestamp: ts };
      io.emit('new-message', msgData);
      if (!conversations[num]) conversations[num] = [];
      conversations[num].push(msgData); saveConversations();
      upsertContact(num, data.name || num, message, ts, false);
      emitContacts();
      socket.emit('send-result', { success: true, message: `Mensaje enviado a ${num}` });
      log(`Mensaje enviado a ${num}: ${message}`);
    } catch (err) {
      socket.emit('send-result', { success: false, message: err.message });
      log(`Error enviando: ${err.message}`);
    }
  });
});

// ===== WHATSAPP BOT =====
async function startBot() {
  const authDir = path.join(__dirname, 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  log(`Baileys version: ${version.join('.')}`);

  sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: true,
    browser: ['Bot WhatsApp', 'Chrome', '4.0.0'],
    markOnlineOnConnect: true,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeDataURL = await qrcode.toDataURL(qr);
      status = 'qr';
      io.emit('qr-code', qrCodeDataURL);
      io.emit('status', 'Escanea el codigo QR con WhatsApp');
      log('QR generado');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      log(`Conexion cerrada. Codigo: ${code}. Reconectar: ${reconnect}`);
      if (reconnect) {
        status = 'reconnecting';
        io.emit('status', 'Reconectando...');
        startBot();
      } else {
        status = 'logged_out';
        io.emit('status', 'Sesion cerrada. Elimina auth_info/ y reinicia.');
        log('Sesion cerrada');
      }
    }

    if (connection === 'open') {
      status = 'ready';
      qrCodeDataURL = null;
      io.emit('status', 'WhatsApp conectado');
      io.emit('qr-code', '');
      io.emit('contacts', contacts);
      io.emit('conversations', conversations);
      log('WhatsApp CONECTADO');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      if (!isJidUser(msg.key.remoteJid)) continue;

      const from = msg.key.remoteJid;
      const number = normalizeNumber(from);
      const body = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.buttonsResponseMessage?.selectedButtonId
        || msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId
        || '[mensaje multimedia]';

      const name = msg.pushName || number;
      const ts = new Date().toISOString();

      log(`Mensaje de ${name} (${number}): ${body}`);

      const msgData = { id: createMessageId(), type: 'incoming', from: name, number, body, timestamp: ts };
      io.emit('new-message', msgData);

      if (!conversations[number]) conversations[number] = [];
      conversations[number].push(msgData);
      if (conversations[number].length > 300) conversations[number] = conversations[number].slice(-300);
      saveConversations();

      upsertContact(number, name, body, ts, true);
      emitContacts();
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  log(`Servidor en puerto ${PORT}`);
  log('Iniciando WhatsApp...');
  startBot().catch(err => {
    log('ERROR FATAL: ' + err.message);
    process.exit(1);
  });
});

process.on('unhandledRejection', (r) => log('UNHANDLED: ' + r));
process.on('uncaughtException', (e) => { log('EXCEPTION: ' + e.message); log(e.stack); });