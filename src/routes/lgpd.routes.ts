import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { auditRequest } from '../services/AuditService.js';
import { consultarTitular, anonimizarTitular } from '../services/LgpdService.js';
import { maskCpf } from '../utils/pii.js';
import { somenteDigitos } from '../utils/fiscalUtils.js';

const router = Router();
router.use(authenticate, authorize(['ADMIN']));

const anonimizarSchema = z.object({
  cpf: z.string().trim().min(11, 'Informe o CPF.').max(14),
  // O motivo/solicitação do titular fica na auditoria (prestação de contas da LGPD).
  motivo: z.string().trim().min(5, 'Informe o motivo/solicitação do titular.').max(300)
});

router.get('/titular', (req: AuthenticatedRequest, res, next) => {
  try {
    const cpf = String(req.query.cpf ?? '');
    const result = consultarTitular(cpf);
    // A própria consulta de dados pessoais é registrada (só com CPF mascarado).
    auditRequest(req, { action: 'lgpd.consulta', entity: 'titular', entityId: maskCpf(somenteDigitos(cpf)), after: { notas: result.notas.length, pedidos: result.pedidos.length } });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/anonimizar', validateBody(anonimizarSchema), (req: AuthenticatedRequest, res, next) => {
  const { cpf, motivo } = req.body;
  const entityId = maskCpf(somenteDigitos(cpf));
  try {
    const result = anonimizarTitular(cpf);
    auditRequest(req, { action: 'lgpd.anonimizar', entity: 'titular', entityId, reason: motivo, after: { anonimizados: result.anonimizados.length, recusados: result.recusados.length } });
    res.json(result);
  } catch (err) {
    // Recusas também são registradas: provam que o pedido foi analisado.
    auditRequest(req, { action: 'lgpd.anonimizar_recusado', entity: 'titular', entityId, reason: motivo });
    next(err);
  }
});

export default router;
