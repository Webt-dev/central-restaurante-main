import { Router } from 'express';
import { authenticate } from '../middlewares/authMiddleware.js';
import { AdminRepository } from '../repositories/AdminRepository.js';
import { emitEvent } from '../sockets/socketManager.js';

const router = Router();

// Todas as rotas administrativas exigem autenticação
router.use(authenticate);

// ==========================================
// 1. MESAS
// ==========================================
router.post('/tables', (req, res, next) => {
  try {
    const { number, name } = req.body;
    if (!number || isNaN(Number(number))) {
      return res.status(400).json({ error: 'Informe um número de mesa válido.' });
    }
    const table = AdminRepository.addTable(Number(number), name);
    emitEvent('tables:updated');
    res.status(201).json(table);
  } catch (err) {
    next(err);
  }
});

router.put('/tables/:id', (req, res, next) => {
  try {
    const { number, name } = req.body;
    if (!number || isNaN(Number(number))) {
      return res.status(400).json({ error: 'Informe um número de mesa válido.' });
    }
    const table = AdminRepository.updateTable(req.params.id, Number(number), name);
    emitEvent('tables:updated');
    res.json(table);
  } catch (err) {
    next(err);
  }
});

router.delete('/tables/:id', (req, res, next) => {
  try {
    AdminRepository.deleteTable(req.params.id);
    emitEvent('tables:updated');
    res.json({ success: true, message: 'Mesa excluída com sucesso.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 2. CARDÁPIO
// ==========================================
router.post('/menu', (req, res, next) => {
  try {
    const { name, description, price, category } = req.body;
    if (!name || price === undefined || !category) {
      return res.status(400).json({ error: 'Nome, preço e categoria são obrigatórios.' });
    }
    const item = AdminRepository.addMenuItem({
      name,
      description: description || '',
      price: Number(price),
      category
    });
    emitEvent('menu:updated');
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

router.put('/menu/:id', (req, res, next) => {
  try {
    const { name, description, price, category, active } = req.body;
    const item = AdminRepository.updateMenuItem(req.params.id, {
      name,
      description: description || '',
      price: Number(price),
      category,
      active
    });
    emitEvent('menu:updated');
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.delete('/menu/:id', (req, res, next) => {
  try {
    AdminRepository.deleteMenuItem(req.params.id);
    emitEvent('menu:updated');
    res.json({ success: true, message: 'Item removido do cardápio.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 3. ESTOQUE
// ==========================================
router.post('/inventory', (req, res, next) => {
  try {
    const { name, unit, quantity, min_quantity, unit_price } = req.body;
    if (!name || !unit) {
      return res.status(400).json({ error: 'Nome do insumo e unidade de medida são obrigatórios.' });
    }
    const item = AdminRepository.addInventoryItem({
      name,
      unit,
      quantity: Number(quantity || 0),
      min_quantity: Number(min_quantity || 0),
      unit_price: Number(unit_price || 0)
    });
    emitEvent('inventory:updated');
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

router.put('/inventory/:id', (req, res, next) => {
  try {
    const { name, unit, quantity, min_quantity, unit_price } = req.body;
    const item = AdminRepository.updateInventoryItem(req.params.id, {
      name,
      unit,
      quantity: Number(quantity),
      min_quantity: Number(min_quantity),
      unit_price: Number(unit_price)
    });
    emitEvent('inventory:updated');
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.post('/inventory/:id/restock', (req, res, next) => {
  try {
    const { quantity } = req.body;
    if (!quantity || isNaN(Number(quantity))) {
      return res.status(400).json({ error: 'Informe a quantidade a repor.' });
    }
    const item = AdminRepository.restockItem(req.params.id, Number(quantity));
    emitEvent('inventory:updated');
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.delete('/inventory/:id', (req, res, next) => {
  try {
    AdminRepository.deleteInventoryItem(req.params.id);
    emitEvent('inventory:updated');
    res.json({ success: true, message: 'Insumo removido do estoque.' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 4. CONFIGURAÇÕES DO RESTAURANTE
// ==========================================
router.get('/settings', (req, res, next) => {
  try {
    res.json(AdminRepository.getSettings());
  } catch (err) {
    next(err);
  }
});

router.put('/settings', (req, res, next) => {
  try {
    const payload = { ...req.body };

    // Validação da taxa de serviço (gorjeta): aceita 0 (desativada) até 30%.
    if (payload.service_tax_percent !== undefined) {
      const pct = Number(String(payload.service_tax_percent).replace(',', '.'));
      if (!isFinite(pct) || pct < 0 || pct > 30) {
        return res.status(400).json({ error: 'A taxa de serviço deve ser um número entre 0 e 30.' });
      }
      payload.service_tax_percent = Number(pct.toFixed(2));
    }

    // Dinheiro é obrigatório por lei e não pode ser desativado.
    if (Array.isArray(payload.payment_methods_allowed) && !payload.payment_methods_allowed.includes('CASH')) {
      payload.payment_methods_allowed = ['CASH', ...payload.payment_methods_allowed];
    }

    const updated = AdminRepository.updateSettings(payload);
    emitEvent('settings:updated', updated);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 5. CREDENCIAIS DO ADMINISTRADOR
// ==========================================
router.post('/change-credentials', (req: any, res, next) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }
    const { currentPassword, newUsername, newPassword } = req.body;
    AdminRepository.changeAdminCredentials(userId, { currentPassword, newUsername, newPassword });
    res.json({ success: true, message: 'Usuário e senha alterados com sucesso.' });
  } catch (err) {
    next(err);
  }
});

export default router;
