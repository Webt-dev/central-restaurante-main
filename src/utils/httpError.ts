/** Erro de negócio com status HTTP explícito (o errorHandler usa statusCode). */
export class HttpError extends Error {
  /** code: identificador estável para o frontend reagir (ex.: SUPERVISOR_REQUIRED). */
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
    this.name = 'HttpError';
  }
}
