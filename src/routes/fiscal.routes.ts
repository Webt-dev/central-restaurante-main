import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { auditRequest } from '../services/AuditService.js';
import * as Fiscal from '../fiscal/FiscalService.js';

const router = Router();
router.use(authenticate);

function param(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

const configSchema = z.object({
  provider: z.enum(['acbr', 'simulacao']).optional(),
  acbr_host: z.string().trim().max(100).optional(),
  acbr_port: z.coerce.number().int().min(1).max(65535).optional(),
  ambiente: z.coerce.number().int().refine(v => v === 1 || v === 2, 'Ambiente deve ser 1 (produção) ou 2 (homologação)').optional(),
  serie: z.coerce.number().int().min(1).max(999).optional(),
  cnpj: z.string().max(20).optional(),
  ie: z.string().max(20).optional(),
  razao_social: z.string().trim().max(60).optional(),
  nome_fantasia: z.string().trim().max(60).optional(),
  crt: z.enum(['', '1', '2', '3', '4']).optional(),
  logradouro: z.string().trim().max(60).optional(),
  numero: z.string().trim().max(60).optional(),
  bairro: z.string().trim().max(60).optional(),
  codigo_municipio: z.string().max(10).optional(),
  municipio: z.string().trim().max(60).optional(),
  uf: z.string().trim().max(2).optional(),
  cep: z.string().max(10).optional(),
  telefone: z.string().max(20).optional(),
  cfop_padrao: z.string().trim().max(4).optional(),
  csosn_padrao: z.string().trim().max(3).optional(),
  cst_icms_padrao: z.string().trim().max(2).optional(),
  cst_pis_cofins_padrao: z.string().trim().max(2).optional(),
  origem_padrao: z.string().trim().max(1).optional()
});

// Situação do módulo: caixa e gestão acompanham (contingência, rejeições).
router.get('/status', authorize(['CASHIER']), (req, res) => {
  res.json({ ...Fiscal.resumo(), pendencias: Fiscal.validarConfig() });
});

router.get('/config', authorize(['ADMIN']), (req, res) => {
  res.json({ config: Fiscal.getConfig(), pendencias: Fiscal.validarConfig(), produtos_sem_ncm: Fiscal.produtosSemNcm() });
});

router.put('/config', authorize(['ADMIN']), validateBody(configSchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const before = Fiscal.getConfig();
    const config = Fiscal.updateConfig(req.body);
    auditRequest(req, { action: 'fiscal.config', entity: 'fiscal', before, after: config });
    res.json({ config, pendencias: Fiscal.validarConfig(), produtos_sem_ncm: Fiscal.produtosSemNcm() });
  } catch (err) {
    next(err);
  }
});

router.post('/testar-conexao', authorize(['ADMIN']), async (req, res, next) => {
  try {
    res.json(await Fiscal.testarConexao());
  } catch (err) {
    next(err);
  }
});

router.post('/ativar', authorize(['ADMIN']), validateBody(z.object({ enabled: z.boolean() })), async (req: AuthenticatedRequest, res, next) => {
  try {
    const result = await Fiscal.ativar(req.body.enabled);
    auditRequest(req, { action: req.body.enabled ? 'fiscal.enable' : 'fiscal.disable', entity: 'fiscal', after: result });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/documentos', authorize(['CASHIER']), (req, res) => {
  const data = req.query.data ? param(req.query.data) : undefined;
  if (data && !/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data inválida.' });
  res.json(Fiscal.listar(data));
});

router.post('/documentos/:id/reprocessar', authorize(['CASHIER']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const doc = await Fiscal.reprocessar(param(req.params.id));
    auditRequest(req, { action: 'fiscal.reprocess', entity: 'fiscal_document', entityId: param(req.params.id), after: doc });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.post('/documentos/:id/cancelar', authorize(['ADMIN']), validateBody(z.object({ justificativa: z.string() })), async (req: AuthenticatedRequest, res, next) => {
  try {
    const doc = await Fiscal.cancelar(param(req.params.id), req.body.justificativa);
    auditRequest(req, { action: 'fiscal.cancel', entity: 'fiscal_document', entityId: param(req.params.id), after: doc, reason: req.body.justificativa });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

export default router;
