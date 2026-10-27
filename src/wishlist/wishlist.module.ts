import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { WishlistController } from './wishlist.controller.js';
import { WishlistRepository } from './wishlist.repository.js';
import { WishlistService } from './wishlist.service.js';

@Module({
  imports: [AuthModule],
  controllers: [WishlistController],
  providers: [WishlistService, WishlistRepository],
  exports: [WishlistService],
})
export class WishlistModule {}
