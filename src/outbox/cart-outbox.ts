import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { OutboxStorePort, Queryable } from '@ecom/messaging';
import { OUTBOX_STORE } from '@ecom/messaging/nest';
import { buildCartUpdatedEvent, computeTotals } from '../cart/cart.mapper.js';
import type { CartItemRow, CartRow } from '../cart/cart.repository.js';

/**
 * Writes the `cart.updated` event into `cart.outbox`.
 *
 * The write must happen inside the transaction that mutated the cart, so the
 * event and the cart state commit or roll back together. Callers hand in the
 * items they read from the same snapshot, so the payload and the committed
 * row can never disagree.
 */
@Injectable()
export class CartOutbox {
  constructor(@Inject(OUTBOX_STORE) private readonly store: OutboxStorePort) {}

  async record(
    client: Queryable,
    cart: CartRow,
    items: CartItemRow[],
  ): Promise<string> {
    return this.store.write(client, {
      topic: 'cart.updated',
      eventId: uuidv7(),
      aggregateType: 'cart',
      // Keyed by cartId: the topic's registry entry fixes partitions and key.
      aggregateId: cart.id,
      // The mutation's own timestamp, not wall clock at publish time.
      occurredAt: cart.updated_at,
      payload: buildCartUpdatedEvent(cart, items, computeTotals(items)),
    });
  }
}
