import { Injectable, NotFoundException } from '@nestjs/common';
import { WishlistRepository } from './wishlist.repository.js';
import type {
  WishlistItemResponse,
  WishlistResponse,
} from './wishlist.types.js';

@Injectable()
export class WishlistService {
  constructor(private readonly wishlistRepo: WishlistRepository) {}

  async getWishlist(userId: string): Promise<WishlistResponse> {
    const items = await this.wishlistRepo.findItemsByUserId(userId);
    return { items };
  }

  async addItem(
    userId: string,
    productId: string,
  ): Promise<WishlistItemResponse> {
    const item = await this.wishlistRepo.addItem(userId, productId);
    return { item };
  }

  async removeItem(userId: string, itemId: string): Promise<void> {
    const removed = await this.wishlistRepo.removeItem(userId, itemId);
    if (!removed) {
      throw new NotFoundException({
        code: 'WISHLIST_ITEM_NOT_FOUND',
        message: 'Wishlist item not found',
      });
    }
  }
}
