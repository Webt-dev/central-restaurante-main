import { Router } from 'express';
import authRoutes from './auth.routes.js';
import inventoryRoutes from './inventory.routes.js';
import menuItemRoutes from './menuItem.routes.js';
import tableRoutes from './table.routes.js';
import orderRoutes from './order.routes.js';
import kitchenRoutes from './kitchen.routes.js';
import cashierRoutes from './cashier.routes.js';
import systemRoutes from './system.routes.js';
import adminRoutes from './admin.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/menu-items', menuItemRoutes);
router.use('/tables', tableRoutes);
router.use('/orders', orderRoutes);
router.use('/kitchen', kitchenRoutes);
router.use('/cashier', cashierRoutes);
router.use('/system', systemRoutes);
router.use('/admin', adminRoutes);

export default router;
