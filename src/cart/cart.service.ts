import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CartIdentity } from '../auth/guards/cart-identity.guard.js';
import { CATALOG_CLIENT } from './catalog.client.js';
import type { CatalogClient } from './catalog.client.js';
import {
  computeTotals,
  toCartDto,
  toItemDto,
} from './cart.mapper.js';
import { CartRepository } from './cart.repository.js';
import type { CartRow } from './cart.repository.js';
import type { CartMutationResponse, CartResponse } from './cart.types.js';

export interface AddItemInput {
  productId: string;
  variantId?: string | null;
  qty: number;
}

@Injectable()
export class CartService {
  constructor(
    private readonly repository: CartRepository,
    @Inject(CATALOG_CLIENT) private readonly catalog: CatalogClient,
  ) {}

  async getCart(identity: CartIdentity): Promise<CartResponse> {
    const cart = await this.repository.ensureActiveCart(identity);
    const items = await this.repository.findItems(cart.id);

    return {
      cart: toCartDto(cart),
      items: items.map(toItemDto),
      totals: computeTotals(items),
    };
  }

  async addItem(
    identity: CartIdentity,
    input: AddItemInput,
  ): Promise<CartMutationResponse> {
    const snapshot = await this.catalog.getProduct(
      input.productId,
      input.variantId ?? null,
    );

    if (!snapshot || !snapshot.available) {
      throw new UnprocessableEntityException({
        code: 'CART_PRODUCT_UNAVAILABLE',
        message: 'Product is unavailable',
      });
    }

    const cart = await this.repository.ensureActiveCart(identity);
    const mutation = await this.repository.addItem(
      cart.id,
      snapshot,
      input.qty,
    );

    // Totals come from the mutation's own snapshot, the same one the outbox
    // payload reports, so the response and the event cannot disagree.
    return {
      item: toItemDto(mutation.item),
      cartTotals: computeTotals(mutation.items),
    };
  }

  async updateItem(
    identity: CartIdentity,
    itemId: string,
    qty: number,
  ): Promise<CartMutationResponse> {
    const cart = await this.requireActiveCart(identity);
    const mutation = await this.repository.updateItemQty(
      cart.id,
      itemId,
      qty,
    );

    if (!mutation) {
      throw itemNotFound();
    }

    return {
      item: toItemDto(mutation.item),
      cartTotals: computeTotals(mutation.items),
    };
  }

  async removeItem(identity: CartIdentity, itemId: string): Promise<void> {
    const cart = await this.requireActiveCart(identity);
    const updatedCart = await this.repository.deleteItem(cart.id, itemId);

    if (!updatedCart) {
      throw itemNotFound();
    }
  }

  async removeItems(identity: CartIdentity, ids: string[]): Promise<void> {
    const cart = await this.repository.findActiveCart(identity);
    if (!cart) {
      throw itemNotFound();
    }

    const result = await this.repository.deleteItems(cart.id, ids);
    if (result.deletedCount === 0 || !result.cart) {
      throw itemNotFound();
    }
  }

  async clearCart(identity: CartIdentity): Promise<void> {
    const cart = await this.repository.findActiveCart(identity);
    if (!cart) {
      return;
    }

    await this.repository.clearItems(cart.id);
  }

  /**
   * Phase-0 conversion bridge for checkout (ca-007). Returns the converted cart
   * so the caller can log it; `null` means the user had nothing to convert, and
   * a replay therefore stays silent. Replaced by the `order.created` consumer
   * in ca-009.
   */
  async convertCart(
    userId: string,
  ): Promise<{ cartId: string; convertedAt: string } | null> {
    const cart = await this.repository.convertActiveCart(userId);
    if (!cart) {
      return null;
    }

    return {
      cartId: cart.id,
      convertedAt: cart.last_activity_at.toISOString(),
    };
  }

  private async requireActiveCart(identity: CartIdentity): Promise<CartRow> {
    const cart = await this.repository.findActiveCart(identity);
    if (!cart) {
      throw itemNotFound();
    }
    return cart;
  }
}

function itemNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'CART_ITEM_NOT_FOUND',
    message: 'Cart item not found',
  });
}
