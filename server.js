const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
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

let chromiumPath = null;

const possiblePaths = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
];

for (const p of possiblePaths) {
  if (p && fs.existsSync(p)) {
    chromiumPath = p;
    log(`Chrome encontrado: ${p}`);
    break;
  }
}

if (!chromiumPath) {
  log('No se encontro Chrome/Chromium en rutas conocidas');
  log('Puppeteer intentara descargar su propio Chromium...');
}

const puppeteerConfig = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--disable-gpu',
    '--disable-extensions'
  ]
};

if (chromiumPath) {
  puppeteerConfig.executablePath = chromiumPath;
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: puppeteerConfig
});

let qrCodeDataURL = null;
let status = 'starting';

client.on('qr', async (qr) => {
  log('QR generado!');
  qrCodeDataURL = await qrcode.toDataURL(qr);
  status = 'qr';
  io.emit('qr', qrCodeDataURL);
});

client.on('ready', () => {
  log('WhatsApp CONECTADO!');
  status = 'ready';
  io.emit('ready');
});

client.on('authenticated', () => {
  log('Autenticado correctamente');
  status = 'authenticated';
  io.emit('authenticated');
});

client.on('auth_failure', (msg) => {
  log('FALLO autenticacion: ' + msg);
  status = 'auth_failure';
  io.emit('auth_failure', msg);
});

client.on('disconnected', (reason) => {
  log('Desconectado: ' + reason);
  status = 'disconnected';
  io.emit('disconnected', reason);
});

client.on('message', (msg) => {
  log(`Mensaje: ${msg.from}: ${msg.body}`);
  io.emit('message', { from: msg.from, body: msg.body, timestamp: msg.timestamp });
});

client.on('loading_screen', (percent, message) => {
  log(`Cargando WhatsApp Web: ${percent}% - ${message}`);
});

client.on('browser_crash', (msg) => {
  log('BROWSER CRASH: ' + msg);
  status = 'crashed';
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  log(`Servidor corriendo en puerto ${PORT}`);
  log('Inicializando WhatsApp Web...');
  
  client.initialize().then(() => {
    log('client.initialize() completado');
  }).catch(err => {
    log('ERROR en client.initialize(): ' + err.message);
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
