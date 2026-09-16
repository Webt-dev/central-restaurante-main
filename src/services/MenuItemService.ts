import { MenuItemRepository } from '../repositories/MenuItemRepository.js';
import { MenuItem } from '../models/types.js';
import { randomUUID } from 'node:crypto';

export class MenuItemService {
  static listAll(): MenuItem[] {
    return MenuItemRepository.findAll();
  }

  static getById(id: string): MenuItem {
    const item = MenuItemRepository.findById(id);
    if (!item) {
      throw new Error('Item do cardápio não encontrado.');
    }
    return item;
  }

  static createItem(data: {
    name: string;
    description: string;
    price: number;
    category: string;
    ingredients?: { inventory_id: string; quantity_required: number }[];
  }): MenuItem {
    return MenuItemRepository.create(
      {
        id: randomUUID(),
        name: data.name,
        description: data.description,
        price: data.price,
        category: data.category,
        active: true
      },
      data.ingredients || []
    );
  }
}
