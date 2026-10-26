import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CartIdentity } from '../auth/guards/cart-identity.guard.js';
import { EVENT_BUS } from '../events/event-bus.js';
import type { CartUpdatedEvent, EventBus } from '../events/event-bus.js';
import { CATALOG_CLIENT } from './catalog.client.js';
import type { CatalogClient } from './catalog.client.js';
import { CartRepository } from './cart.repository.js';
import type { CartItemRow, CartRow } from './cart.repository.js';
import type {
  CartDto,
  CartItemDto,
  CartMutationResponse,
  CartResponse,
  CartTotals,
} from './cart.types.js';

export interface AddItemInput {
  productId: string;
  variantId?: string | null;
  qty: number;
}

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly repository: CartRepository,
    @Inject(CATALOG_CLIENT) private readonly catalog: CatalogClient,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
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
    const items = await this.repository.findItems(cart.id);
    const totals = computeTotals(items);

    this.publishCartUpdated(mutation.cart, items, totals);

    return { item: toItemDto(mutation.item), cartTotals: totals };
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

    const items = await this.repository.findItems(cart.id);
    const totals = computeTotals(items);

    this.publishCartUpdated(mutation.cart, items, totals);

    return { item: toItemDto(mutation.item), cartTotals: totals };
  }

  async removeItem(identity: CartIdentity, itemId: string): Promise<void> {
    const cart = await this.requireActiveCart(identity);
    const updatedCart = await this.repository.deleteItem(cart.id, itemId);

    if (!updatedCart) {
      throw itemNotFound();
    }

    const items = await this.repository.findItems(cart.id);
    const totals = computeTotals(items);

    this.publishCartUpdated(updatedCart, items, totals);
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

    const items = await this.repository.findItems(cart.id);
    const totals = computeTotals(items);

    this.publishCartUpdated(result.cart, items, totals);
  }

  async clearCart(identity: CartIdentity): Promise<void> {
    const cart = await this.repository.findActiveCart(identity);
    if (!cart) {
      return;
    }

    const result = await this.repository.clearItems(cart.id);
    const items = await this.repository.findItems(cart.id);
    const totals = computeTotals(items);

    if (result.cart) {
      this.publishCartUpdated(result.cart, items, totals);
    }
  }

  private async requireActiveCart(identity: CartIdentity): Promise<CartRow> {
    const cart = await this.repository.findActiveCart(identity);
    if (!cart) {
      throw itemNotFound();
    }
    return cart;
  }

  private publishCartUpdated(
    cart: CartRow,
    items: CartItemRow[],
    totals: CartTotals,
  ): void {
    const event: CartUpdatedEvent = {
      cartId: cart.id,
      userId: cart.user_id,
      sessionId: cart.session_id,
      status: cart.status,
      items: items.map(toItemDto),
      totals,
      updatedAt: cart.updated_at.toISOString(),
    };

    try {
      this.eventBus.publish(event);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not publish cart.updated: ${detail}`);
    }
  }
}

export function computeTotals(items: CartItemRow[]): CartTotals {
  let subtotalCents = 0;
  let itemCount = 0;

  for (const item of items) {
    const unitPriceCents = Math.round(Number(item.unit_price) * 100);
    subtotalCents += unitPriceCents * item.qty;
    itemCount += item.qty;
  }

  return {
    subtotal: Number((subtotalCents / 100).toFixed(2)),
    itemCount,
    lineCount: items.length,
  };
}

function toCartDto(cart: CartRow): CartDto {
  return {
    id: cart.id,
    userId: cart.user_id,
    sessionId: cart.session_id,
    status: cart.status,
    lastActivityAt: cart.last_activity_at.toISOString(),
    createdAt: cart.created_at.toISOString(),
    updatedAt: cart.updated_at.toISOString(),
  };
}

export function toItemDto(item: CartItemRow): CartItemDto {
  return {
    id: item.id,
    productId: item.product_id,
    variantId: item.variant_id,
    qty: item.qty,
    unitPrice: Number(item.unit_price),
    productName: item.product_name,
    productSlug: item.product_slug,
    imageUrl: item.image_url,
    variantLabel: item.variant_label,
    addedAt: item.added_at.toISOString(),
  };
}

function itemNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'CART_ITEM_NOT_FOUND',
    message: 'Cart item not found',
  });
}
