import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { CartIdentityGuard } from './guards/cart-identity.guard.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { ServiceKeyGuard } from './guards/service-key.guard.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [JwtAuthGuard, RolesGuard, CartIdentityGuard, ServiceKeyGuard],
  exports: [
    JwtModule,
    JwtAuthGuard,
    RolesGuard,
    CartIdentityGuard,
    ServiceKeyGuard,
  ],
})
export class AuthModule {}
