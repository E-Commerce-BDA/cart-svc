import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CartIdentityGuard } from '../auth/guards/cart-identity.guard.js';
import type {
  CartIdentity,
  CartRequest,
} from '../auth/guards/cart-identity.guard.js';
import { CartService } from './cart.service.js';
import type {
  CartMutationResponse,
  CartResponse,
} from './cart.types.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import { RemoveCartItemsDto } from './dto/remove-cart-items.dto.js';
import { UpdateCartItemDto } from './dto/update-cart-item.dto.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

@Controller('cart')
@UseGuards(CartIdentityGuard)
@UseInterceptors(IdempotencyInterceptor)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  getCart(@Req() request: CartRequest): Promise<CartResponse> {
    return this.cartService.getCart(requireIdentity(request));
  }

  @Post('items')
  @HttpCode(201)
  addItem(
    @Req() request: CartRequest,
    @Body() dto: AddCartItemDto,
  ): Promise<CartMutationResponse> {
    return this.cartService.addItem(requireIdentity(request), {
      productId: dto.productId,
      variantId: dto.variantId ?? null,
      qty: dto.qty,
    });
  }

  @Patch('items/:id')
  updateItem(
    @Req() request: CartRequest,
    @Param('id', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartMutationResponse> {
    return this.cartService.updateItem(
      requireIdentity(request),
      itemId,
      dto.qty,
    );
  }

  @Delete('items/:id')
  @HttpCode(204)
  async removeItem(
    @Req() request: CartRequest,
    @Param('id', new ParseUUIDPipe()) itemId: string,
  ): Promise<void> {
    await this.cartService.removeItem(requireIdentity(request), itemId);
  }

  @Delete('items')
  @HttpCode(204)
  async removeItems(
    @Req() request: CartRequest,
    @Body() dto: RemoveCartItemsDto,
  ): Promise<void> {
    await this.cartService.removeItems(requireIdentity(request), dto.ids);
  }

  @Delete()
  @HttpCode(204)
  async clearCart(@Req() request: CartRequest): Promise<void> {
    await this.cartService.clearCart(requireIdentity(request));
  }
}

function requireIdentity(request: CartRequest): CartIdentity {
  if (!request.cartIdentity) {
    throw new UnauthorizedException('Cart identity is required');
  }

  return request.cartIdentity;
}
