const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { install, detectBrowserPlatform, resolveBuildId, Browser } = require('@puppeteer/browsers');

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

async function ensureChrome() {
  const possiblePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      log(`Chrome encontrado: ${p}`);
      return p;
    }
  }

  log('Chrome no encontrado. Descargando chrome-headless-shell...');
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
  const platform = detectBrowserPlatform();

  if (!platform) {
    throw new Error('Plataforma no soportada para descarga de Chrome');
  }

  let result;
  try {
    const buildId = await resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, 'latest');
    log(`Descargando chrome-headless-shell ${buildId}...`);
    result = await install({
      browser: Browser.CHROMEHEADLESSSHELL,
      cacheDir,
      platform,
      buildId,
    });
  } catch (e1) {
    log('headless-shell fallo, intentando chrome completo...');
    try {
      const buildId = await resolveBuildId(Browser.CHROME, platform, 'latest');
      log(`Descargando Chrome ${buildId}...`);
      result = await install({
        browser: Browser.CHROME,
        cacheDir,
        platform,
        buildId,
      });
    } catch (e2) {
      throw new Error('No se pudo descargar ningun navegador: ' + e2.message);
    }
  }

  const execPath = result.executablePath;
  log(`Navegador descargado en: ${execPath}`);

  try {
    fs.chmodSync(execPath, 0o755);
    log('Permisos de ejecucion asignados');
  } catch (e) {
    log('No se pudieron asignar permisos: ' + e.message);
  }

  return execPath;
}

(async () => {
  try {
    const chromePath = await ensureChrome();

    const puppeteerConfig = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
      ],
      executablePath: chromePath
    };

    const client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: puppeteerConfig
    });

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

  } catch (err) {
    log('ERROR FATAL: ' + err.message);
    log(err.stack);
    process.exit(1);
  }
})();

process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION: ' + reason);
});

process.on('uncaughtException', (err) => {
  log('UNCAUGHT EXCEPTION: ' + err.message);
  log(err.stack);
});