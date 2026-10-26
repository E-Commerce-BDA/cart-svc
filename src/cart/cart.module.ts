import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';
import { SettingsModule } from '../settings/settings.module.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';

@Module({
  imports: [SettingsModule],
  controllers: [CartController],
  providers: [
    CartService,
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class CartModule {}

