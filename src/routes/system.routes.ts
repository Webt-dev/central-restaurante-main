import { Router } from 'express';
import { getLocalIpAddress } from '../utils/networkUtils.js';
import { getConnectedDevices } from '../sockets/socketManager.js';
import { env } from '../config/env.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';

const router = Router();

// Expõe IPs e aparelhos conectados: só para caixa/gestão.
router.get('/info', authenticate, authorize(['CASHIER']), (req, res) => {
  const localIp = getLocalIpAddress();
  const port = Number(env.PORT) || 3000;
  const directUrl = `http://${localIp}:${port}`;
  const connectedDevices = getConnectedDevices();

  res.json({
    local_ip: localIp,
    frontend_url: directUrl,
    backend_url: directUrl,
    connected_devices: connectedDevices,
    total_connected: connectedDevices.length
  });
});

export default router;
