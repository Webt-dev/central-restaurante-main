import { Router } from 'express';
import { MenuItemController, createMenuItemSchema } from '../controllers/MenuItemController.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';

const router = Router();

router.get('/', authenticate, MenuItemController.listAll);
router.get('/:id', authenticate, MenuItemController.getById);
router.post('/', authenticate, authorize(['ADMIN']), validateBody(createMenuItemSchema), MenuItemController.createItem);

export default router;
