import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS } from '../events/event-bus.js';
import type { EventBus } from '../events/event-bus.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  buildCartUpdatedEvent,
  computeTotals,
  toCartDto,
} from './cart.mapper.js';
import { CartRepository } from './cart.repository.js';
import type { CartItemRow, CartRow } from './cart.repository.js';
import type { CartMergeResponse, CartTotals } from './cart.types.js';

@Injectable()
export class CartMergeService {
  private readonly logger = new Logger(CartMergeService.name);

  constructor(
    private readonly repository: CartRepository,
    private readonly settings: SettingsService,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
  ) {}

  async merge(
    userId: string,
    sessionId: string,
  ): Promise<CartMergeResponse> {
    const policy = await this.settings.getGuestMergeStrategy();
    const result = await this.repository.mergeActiveCarts(
      userId,
      sessionId,
      policy,
    );

    if (result.changed) {
      const items = await this.repository.findItems(result.cart.id);
      const totals = computeTotals(items);
      this.publishCartUpdated(result.cart, items, totals);
    }

    return { cart: toCartDto(result.cart) };
  }

  private publishCartUpdated(
    cart: CartRow,
    items: CartItemRow[],
    totals: CartTotals,
  ): void {
    try {
      this.eventBus.publish(buildCartUpdatedEvent(cart, items, totals));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not publish cart.updated: ${detail}`);
    }
  }
}
