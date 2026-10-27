import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WishlistRepository } from './wishlist.repository.js';
import { WishlistService } from './wishlist.service.js';

describe('WishlistService', () => {
  let service: WishlistService;
  let repo: {
    findItemsByUserId: ReturnType<typeof vi.fn>;
    addItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
  };

  const userId = '11111111-1111-4111-8111-111111111111';
  const productId = '22222222-2222-4222-8222-222222222222';
  const itemId = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    repo = {
      findItemsByUserId: vi.fn(),
      addItem: vi.fn(),
      removeItem: vi.fn(),
    };
    service = new WishlistService(repo as unknown as WishlistRepository);
  });

  describe('getWishlist', () => {
    it('returns empty array when user has no wishlist rows', async () => {
      repo.findItemsByUserId.mockResolvedValueOnce([]);
      const result = await service.getWishlist(userId);
      expect(result).toEqual({ items: [] });
      expect(repo.findItemsByUserId).toHaveBeenCalledWith(userId);
    });

    it('returns populated items when user has saved products', async () => {
      const mockItems = [
        {
          id: itemId,
          productId,
          addedAt: '2026-10-27T10:00:00.000Z',
        },
      ];
      repo.findItemsByUserId.mockResolvedValueOnce(mockItems);
      const result = await service.getWishlist(userId);
      expect(result).toEqual({ items: mockItems });
    });
  });

  describe('addItem', () => {
    it('returns added item response', async () => {
      const mockItem = {
        id: itemId,
        productId,
        addedAt: '2026-10-27T10:00:00.000Z',
      };
      repo.addItem.mockResolvedValueOnce(mockItem);
      const result = await service.addItem(userId, productId);
      expect(result).toEqual({ item: mockItem });
      expect(repo.addItem).toHaveBeenCalledWith(userId, productId);
    });
  });

  describe('removeItem', () => {
    it('succeeds when item was removed', async () => {
      repo.removeItem.mockResolvedValueOnce(true);
      await expect(service.removeItem(userId, itemId)).resolves.toBeUndefined();
      expect(repo.removeItem).toHaveBeenCalledWith(userId, itemId);
    });

    it('throws NotFoundException with WISHLIST_ITEM_NOT_FOUND code when item missing or foreign', async () => {
      repo.removeItem.mockResolvedValueOnce(false);
      await expect(service.removeItem(userId, itemId)).rejects.toThrow(
        NotFoundException,
      );

      try {
        await service.removeItem(userId, itemId);
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        const res = (err as NotFoundException).getResponse() as {
          code: string;
          message: string;
        };
        expect(res.code).toBe('WISHLIST_ITEM_NOT_FOUND');
      }
    });
  });
});
