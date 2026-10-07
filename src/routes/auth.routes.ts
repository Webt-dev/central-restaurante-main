import { Router } from 'express';
import {
  AuthController,
  loginSchema,
  setupSchema,
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  changeOwnCredentialsSchema,
  setPinSchema
} from '../controllers/AuthController.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';

const router = Router();

// Públicas
router.post('/login', validateBody(loginSchema), AuthController.login);
router.get('/setup-status', AuthController.setupStatus);
router.post('/setup', validateBody(setupSchema), AuthController.setup);

// Sessão atual
router.get('/me', authenticate, AuthController.me);
router.post('/logout', authenticate, AuthController.logout);
router.post('/me/credentials', authenticate, validateBody(changeOwnCredentialsSchema), AuthController.changeOwnCredentials);
router.post('/me/pin', authenticate, authorize(['ADMIN']), validateBody(setPinSchema), AuthController.setOwnPin);

// Gestão de usuários (somente ADMIN)
router.get('/users', authenticate, authorize(['ADMIN']), AuthController.listUsers);
router.post('/users', authenticate, authorize(['ADMIN']), validateBody(createUserSchema), AuthController.createUser);
router.put('/users/:id', authenticate, authorize(['ADMIN']), validateBody(updateUserSchema), AuthController.updateUser);
router.post('/users/:id/reset-password', authenticate, authorize(['ADMIN']), validateBody(resetPasswordSchema), AuthController.resetPassword);

export default router;
