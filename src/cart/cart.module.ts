import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { EVENT_BUS, NoopEventBus } from '../events/event-bus.js';
import { RedisModule } from '../redis/redis.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { CartController } from './cart.controller.js';
import { CartRepository } from './cart.repository.js';
import { CartService } from './cart.service.js';
import { CATALOG_CLIENT, FixtureCatalogClient } from './catalog.client.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyService } from './idempotency.service.js';

@Module({
  imports: [AuthModule, RedisModule, SettingsModule],
  controllers: [CartController],
  providers: [
    CartService,
    CartRepository,
    IdempotencyService,
    IdempotencyInterceptor,
    {
      provide: CATALOG_CLIENT,
      useClass: FixtureCatalogClient,
    },
    {
      provide: EVENT_BUS,
      useClass: NoopEventBus,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class CartModule {}
