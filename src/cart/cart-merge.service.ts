import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service.js';
import { toCartDto } from './cart.mapper.js';
import { CartRepository } from './cart.repository.js';
import type { CartMergeResponse } from './cart.types.js';

@Injectable()
export class CartMergeService {
  constructor(
    private readonly repository: CartRepository,
    private readonly settings: SettingsService,
  ) {}

  async merge(
    userId: string,
    sessionId: string,
  ): Promise<CartMergeResponse> {
    const policy = await this.settings.getGuestMergeStrategy();
    // A merge that changes nothing records nothing: the repository writes the
    // outbox row only on the branches that mutate the cart.
    const result = await this.repository.mergeActiveCarts(
      userId,
      sessionId,
      policy,
    );

    return { cart: toCartDto(result.cart) };
  }
}
