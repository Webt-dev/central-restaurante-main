import { Router } from 'express';
import { KitchenController, updateItemStatusSchema, updateBatchStatusSchema } from '../controllers/KitchenController.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { authenticate } from '../middlewares/authMiddleware.js';

const router = Router();

router.use(authenticate);

router.get('/queue', KitchenController.getKitchenQueue);
router.get('/bar-queue', KitchenController.getBarQueue);
router.patch('/item/:itemId/status', validateBody(updateItemStatusSchema), KitchenController.updateItemStatus);
router.patch('/order/:orderId/batch-status', validateBody(updateBatchStatusSchema), KitchenController.updateOrderBatchStatus);

export default router;
