import { InventoryRepository } from '../repositories/InventoryRepository.js';
import { InventoryItem } from '../models/types.js';
import { randomUUID } from 'node:crypto';

export class InventoryService {
  static listAll(): InventoryItem[] {
    return InventoryRepository.findAll();
  }

  static getLowStock(): InventoryItem[] {
    return InventoryRepository.findLowStock();
  }

  static createItem(data: { name: string; unit: string; quantity: number; min_quantity: number; unit_price: number }): InventoryItem {
    return InventoryRepository.create({
      id: randomUUID(),
      name: data.name,
      unit: data.unit,
      quantity: data.quantity,
      min_quantity: data.min_quantity,
      unit_price: data.unit_price
    });
  }

  static updateItem(id: string, data: Partial<Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>>): InventoryItem {
    const item = InventoryRepository.update(id, data);
    if (!item) {
      throw new Error('Item de estoque não encontrado.');
    }
    return item;
  }

  static adjustQuantity(id: string, deltaQuantity: number): InventoryItem {
    const item = InventoryRepository.findById(id);
    if (!item) {
      throw new Error('Item de estoque não encontrado.');
    }
    InventoryRepository.updateQuantity(id, deltaQuantity);
    return InventoryRepository.findById(id)!;
  }
}
