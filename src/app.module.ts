import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthService } from './health/health.service.js';
import { HealthController } from './health/health.controller.js';
import { InternalModule } from './internal/internal.module.js';
import { CartModule } from './cart/cart.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { WishlistModule } from './wishlist/wishlist.module.js';
import Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),
        PORT: Joi.number().default(4030),
        DATABASE_URL: Joi.string().uri().required(),
        JWT_SECRET: Joi.string().min(32).required(),
        KAFKA_BROKERS: Joi.string().default('localhost:9092'),
        DISABLE_OUTBOX_RELAY: Joi.boolean().default(false),
        // The guard's development fallback must be impossible in production.
        INTERNAL_SERVICE_KEY: Joi.string()
          .min(16)
          .when('NODE_ENV', {
            is: 'production',
            // oxlint-disable-next-line unicorn/no-thenable -- Joi's `then` branch.
            then: Joi.required(),
            otherwise: Joi.optional().default(
              'dev-internal-service-key-change-in-prod',
            ),
          }),
      }),
    }),
    CartModule,
    SettingsModule,
    WishlistModule,
    InternalModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
