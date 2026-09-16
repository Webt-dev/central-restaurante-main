import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Obtém a pasta raiz principal 'Restaurante_Documentos' na Área de Trabalho (Desktop)
 * do computador do usuário, considerando todas as variações do Windows/Mac (OneDrive, Área de Trabalho, etc).
 */
export function getDocumentsRootDir(): string {
  const homeDir = os.homedir();
  
  const possibleDesktopPaths = [
    path.join(homeDir, 'Desktop'),
    path.join(homeDir, 'Área de Trabalho'),
    path.join(homeDir, 'OneDrive', 'Desktop'),
    path.join(homeDir, 'OneDrive', 'Área de Trabalho'),
    path.join(homeDir, 'Downloads')
  ];

  let desktopFound = '';
  for (const p of possibleDesktopPaths) {
    if (fs.existsSync(p)) {
      desktopFound = p;
      break;
    }
  }

  const baseDir = desktopFound
    ? path.join(desktopFound, 'Restaurante_Documentos')
    : path.join(process.cwd(), 'Restaurante_Documentos');

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  return baseDir;
}

/**
 * Retorna a pasta 'comprovantes_mesas/YYYY-MM-DD/' organizada por data dentro da Área de Trabalho.
 */
export function getReceiptsDirForDate(dateInput?: string | Date): string {
  const root = getDocumentsRootDir();
  const d = dateInput ? new Date(dateInput) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dateFormatted = `${year}-${month}-${day}`;

  const targetDir = path.join(root, 'comprovantes_mesas', dateFormatted);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  return targetDir;
}

/**
 * Retorna a pasta 'relatorios_expediente/YYYY-MM-DD/' organizada por data dentro da Área de Trabalho.
 */
export function getReportsDirForDate(dateInput?: string | Date): string {
  const root = getDocumentsRootDir();
  const d = dateInput ? new Date(dateInput) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dateFormatted = `${year}-${month}-${day}`;

  const targetDir = path.join(root, 'relatorios_expediente', dateFormatted);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  return targetDir;
}
