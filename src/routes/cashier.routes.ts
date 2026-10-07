import { Router } from 'express';
import {
  CashierController,
  openSessionSchema,
  closeSessionSchema,
  processPaymentSchema,
  cashMovementSchema,
  closeExpedientSchema
} from '../controllers/CashierController.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';

const router = Router();

// Todo o caixa é restrito a CASHIER (e ADMIN).
router.use(authenticate, authorize(['CASHIER']));

router.get('/session', CashierController.getActiveSession);
router.post('/session/open', validateBody(openSessionSchema), CashierController.openSession);
router.post('/session/close', validateBody(closeSessionSchema), CashierController.closeSession);
router.post('/payment', validateBody(processPaymentSchema), CashierController.processPayment);
router.get('/receipt/order/:orderId', CashierController.reprintReceipt);
router.get('/table-bill/:tableId/print', CashierController.printTableBill);
router.get('/report', CashierController.getDailyReport);
router.post('/cash-movements', validateBody(cashMovementSchema), CashierController.addCashMovement);
router.post('/close-expedient', validateBody(closeExpedientSchema), CashierController.closeDailyExpedient);

export default router;
