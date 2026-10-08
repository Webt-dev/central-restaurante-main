import { app, BrowserWindow, shell, utilityProcess, dialog } from 'electron';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const APP_URL = `http://localhost:${PORT}`;

let mainWindow = null;
let server = null;
let quitting = false;
let restarts = 0;

// Duas instâncias disputariam a porta 3000 e o mesmo banco.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

/**
 * O servidor (Express + SQLite) roda num processo separado da janela: se ele
 * cair, a janela continua aberta e o servidor é reiniciado. Os dados ficam na
 * pasta do usuário (%APPDATA%\Central Restaurante), nunca na pasta de instalação.
 */
function startServer() {
  const dataDir = app.getPath('userData');
  server = utilityProcess.fork(path.join(__dirname, 'dist', 'server.js'), [], {
    serviceName: 'central-restaurante-servidor',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DB_PATH: path.join(dataDir, 'database.sqlite')
    },
    stdio: 'inherit'
  });

  server.on('exit', code => {
    server = null;
    if (quitting) return;
    restarts += 1;
    if (restarts > 5) {
      dialog.showErrorBox(
        'Central Restaurante',
        `O servidor parou ${restarts} vezes seguidas (código ${code}). Veja os logs em ${path.join(dataDir, 'logs')}.`
      );
      return;
    }
    setTimeout(startServer, 1000);
  });
}

function waitForServer(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${APP_URL}/api/auth/setup-status`, res => {
        res.resume();
        restarts = 0;
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error('O servidor não respondeu a tempo.'));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    fullscreen: true,
    autoHideMenuBar: true,
    title: 'Central Restaurante',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.loadURL(APP_URL);

  // A janela só navega dentro do próprio sistema.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) event.preventDefault();
  });

  // Links externos (https) abrem no navegador; qualquer outra janela é bloqueada.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer();
  } catch (err) {
    dialog.showErrorBox('Central Restaurante', `Não foi possível iniciar o servidor: ${err.message}`);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  server?.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
