import { Router } from 'express';
import { InventoryController, createInventorySchema, adjustInventorySchema } from '../controllers/InventoryController.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';

const router = Router();

router.use(authenticate);

router.get('/', InventoryController.listAll);
router.get('/alerts', InventoryController.getLowStock);
router.post('/', authorize(['ADMIN']), validateBody(createInventorySchema), InventoryController.createItem);
router.patch('/:id/adjust', authorize(['ADMIN', 'KITCHEN']), validateBody(adjustInventorySchema), InventoryController.adjustQuantity);

export default router;
