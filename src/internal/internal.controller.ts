import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ServiceKeyGuard } from '../auth/guards/service-key.guard.js';
import { CartService } from '../cart/cart.service.js';

export interface ConvertCartResponse {
  cartId: string;
  convertedAt: string;
}

/**
 * Service-to-service routes. Never exposed through Nginx: only a service that
 * holds `INTERNAL_SERVICE_KEY` can reach them.
 */
@Controller('cart/internal')
@UseGuards(ServiceKeyGuard)
export class InternalCartController {
  constructor(private readonly cartService: CartService) {}

  /**
   * Converts the user's active cart after a confirmed order. 200 returns the
   * converted cart; 204 means there was nothing to convert, which makes the
   * call idempotent on replay and for a user who never had a cart.
   */
  @Post('carts/:userId/convert')
  @HttpCode(HttpStatus.OK)
  async convertCart(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConvertCartResponse | undefined> {
    const converted = await this.cartService.convertCart(userId);

    if (!converted) {
      response.status(HttpStatus.NO_CONTENT);
      return undefined;
    }

    return converted;
  }
}
