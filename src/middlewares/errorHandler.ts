import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  console.error(`❌ Error handling [${req.method} ${req.path}]:`, err);

  const statusCode = err.statusCode || 400;
  const message = err.message || 'Ocorreu um erro interno no servidor.';

  res.status(statusCode).json({
    error: message
  });
}
