const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const logs = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 100) logs.shift();
}

log('Iniciando servidor...');
log(`Node: ${process.version}`);
log(`Platform: ${process.platform}`);
log(`CWD: ${process.cwd()}`);
log(`Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);

let qrCodeDataURL = null;
let status = 'starting';
let sock = null;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
  res.json({
    node: process.version,
    platform: process.platform,
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    whatsappStatus: status,
    hasQR: !!qrCodeDataURL,
    logs: logs.slice(-20)
  });
});

io.on('connection', (socket) => {
  log('Cliente web conectado: ' + socket.id);
  socket.emit('status', status);

  if (qrCodeDataURL && status === 'qr') {
    socket.emit('qr', qrCodeDataURL);
  }

  socket.on('disconnect', () => {
    log('Cliente web desconectado');
  });
});

async function startBot() {
  const authDir = path.join(__dirname, 'auth_info');

  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  log(`Usando Baileys version: ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['Bot WhatsApp', 'Chrome', '4.0.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const QRCode = require('qrcode');
      qrCodeDataURL = await QRCode.toDataURL(qr);
      status = 'qr';
      io.emit('qr', qrCodeDataURL);
      log('QR generado! Escanea con WhatsApp.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      log(`Conexion cerrada. StatusCode: ${statusCode}. Reconectar: ${shouldReconnect}`);

      if (shouldReconnect) {
        status = 'reconnecting';
        io.emit('status', 'reconnecting');
        startBot();
      } else {
        status = 'logged_out';
        io.emit('status', 'logged_out');
        log('Sesion cerrada. Elimina auth_info/ y reinicia para obtener nuevo QR.');
      }
    }

    if (connection === 'open') {
      status = 'ready';
      qrCodeDataURL = null;
      io.emit('ready');
      log('WhatsApp CONECTADO!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      const from = msg.key.remoteJid;
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[mensaje multimedia]';
      log(`Mensaje: ${from}: ${body}`);
      io.emit('message', { from, body, timestamp: msg.messageTimestamp });
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  log(`Servidor corriendo en puerto ${PORT}`);
  log('Inicializando WhatsApp Web (Baileys)...');
  startBot().catch(err => {
    log('ERROR FATAL: ' + err.message);
    log(err.stack);
  });
});

process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION: ' + reason);
});

process.on('uncaughtException', (err) => {
  log('UNCAUGHT EXCEPTION: ' + err.message);
  log(err.stack);
});