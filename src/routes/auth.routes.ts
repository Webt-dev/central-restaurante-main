import { Router } from 'express';
import { AuthController, loginSchema, createUserSchema } from '../controllers/AuthController.js';
import { validateBody } from '../middlewares/validationMiddleware.js';
import { authenticate, authorize } from '../middlewares/authMiddleware.js';

const router = Router();

router.post('/login', validateBody(loginSchema), AuthController.login);
router.post('/register', authenticate, authorize(['ADMIN']), validateBody(createUserSchema), AuthController.createUser);
router.get('/users', authenticate, authorize(['ADMIN']), AuthController.listUsers);

export default router;
