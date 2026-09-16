import { Router } from 'express';
import { getLocalIpAddress } from '../utils/networkUtils.js';
import { getConnectedDevices } from '../sockets/socketManager.js';
import { env } from '../config/env.js';

const router = Router();

router.get('/info', (req, res) => {
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
