import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CartModule } from '../cart/cart.module.js';
import { InternalCartController } from './internal.controller.js';

@Module({
  imports: [AuthModule, CartModule],
  controllers: [InternalCartController],
})
export class InternalModule {}
