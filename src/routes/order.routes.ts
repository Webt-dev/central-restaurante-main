import { Router } from 'express';
import { OrderController, createOrderSchema, syncBatchOrdersSchema, updateQuantitySchema } from '../controllers/OrderController.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { requireLicense } from '../middlewares/licenseMiddleware.js';

const router = Router();

router.use(authenticate);

router.post('/', authorize(['WAITER', 'CASHIER']), requireLicense, validateBody(createOrderSchema), OrderController.createOrder);
router.post('/sync-batch', authorize(['WAITER', 'CASHIER']), requireLicense, validateBody(syncBatchOrdersSchema), OrderController.syncBatch);
router.get('/table/:tableId/bill', authorize(['WAITER', 'CASHIER']), OrderController.getTableBill);
router.delete('/item/:itemId', authorize(['CASHIER', 'WAITER']), OrderController.deleteItem);
router.patch('/item/:itemId/quantity', authorize(['CASHIER', 'WAITER']), validateBody(updateQuantitySchema), OrderController.updateItemQuantity);
router.get('/:id', authorize(['WAITER', 'CASHIER', 'KITCHEN']), OrderController.getOrderById);

export default router;
