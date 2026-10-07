import { Request, Response, NextFunction } from 'express';

/**
 * Erros de negócio (HttpError ou Error comum lançado pelos repositórios)
 * mantêm a mensagem para o usuário. Erros do SQLite e afins viram uma
 * mensagem genérica com status 500, sem expor detalhes internos.
 */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  console.error(`❌ Erro [${req.method} ${req.path}]:`, err?.message ?? err);

  const isInternal = typeof err?.code === 'string' && err.code.startsWith('SQLITE_');
  if (isInternal || err instanceof TypeError || err instanceof RangeError) {
    res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    return;
  }

  res.status(err?.statusCode || 400).json({
    error: err?.message || 'Requisição inválida.',
    ...(err?.code && typeof err.code === 'string' ? { code: err.code } : {})
  });
}
