import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * Impressão digital da máquina onde a central roda. A licença é emitida para
 * ela: copiar o banco/licença para outro computador não funciona.
 *
 * Windows: MachineGuid do registro (estável, muda só reinstalando o Windows).
 * Outros sistemas / falha: hostname + MACs físicos + CPU.
 */
let cached: string | null = null;

function windowsMachineGuid(): string | null {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    });
    return /MachineGuid\s+REG_SZ\s+([\w-]+)/i.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

function fallbackId(): string {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')
    .map(i => i!.mac)
    .sort();
  return [os.hostname(), os.cpus()[0]?.model ?? '', ...new Set(macs)].join('|');
}

export function machineFingerprint(): string {
  if (process.env.LICENSE_HW_OVERRIDE) return process.env.LICENSE_HW_OVERRIDE;
  if (!cached) {
    const raw = (process.platform === 'win32' ? windowsMachineGuid() : null) ?? fallbackId();
    cached = createHash('sha256').update(`central-restaurante:${raw}`).digest('hex').slice(0, 32);
  }
  return cached;
}
