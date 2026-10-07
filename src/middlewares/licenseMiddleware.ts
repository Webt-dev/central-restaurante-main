import { Request, Response, NextFunction } from 'express';
import { getStatus } from '../license/LicenseService.js';

/**
 * Bloqueio por licença vencida (8º dia de atraso), avaliação terminada,
 * licença inválida ou relógio atrasado.
 *
 * Aplicado SÓ em abrir mesa e lançar pedido. Fechar conta, receber, emitir/
 * transmitir NFC-e, exportar dados e renovar a licença continuam liberados:
 * travar isso deixaria o restaurante sem cumprir obrigação fiscal e sem
 * acesso aos próprios dados.
 */
export function requireLicense(req: Request, res: Response, next: NextFunction): void {
  const status = getStatus();
  if (status.blocked) {
    res.status(402).json({ error: status.message, code: 'LICENSE_BLOCKED' });
    return;
  }
  next();
}

/** Ocupar mesa conta como "abrir mesa"; liberar mesa continua permitido. */
export function requireLicenseToOccupy(req: Request, res: Response, next: NextFunction): void {
  if (req.body?.status === 'OCCUPIED') return requireLicense(req, res, next);
  next();
}
