import { Injectable, Logger } from '@nestjs/common';
import type { CartItemDto, CartTotals } from '../cart/cart.types.js';

export const EVENT_BUS = Symbol('EVENT_BUS');

export interface CartUpdatedEvent {
  cartId: string;
  userId: string | null;
  sessionId: string | null;
  status: string;
  items: CartItemDto[];
  totals: CartTotals;
  updatedAt: string;
}

export interface EventBus {
  publish(event: CartUpdatedEvent): void;
}

/**
 * v1 event adapter. The service publishes after commit and never awaits the
 * broker; a future Kafka adapter can replace this provider without touching
 * cart behavior.
 */
@Injectable()
export class NoopEventBus implements EventBus {
  private readonly logger = new Logger(NoopEventBus.name);

  publish(event: CartUpdatedEvent): void {
    this.logger.debug(
      `cart.updated ${event.cartId} (${event.items.length} lines)`,
    );
  }
}
