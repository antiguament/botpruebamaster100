const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const axios = require('axios');

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

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';

let cachedKnowledge = null;
let knowledgeLastLoaded = 0;
const KNOWLEDGE_CACHE_TTL = 60000;

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

function contactEnabled(number) {
  const num = normalizeNumber(number);
  const c = contacts.find(x => normalizeNumber(x.number) === num);
  return c ? c.botEnabled !== false : true;
}

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getAutoReply(message) {
  const lower = message.toLowerCase().trim();
  if (/^(hola|buenos dias|buenas tardes|buenas noches|hey|que tal|saludos|hello|hi)$/i.test(lower))
    return 'Hola! Bienvenido a Agencia Nexus. Como puedo ayudarte hoy?';
  if (/^(adios|hasta luego|chao|nos vemos|bye|gracias|muchas gracias)$/i.test(lower))
    return 'Gracias por escribirnos! Estamos aqui cuando nos necesites.';
  if (/(precio|precios|plan|planes|cuesta|costo|cuanto)/i.test(lower))
    return 'Tenemos diferentes planes:\n\nEssential: $290K COP\nStart: $490K COP (popular)\nPRO: $890K COP (mas vendido)\nEnterprise: $1.590K COP\n\nCual te interesa?';
  if (/(servicio|servicios|hacen|que hacen|que ofrecen)/i.test(lower))
    return 'Ofrecemos:\n- Paginas web profesional\n- Tiendas online\n- Integracion WhatsApp\n- SEO y marketing digital\n- Soporte 24/7\n\nQue necesitas para tu negocio?';
  if (/(pagina|web|sitio|landing|desarrollo)/i.test(lower))
    return 'Desarrollamos paginas web profesionales, tiendas online y landing pages. Que tipo de negocio tienes?';
  if (/(tienda|ecommerce|vender|productos)/i.test(lower))
    return 'Creamos tiendas online con catalogo, carrito y pasarela de pago. El plan Start o PRO son ideales. Cuantos productos manejas?';
  if (/(whatsapp|api|integracion)/i.test(lower))
    return 'Integramos WhatsApp Business API para mensajes automaticos y ventas por chat. El plan PRO la incluye.';
  if (/(hosting|servidor|dominio)/i.test(lower))
    return 'Todos nuestros planes incluyen hosting premium, dominio .com y SSL por 12 meses.';
  if (/(soporte|ayuda|problema)/i.test(lower))
    return 'Nuestro soporte esta disponible 24/7 VIP. En que puedo ayudarte?';
  if (/(demo|muestra|ejemplo|ver)/i.test(lower))
    return 'Tenemos demos en n1nexus.com. Que tipo de negocio tienes? Te muestro uno similar!';
  if (/(pago|pagar|factura|comprar)/i.test(lower))
    return 'Aceptamos transferencia, PSE, tarjeta y Nequi. El pago es unico sin suscripciones.';
  if (/(diseno|diseño|bonito|moderno|profesional)/i.test(lower))
    return 'Nuestros diseños son modernos y responsivos. Quieres ver ejemplos de trabajos?';
  if (/(marketing|publicidad|seo|redes)/i.test(lower))
    return 'Ofrecemos SEO, redes sociales y campañas. El plan DIAMANTE incluye marketing completo.';
  if (/(quien eres|que eres|tu nombre)/i.test(lower))
    return 'Soy NEXUS, tu asistente virtual de Agencia Nexus. Estoy aqui para ayudarte!';
  if (/(negocio|empresa|emprendimiento)/i.test(lower))
    return 'Que bueno! Te puedo ayudar a llevar tu negocio al siguiente nivel con presencia digital. Que tipo es?';
  return null;
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

function detectUserContext(message) {
  const lower = message.toLowerCase();
  const wisdomKeywords = [
    'triste', 'preocupado', 'preocupada', 'estresado', 'estresada',
    'confundido', 'confundida', 'solo', 'sola', 'soledad',
    'familia', 'familias', 'padres', 'hermanos', 'hijos',
    'tiempo', 'vida', 'muerte', 'dios', 'dioses', 'orar', 'oración',
    'esperanza', 'fe', 'amor', 'perdón', 'perdonar',
    'miedo', 'ansiedad', 'depresión', 'tristeza',
    'fracaso', 'fracasé', 'perdí', 'no puedo', 'no sé qué hacer',
    'sentido', 'propósito', 'razón', 'existencia',
    'ayuda', 'socorro', 'necesito', 'auxilio',
    'llorar', 'llanto', 'dolor', 'sufrimiento',
    'cambio', 'transformar', 'crecer', 'aprender',
    'éxito', 'triunfo', 'logro', 'meta',
    'decision', 'decidir', 'elegir', 'opciones',
    'esperar', 'paciencia', 'silencio', 'paz'
  ];
  const commercialKeywords = [
    'plan', 'planes', 'precio', 'precios', 'costo', 'costos',
    'vender', 'venta', 'ventas', 'comprar', 'compra',
    'negocio', 'negocios', 'empresa', 'empresas',
    'página', 'páginas', 'web', 'website', 'sitio',
    'tienda', 'tiendas', 'ecommerce', 'e-commerce',
    'demo', 'demos', 'muestra', 'ejemplo',
    'hosting', 'dominio', 'servidor',
    'diseño', 'diseñar', 'diseñador',
    'desarrollo', 'desarrollar', 'programador',
    'whatsapp', 'api', 'integración',
    'carrito', 'checkout', 'pago', 'pagos',
    'facturación', 'facturar', 'invoice',
    'inventario', 'stock', 'productos',
    'catálogo', 'seo', 'marketing', 'publicidad',
    'cms', 'panel', 'dashboard',
    'soporte', 'mantenimiento',
    'essential', 'start', 'pro', 'enterprise', 'diamante',
    '$290', '$490', '$890', '$1.590', '$2.490'
  ];
  const wisdomScore = wisdomKeywords.filter(k => lower.includes(k)).length;
  const commercialScore = commercialKeywords.filter(k => lower.includes(k)).length;
  if (wisdomScore > commercialScore && wisdomScore >= 1) return 'wisdom';
  if (commercialScore > wisdomScore && commercialScore >= 1) return 'commercial';
  if (wisdomScore === commercialScore && wisdomScore > 0) return 'mixed';
  return 'neutral';
}

function buildSystemPrompt() {
  const now = Date.now();
  if (!cachedKnowledge || (now - knowledgeLastLoaded) > KNOWLEDGE_CACHE_TTL) {
    try {
      cachedKnowledge = JSON.parse(fs.readFileSync(BOT_KNOWLEDGE_PATH, 'utf8'));
      knowledgeLastLoaded = now;
    } catch (err) {
      console.error('Error cargando bot-knowledge.json:', err.message);
      if (!cachedKnowledge) cachedKnowledge = {};
    }
  }
  const k = cachedKnowledge;
  const customPrompt = k.nexus_system_prompt || `Eres "NEXUS", el asistente virtual de ventas de Agencia Nexus.
Responde en español de Colombia, con tono profesional, cercano, claro y orientado a ventas.
Tu objetivo es ayudar a prospectos y clientes a encontrar la solución digital perfecta para su negocio.`;
  const rules = `No inventes datos que no estén en la base de conocimiento.
Si falta información, invita a escribir por WhatsApp para asesoría personalizada.
Mantén respuestas breves para WhatsApp, idealmente entre 1 y 4 líneas, salvo que el usuario pida más detalle.`;

  // Enviar SOLO datos esenciales, no todo el JSON
  const plans = k.catalogos_planes ? JSON.stringify(k.catalogos_planes, null, 2) : '';
  const faq = k.preguntas_frecuentes ? JSON.stringify(k.preguntas_frecuentes) : '';

  return `${customPrompt}\n\n${rules}\n\nPlanes:\n${plans}\n\nPreguntas frecuentes:\n${faq}`;
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

  // Operator: submit draft to refine with AI
  socket.on('submit-operator-draft', async (data) => {
    const num = normalizeNumber(data.number);
    const draft = data.draft || '';
    if (!num || !draft) return socket.emit('send-result', { success: false, message: 'Faltan datos' });

    try {
      const msgs = conversations[num] || [];
      const lastIncoming = [...msgs].reverse().find(m => m.type === 'incoming');
      const userMessage = lastIncoming ? lastIncoming.body : '(sin mensaje previo)';

      const refinementPrompt = `El usuario pregunto: "${userMessage}"
El operador escribio esta respuesta como guia: "${draft}"
Refina y mejora la respuesta del operador. Manten su intencion pero:
- Usa un tono profesional y cercano
- Corrige errores ortograficos
- Mejora la estructura
- No inventes informacion que no este en el borrador
Responde SOLO con el texto refinado, sin explicaciones.`;

      const response = await axios.post(MISTRAL_API_URL, {
        model: 'mistral-tiny',
        messages: [
          { role: 'system', content: 'Eres un asistente que refina respuestas para WhatsApp. Responde solo con el texto mejorado.' },
          { role: 'user', content: refinementPrompt }
        ],
        max_tokens: 250
      }, {
        headers: {
          'Authorization': `Bearer ${MISTRAL_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const refined = response.data.choices[0].message.content;
      await sock.sendMessage(toChatId(num), { text: refined });

      const ts = new Date().toISOString();
      const msgData = { id: createMessageId(), type: 'operator-ai', from: 'Operador + IA', number: num, body: refined, timestamp: ts };
      io.emit('new-message', msgData);
      if (!conversations[num]) conversations[num] = [];
      conversations[num].push(msgData);
      saveConversations();
      upsertContact(num, null, refined, ts, false);
      emitContacts();
      socket.emit('send-result', { success: true, message: `Respuesta refinada enviada a ${num}` });
      log(`Draft refinado enviado a ${num}`);
    } catch (err) {
      log(`Error draft: ${err.message}`);
      socket.emit('send-result', { success: false, message: `Error: ${err.message}` });
    }
  });

  // Operator: inject context for next AI response
  socket.on('operator-inject-context', (data) => {
    const num = normalizeNumber(data.number);
    if (!num || !data.message) return;
    if (!operatorContexts) globalThis.operatorContexts = {};
    operatorContexts[num] = {
      message: data.message,
      timestamp: new Date().toISOString(),
      operator: data.operator || 'Operador'
    };
    socket.emit('send-result', { success: true, message: `Contexto inyectado para ${num}` });
    log(`Contexto inyectado para ${num}: ${data.message}`);
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
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
let botStarted = false;
let lastReconnectTime = 0;
const MIN_RECONNECT_INTERVAL = 10000;
const operatorContexts = {};

async function startBot() {
  if (botStarted) {
    log('Bot ya esta corriendo, ignorando startBot()');
    return;
  }
  botStarted = true;

  const authDir = path.join(__dirname, 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  // Cerrar socket viejo si existe
  if (sock) {
    try { sock.end(undefined); } catch (e) {}
    sock = null;
  }

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
      reconnectAttempts = 0;
      lastReconnectTime = 0;
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

      if (!reconnect) {
        status = 'logged_out';
        io.emit('status', 'Sesion cerrada. Elimina auth_info/ y reinicia.');
        log('Sesion cerrada');
        botStarted = false;
        return;
      }

      // Cooldown: no reconectar mas rapido de 10 segundos
      const now = Date.now();
      const timeSinceLast = now - lastReconnectTime;
      if (timeSinceLast < MIN_RECONNECT_INTERVAL) {
        const wait = MIN_RECONNECT_INTERVAL - timeSinceLast;
        log(`Cooldown: esperando ${Math.round(wait / 1000)}s antes de reconectar`);
        await new Promise(r => setTimeout(r, wait));
      }

      reconnectAttempts++;
      lastReconnectTime = Date.now();

      if (reconnectAttempts > MAX_RECONNECT) {
        status = 'error';
        io.emit('status', 'Demasiados reintentos. Elimina auth_info/ y reinicia.');
        log('Maximos reintentos alcanzados');
        botStarted = false;
        return;
      }

      status = 'reconnecting';
      io.emit('status', `Reconectando... (${reconnectAttempts}/${MAX_RECONNECT})`);
      const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
      log(`Reconexion #${reconnectAttempts} en ${Math.round(delay / 1000)}s...`);
      botStarted = false;
      setTimeout(() => startBot(), delay);
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      lastReconnectTime = 0;
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
      if (!msg.key.remoteJid || !msg.key.remoteJid.endsWith('@c.us')) continue;

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

      // Auto-respuesta por keywords
      if (contactEnabled(number)) {
        const autoReply = getAutoReply(body);
        if (autoReply) {
          try {
            await sock.sendMessage(from, { text: autoReply });
            const replyData = {
              id: createMessageId(), type: 'ai-reply', from: 'Bot',
              number, body: autoReply, timestamp: new Date().toISOString()
            };
            io.emit('new-message', replyData);
            if (!conversations[number]) conversations[number] = [];
            conversations[number].push(replyData);
            saveConversations();
            upsertContact(number, name, autoReply, replyData.timestamp, false);
            emitContacts();
            log(`Auto-respuesta a ${number}: ${autoReply}`);
          } catch (err) {
            log(`Error auto-respuesta: ${err.message}`);
          }
        }
      }
    }
  });
}

const PORT = process.env.PORT || 3000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Puerto ${PORT} ya en uso - otra instancia activa. Cerrando esta instancia.`);
    process.exit(0);
  } else {
    log(`Error del servidor: ${err.message}`);
    process.exit(1);
  }
});

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