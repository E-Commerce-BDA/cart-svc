import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createOutboxModule } from '@ecom/messaging/nest';
import { AuthModule } from '../auth/auth.module.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { getPool } from '../db/pool.js';
import { RedisModule } from '../redis/redis.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { CartOutbox } from '../outbox/cart-outbox.js';
import { CartMergeService } from './cart-merge.service.js';
import { CartController } from './cart.controller.js';
import { CartRepository } from './cart.repository.js';
import { CartService } from './cart.service.js';
import { CATALOG_CLIENT, FixtureCatalogClient } from './catalog.client.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyService } from './idempotency.service.js';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    SettingsModule,
    // Everything the outbox needs (claim SQL, leases, retries, envelope) lives
    // in the package; cart-svc only names its schema and producer.
    createOutboxModule({
      schema: 'cart',
      producer: 'cart-svc',
      clientId: 'cart-svc',
      pool: getPool,
    }),
  ],
  controllers: [CartController],
  exports: [CartService],
  providers: [
    CartService,
    CartMergeService,
    CartRepository,
    CartOutbox,
    IdempotencyService,
    IdempotencyInterceptor,
    {
      provide: CATALOG_CLIENT,
      useClass: FixtureCatalogClient,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class CartModule {}
