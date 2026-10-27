import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AddWishlistItemDto } from './dto/add-wishlist-item.dto.js';
import { WishlistService } from './wishlist.service.js';
import type {
  WishlistItemResponse,
  WishlistResponse,
} from './wishlist.types.js';

@Controller(['wishlist', 'cart/wishlist'])
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('customer')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  async getWishlist(@Req() req: AuthenticatedRequest): Promise<WishlistResponse> {
    const userId = req.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authentication is required');
    }
    return this.wishlistService.getWishlist(userId);
  }

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  async addWishlistItem(
    @Req() req: AuthenticatedRequest,
    @Body() dto: AddWishlistItemDto,
  ): Promise<WishlistItemResponse> {
    const userId = req.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authentication is required');
    }
    return this.wishlistService.addItem(userId, dto.productId);
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  async removeWishlistItem(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const userId = req.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authentication is required');
    }
    await this.wishlistService.removeItem(userId, id);
  }
}
