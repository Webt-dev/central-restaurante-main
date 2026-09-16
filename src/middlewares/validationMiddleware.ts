import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        res.status(400).json({ error: 'Erro de validação dos dados de entrada.', details: issues });
        return;
      }
      res.status(400).json({ error: 'Payload de requisição inválido.' });
    }
  };
}
