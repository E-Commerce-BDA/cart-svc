import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthService } from './health/health.service.js';
import { HealthController } from './health/health.controller.js';
import Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        PORT: Joi.number().default(4030),
        DATABASE_URL: Joi.string().uri().required(),
        JWT_SECRET: Joi.string().min(32).required(),
      }),
    }),
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
