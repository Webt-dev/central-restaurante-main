import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { auditRequest } from '../services/AuditService.js';
import * as License from '../license/LicenseService.js';

const router = Router();
router.use(authenticate);

// Todas as telas mostram a faixa de aviso (vencimento, atraso, bloqueio).
router.get('/status', (req, res) => {
  const st = License.getStatus();
  // Detalhes técnicos só para quem administra.
  if ((req as AuthenticatedRequest).user?.role !== 'ADMIN') {
    return res.json({ state: st.state, blocked: st.blocked, message: st.message, daysLeft: st.daysLeft, daysOverdue: st.daysOverdue, daysUntilBlock: st.daysUntilBlock, enforced: st.enforced });
  }
  // O segredo do dispositivo só vai para o ADMIN: o celular dele precisa dele (cabeçalho
  // x-device-secret) para buscar a licença direto no servidor quando a central está sem internet.
  res.json({ ...st, deviceSecret: License.getDeviceSecret(st.clientId) });
});

// Avaliação gratuita: registra no servidor quando há internet; sem internet segue com a avaliação
// local de 7 dias e registra depois (202). Se o servidor disser que já foi usada, responde 409.
router.post('/trial', authorize(['ADMIN']), validateBody(z.object({
  server_url: z.string().trim().url('Endereço do servidor inválido').optional(),
  name: z.string().trim().min(2).max(120),
  cnpj: z.string().trim().min(14).max(24),
  email: z.string().trim().email().max(120),
  consent: z.boolean().optional()
})), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { registered, status } = await License.registerTrial({
      serverUrl: req.body.server_url, name: req.body.name, cnpj: req.body.cnpj, email: req.body.email, consent: req.body.consent
    });
    // Sem CNPJ/e-mail na auditoria (dado pessoal): só o resultado.
    auditRequest(req, { action: 'license.trial', entity: 'license', entityId: status.clientId, after: { registered } });
    res.status(registered ? 200 : 202).json(status);
  } catch (err) {
    next(err);
  }
});

router.post('/activate', authorize(['ADMIN']), validateBody(z.object({
  server_url: z.string().trim().url('Endereço do servidor inválido'),
  client_id: z.string().trim().min(3).max(64),
  activation_code: z.string().trim().min(4).max(64)
})), async (req: AuthenticatedRequest, res, next) => {
  try {
    const status = await License.activate(req.body.server_url, req.body.client_id, req.body.activation_code);
    auditRequest(req, { action: 'license.activate', entity: 'license', entityId: status.clientId, after: { plan: status.plan, paidUntil: status.paidUntil } });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', authorize(['ADMIN']), async (req: AuthenticatedRequest, res, next) => {
  try {
    res.json(await License.refresh());
  } catch (err) {
    next(err);
  }
});

// Renovação sem internet na central: o celular do ADMIN busca a licença pelo 4G
// (ou o ADMIN cola o arquivo recebido) e entrega aqui.
router.post('/install', authorize(['ADMIN']), validateBody(z.object({ token: z.string().trim().min(20).max(4000) })), (req: AuthenticatedRequest, res, next) => {
  try {
    const status = License.installToken(req.body.token);
    auditRequest(req, { action: 'license.install', entity: 'license', entityId: status.clientId, after: { paidUntil: status.paidUntil } });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

export default router;
