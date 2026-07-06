const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { 
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

let qrCodeDataURL = null;
let status = 'starting';

client.on('qr', async (qr) => {
  console.log('[QR] Generado');
  qrCodeDataURL = await qrcode.toDataURL(qr);
  status = 'qr';
  io.emit('qr', qrCodeDataURL);
});

client.on('ready', () => {
  console.log('[READY] WhatsApp conectado!');
  status = 'ready';
  io.emit('ready');
});

client.on('authenticated', () => {
  console.log('[AUTH] Autenticado');
  status = 'authenticated';
  io.emit('authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('[ERROR] Autenticación falló:', msg);
  status = 'auth_failure';
  io.emit('auth_failure', msg);
});

client.on('disconnected', (reason) => {
  console.log('[DISCONNECTED]', reason);
  status = 'disconnected';
  io.emit('disconnected', reason);
});

client.on('message', (msg) => {
  console.log(`[MSG] ${msg.from}: ${msg.body}`);
  io.emit('message', { from: msg.from, body: msg.body, timestamp: msg.timestamp });
});

io.on('connection', (socket) => {
  console.log('[IO] Cliente web conectado');
  socket.emit('status', status);
  
  if (qrCodeDataURL && status === 'qr') {
    socket.emit('qr', qrCodeDataURL);
  }
  
  socket.on('disconnect', () => {
    console.log('[IO] Cliente web desconectado');
  });
});

const PORT = process.env.PORT || 3050;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Corriendo en puerto ${PORT}`);
  console.log(`[SERVER] Iniciando WhatsApp...`);
  client.initialize().catch(err => {
    console.error('[ERROR] Fallo al iniciar WhatsApp:', err.message);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED] Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT] Exception:', err);
});
