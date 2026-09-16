import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { FiscalRepository, StatusFiscal } from '../repositories/FiscalRepository.js';
import { emitEvent } from '../sockets/socketManager.js';

const router = Router();

router.use(authenticate);

/**
 * No Express 5 os parâmetros de rota são tipados como `string | string[]`.
 * Este helper normaliza para string simples.
 */
function param(valor: unknown): string {
  return Array.isArray(valor) ? String(valor[0] ?? '') : String(valor ?? '');
}

// ==========================================
// CONFIGURAÇÃO FISCAL
// ==========================================
router.get('/config', authorize(['ADMIN']), (req, res, next) => {
  try {
    const config = FiscalRepository.getConfig();
    // Nunca devolvemos o CSC completo para a tela: é um segredo da SEFAZ.
    const { csc, ...seguro } = config;
    res.json({ ...seguro, csc_configurado: Boolean(csc) });
  } catch (err) {
    next(err);
  }
});

router.put('/config', authorize(['ADMIN']), (req, res, next) => {
  try {
    const payload = { ...req.body };

    if (payload.ambiente !== undefined) {
      const amb = Number(payload.ambiente);
      if (amb !== 1 && amb !== 2) {
        return res.status(400).json({ error: 'Ambiente deve ser 1 (produção) ou 2 (homologação).' });
      }
    }

    if (payload.serie_nfce !== undefined) {
      const serie = Number(payload.serie_nfce);
      if (!Number.isInteger(serie) || serie < 1 || serie > 999) {
        return res.status(400).json({ error: 'A série deve ser um número inteiro entre 1 e 999.' });
      }
    }

    // Campo vazio não apaga o CSC já gravado.
    if (payload.csc === '') delete payload.csc;

    const atualizado = FiscalRepository.updateConfig(payload);
    const validacao = FiscalRepository.validarConfig();

    emitEvent('fiscal:config_updated');

    const { csc, ...seguro } = atualizado;
    res.json({ ...seguro, csc_configurado: Boolean(csc), validacao });
  } catch (err) {
    next(err);
  }
});

router.get('/config/validar', authorize(['ADMIN']), (req, res, next) => {
  try {
    res.json(FiscalRepository.validarConfig());
  } catch (err) {
    next(err);
  }
});

// ==========================================
// DOCUMENTOS
// ==========================================
router.get('/documentos', (req, res, next) => {
  try {
    const data = req.query.data ? param(req.query.data) : undefined;
    const status = req.query.status ? (param(req.query.status) as StatusFiscal) : undefined;
    const limite = req.query.limite ? Number(param(req.query.limite)) : undefined;

    res.json(FiscalRepository.listar({ data, status, limite }));
  } catch (err) {
    next(err);
  }
});

router.get('/documentos/:id', (req, res, next) => {
  try {
    const doc = FiscalRepository.findById(param(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Documento fiscal não encontrado.' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.get('/documentos/:id/xml', (req, res, next) => {
  try {
    const xml = FiscalRepository.getXml(param(req.params.id));
    if (!xml) return res.status(404).json({ error: 'Arquivo XML não encontrado no disco.' });
    res.json({ xml });
  } catch (err) {
    next(err);
  }
});

router.get('/resumo', (req, res, next) => {
  try {
    const data = req.query.data ? param(req.query.data) : undefined;
    res.json(FiscalRepository.resumoDia(data));
  } catch (err) {
    next(err);
  }
});

router.post('/exportar', authorize(['ADMIN', 'CASHIER']), (req, res, next) => {
  try {
    const { data_inicio, data_fim } = req.body;
    if (!data_inicio || !data_fim) {
      return res.status(400).json({ error: 'Informe a data inicial e a data final.' });
    }
    res.json(FiscalRepository.exportarPeriodo(String(data_inicio), String(data_fim)));
  } catch (err) {
    next(err);
  }
});

// Usado quando a transmissão à SEFAZ for feita por sistema externo/contador.
router.post('/documentos/:id/autorizar', authorize(['ADMIN']), (req, res, next) => {
  try {
    const protocolo = String(req.body?.protocolo ?? '').trim();
    if (!protocolo) {
      return res.status(400).json({ error: 'Informe o número do protocolo de autorização.' });
    }
    res.json(FiscalRepository.registrarAutorizacao(param(req.params.id), protocolo));
  } catch (err) {
    next(err);
  }
});

router.post('/documentos/:id/rejeitar', authorize(['ADMIN']), (req, res, next) => {
  try {
    const motivo = String(req.body?.motivo ?? '').trim() || 'Rejeitado manualmente.';
    res.json(FiscalRepository.registrarRejeicao(param(req.params.id), motivo));
  } catch (err) {
    next(err);
  }
});

export default router;
