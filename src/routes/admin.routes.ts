import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { AdminRepository } from '../repositories/AdminRepository.js';
import { emitEvent } from '../sockets/socketManager.js';
import { auditRequest } from '../services/AuditService.js';
import { db } from '../config/database.js';
import lgpdRoutes from './lgpd.routes.js';
import { createBackup, listBackups, BACKUP_DIR } from '../services/BackupService.js';

const router = Router();

router.use(authenticate);

// Configurações são lidas por todas as telas (taxa de serviço, formas de
// pagamento, tema). Todo o resto deste router é exclusivo do ADMIN.
router.get('/settings', (req, res, next) => {
  try {
    res.json(AdminRepository.getSettings());
  } catch (err) {
    next(err);
  }
});

router.use(authorize(['ADMIN']));

// LGPD: consulta e anonimização por CPF do titular.
router.use('/lgpd', lgpdRoutes);

function param(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function findRow(table: 'tables' | 'menu_items' | 'inventory', id: string): unknown {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

/** Código fiscal só com números, de tamanho fixo, ou vazio (= usar o padrão). */
const fiscalCode = (size: number, message: string) =>
  z.string().trim().transform(v => v.replace(/\D/g, '')).refine(v => v === '' || v.length === size, message).optional();

const money = z.coerce.number().finite().min(0, 'O valor não pode ser negativo').max(100_000);
const qty = z.coerce.number().finite().min(0, 'A quantidade não pode ser negativa').max(10_000_000);

const tableSchema = z.object({
  number: z.coerce.number().int().min(1, 'Informe um número de mesa válido.').max(9999),
  name: z.string().trim().max(60).optional().default('')
});

const menuSchema = z.object({
  name: z.string().trim().min(1, 'Nome é obrigatório').max(120),
  description: z.string().trim().max(500).optional().default(''),
  price: money.refine(v => v > 0, 'O preço deve ser maior que zero'),
  category: z.string().trim().min(1, 'Categoria é obrigatória').max(60),
  active: z.boolean().optional(),
  // Dados fiscais (NFC-e). Vazio = usa o padrão da configuração fiscal; NCM é obrigatório para emitir.
  ncm: fiscalCode(8, 'NCM deve ter 8 números'),
  cfop: fiscalCode(4, 'CFOP deve ter 4 números'),
  cest: fiscalCode(7, 'CEST deve ter 7 números'),
  csosn: fiscalCode(3, 'CSOSN deve ter 3 números'),
  cst_icms: fiscalCode(2, 'CST de ICMS deve ter 2 números'),
  cst_pis_cofins: fiscalCode(2, 'CST de PIS/COFINS deve ter 2 números'),
  origem: fiscalCode(1, 'Origem deve ter 1 número'),
  gtin: z.string().trim().regex(/^(\d{8}|\d{12,14})?$/, 'GTIN deve ter 8, 12, 13 ou 14 números').optional()
});

const inventorySchema = z.object({
  name: z.string().trim().min(1, 'Nome do insumo é obrigatório').max(120),
  unit: z.string().trim().min(1, 'Unidade é obrigatória').max(20),
  quantity: qty.default(0),
  min_quantity: qty.default(0),
  unit_price: money.default(0),
  reason: z.string().trim().max(200).optional()
});

const restockSchema = z.object({
  quantity: qty.refine(v => v > 0, 'Informe a quantidade a repor.'),
  reason: z.string().trim().max(200).optional()
});

const settingsSchema = z.object({
  restaurant_name: z.string().trim().max(120).optional(),
  cnpj: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(200).optional(),
  service_tax_percent: z.coerce.number().finite().min(0).max(30, 'A taxa de serviço deve ser um número entre 0 e 30.').optional(),
  payment_methods_allowed: z.array(z.string()).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional()
});

// ==========================================
// 1. MESAS
// ==========================================
router.post('/tables', validateBody(tableSchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const table = AdminRepository.addTable(req.body.number, req.body.name);
    auditRequest(req, { action: 'table.create', entity: 'table', entityId: table.id, after: table });
    emitEvent('tables:updated');
    res.status(201).json(table);
  } catch (err) {
    next(err);
  }
});

router.put('/tables/:id', validateBody(tableSchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const id = param(req.params.id);
    const before = findRow('tables', id);
    const table = AdminRepository.updateTable(id, req.body.number, req.body.name);
    auditRequest(req, { action: 'table.update', entity: 'table', entityId: id, before, after: table });
    emitEvent('tables:updated');
    res.json(table);
  } catch (err) {
    next(err);
  }
});

router.delete('/tables/:id', (req: AuthenticatedRequest, res, next) => {
  try {
    const id = param(req.params.id);
    const before = findRow('tables', id);
    AdminRepository.deleteTable(id);
    auditRequest(req, { action: 'table.delete', entity: 'table', entityId: id, before });
    emitEvent('tables:updated');
    res.json({ success: true, message: 'Mesa excluída com sucesso.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 2. CARDÁPIO
// ==========================================
router.post('/menu', validateBody(menuSchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const item = AdminRepository.addMenuItem(req.body);
    auditRequest(req, { action: 'menu.create', entity: 'menu_item', entityId: item.id, after: item });
    emitEvent('menu:updated');
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

router.put('/menu/:id', validateBody(menuSchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const id = param(req.params.id);
    const before = findRow('menu_items', id);
    if (!before) return res.status(404).json({ error: 'Item do cardápio não encontrado.' });
    const item = AdminRepository.updateMenuItem(id, req.body);
    auditRequest(req, { action: 'menu.update', entity: 'menu_item', entityId: id, before, after: item });
    emitEvent('menu:updated');
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.delete('/menu/:id', (req: AuthenticatedRequest, res, next) => {
  try {
    const id = param(req.params.id);
    const before = findRow('menu_items', id);
    if (!before) return res.status(404).json({ error: 'Item do cardápio não encontrado.' });
    AdminRepository.deleteMenuItem(id);
    auditRequest(req, { action: 'menu.delete', entity: 'menu_item', entityId: id, before });
    emitEvent('menu:updated');
    res.json({ success: true, message: 'Item removido do cardápio.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 3. ESTOQUE
// ==========================================
router.post('/inventory', validateBody(inventorySchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const { reason, ...data } = req.body;
    const item = AdminRepository.addInventoryItem(data, { userId: req.user!.userId, note: reason });
    auditRequest(req, { action: 'inventory.create', entity: 'inventory', entityId: item.id, after: item, reason });
    emitEvent('inventory:updated');
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

router.put('/inventory/:id', validateBody(inventorySchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const id = param(req.params.id);
    const before = findRow('inventory', id);
    if (!before) return res.status(404).json({ error: 'Insumo não encontrado.' });
    const { reason, ...data } = req.body;
    const item = AdminRepository.updateInventoryItem(id, data, { userId: req.user!.userId, note: reason });
    auditRequest(req, { action: 'inventory.update', entity: 'inventory', entityId: id, before, after: item, reason });
    emitEvent('inventory:updated');
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.post('/inventory/:id/restock', validateBody(restockSchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const id = param(req.params.id);
    const before = findRow('inventory', id);
    if (!before) return res.status(404).json({ error: 'Insumo não encontrado.' });
    const item = AdminRepository.restockItem(id, req.body.quantity, { userId: req.user!.userId, note: req.body.reason });
    auditRequest(req, { action: 'inventory.restock', entity: 'inventory', entityId: id, before, after: item, reason: req.body.reason });
    emitEvent('inventory:updated');
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.delete('/inventory/:id', (req: AuthenticatedRequest, res, next) => {
  try {
    const id = param(req.params.id);
    const before = findRow('inventory', id);
    if (!before) return res.status(404).json({ error: 'Insumo não encontrado.' });
    AdminRepository.deleteInventoryItem(id);
    auditRequest(req, { action: 'inventory.delete', entity: 'inventory', entityId: id, before });
    emitEvent('inventory:updated');
    res.json({ success: true, message: 'Insumo removido do estoque.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 4. BACKUPS
// ==========================================
router.get('/backups', (req, res) => {
  res.json({ folder: BACKUP_DIR, backups: listBackups() });
});

router.post('/backups', async (req: AuthenticatedRequest, res, next) => {
  try {
    const file = await createBackup(db, 'manual');
    auditRequest(req, { action: 'backup.create', entity: 'backup', after: { file } });
    res.status(201).json({ file, backups: listBackups() });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 5. CONFIGURAÇÕES DO RESTAURANTE
// ==========================================
router.put('/settings', validateBody(settingsSchema), (req: AuthenticatedRequest, res, next) => {
  try {
    const payload = { ...req.body };
    if (payload.service_tax_percent !== undefined) {
      payload.service_tax_percent = Number(payload.service_tax_percent.toFixed(2));
    }

    const before = AdminRepository.getSettings();
    const updated = AdminRepository.updateSettings(payload);
    auditRequest(req, { action: 'settings.update', entity: 'settings', before, after: updated });
    emitEvent('settings:updated', updated);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
