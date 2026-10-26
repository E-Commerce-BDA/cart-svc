import type { CartUpdatedEvent } from '../events/event-bus.js';
import type { CartItemRow, CartRow } from './cart.repository.js';
import type { CartDto, CartItemDto, CartTotals } from './cart.types.js';

export function toCartDto(cart: CartRow): CartDto {
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

export function buildCartUpdatedEvent(
  cart: CartRow,
  items: CartItemRow[],
  totals: CartTotals,
): CartUpdatedEvent {
  return {
    cartId: cart.id,
    userId: cart.user_id,
    sessionId: cart.session_id,
    status: cart.status,
    items: items.map(toItemDto),
    totals,
    updatedAt: cart.updated_at.toISOString(),
  };
}
