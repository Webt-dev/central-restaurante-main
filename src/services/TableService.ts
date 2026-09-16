import { TableRepository } from '../repositories/TableRepository.js';
import { Table, TableStatus } from '../models/types.js';
import { notifyTableStatusChanged } from '../sockets/socketManager.js';
import { randomUUID } from 'node:crypto';

export class TableService {
  static listAll(): Table[] {
    return TableRepository.findAll();
  }

  static getById(id: string): Table {
    const table = TableRepository.findById(id);
    if (!table) {
      throw new Error('Mesa não encontrada.');
    }
    return table;
  }

  static createTable(number: number, name?: string): Table {
    const existing = TableRepository.findByNumber(number);
    if (existing) {
      throw new Error(`Mesa com número ${number} já existe.`);
    }

    const table = TableRepository.create({
      id: randomUUID(),
      number,
      name: name || `Mesa ${number}`,
      status: 'FREE'
    });

    notifyTableStatusChanged(table);
    return table;
  }

  static updateStatus(id: string, status: TableStatus): Table {
    const table = TableRepository.updateStatus(id, status);
    if (!table) {
      throw new Error('Mesa não encontrada.');
    }

    notifyTableStatusChanged(table);
    return table;
  }
}
