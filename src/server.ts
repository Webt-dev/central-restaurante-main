import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { env } from './config/env.js';
import { initDatabase } from './config/database.js';
import { initSocketIO } from './sockets/socketManager.js';
import apiRoutes from './routes/index.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { initMDNS, stopMDNS } from './utils/mdns.js';
import { getLocalIpAddress } from './utils/networkUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Inicializar banco de dados SQLite com tabelas e dados prévios
initDatabase();

const app = express();
const httpServer = createServer(app);

// Inicializar WebSockets em tempo real (Socket.IO)
initSocketIO(httpServer);

// Middlewares globais
app.use(cors({ origin: '*' }));
app.use(express.json());

// Rotas da API RESTful
app.use('/api', apiRoutes);

// Resolução dinâmica do caminho da pasta do Frontend compilado (Vite dist)
const possibleDistPaths = [
  path.join(process.cwd(), 'frontend', 'dist'),
  path.join(__dirname, '..', 'frontend', 'dist'),
  path.join(__dirname, '..', '..', 'frontend', 'dist'),
  path.join(process.cwd(), 'dist')
];

const distPath = possibleDistPaths.find(p => fs.existsSync(path.join(p, 'index.html'))) || possibleDistPaths[0]!;

if (fs.existsSync(distPath) && fs.existsSync(path.join(distPath, 'index.html'))) {
  app.use(express.static(distPath));
  app.get(/(.*)/, (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({
      status: 'online',
      system: 'Central de Restaurante Multi-telas (Electron Backend)',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    });
  });
}

// Middleware central de tratamento de erros
app.use(errorHandler);

const PORT = Number(env.PORT) || 3000;
const localIp = getLocalIpAddress();

// Express escutando na interface 0.0.0.0 para conexões locais e de celulares
httpServer.listen(PORT, '0.0.0.0', () => {
  const directAppUrl = `http://${localIp}:${PORT}`;
  const viteUrl = `http://${localIp}:5173`;

  console.log('\n======================================================================');
  console.log('🚀 CENTRAL RESTAURANTE S.A. - SERVIDOR ELECTRON ONLINE');
  console.log('======================================================================');
  console.log(`📡 IP Local Ativo no Wi-Fi: ${localIp}`);
  console.log(`🌐 Endereço Direto Sem Dependência DNS: ${directAppUrl}`);
  console.log(`⚡ Vite Dev Server:                       ${viteUrl}`);
  console.log('======================================================================');
  console.log('📲 QR CODE PARA CONEXÃO INSTANTÂNEA PELO CELULAR (APONTE A CÂMERA):');
  console.log('----------------------------------------------------------------------');
  
  try {
    qrcode.generate(directAppUrl, { small: true });
  } catch (err) {
    console.log(`   Accesse via: ${directAppUrl}`);
  }

  console.log('----------------------------------------------------------------------');
  console.log(`📱 Abra a câmera do celular e aponte para o QR Code acima!`);
  console.log(`   Ou digite no celular: ${directAppUrl}`);
  console.log('======================================================================\n');
  
  // Ativar servidor mDNS (Bonjour ZeroConf)
  initMDNS(PORT, PORT);
});

process.on('SIGINT', () => {
  stopMDNS();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopMDNS();
  process.exit(0);
});