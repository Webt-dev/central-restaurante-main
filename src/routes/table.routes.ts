import { Router } from 'express';
import { TableController, createTableSchema, updateTableStatusSchema } from '../controllers/TableController.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';
import { requireLicenseToOccupy } from '../middlewares/licenseMiddleware.js';

const router = Router();

router.use(authenticate);

router.get('/', TableController.listAll);
router.get('/:id', TableController.getById);
router.post('/', authorize(['ADMIN']), validateBody(createTableSchema), TableController.createTable);
router.patch('/:id/status', authorize(['WAITER', 'CASHIER']), validateBody(updateTableStatusSchema), requireLicenseToOccupy, TableController.updateStatus);

export default router;
