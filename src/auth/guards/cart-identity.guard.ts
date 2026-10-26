import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { verifyAccessToken } from '../access-token.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';

export type CartIdentity =
  | { type: 'user'; userId: string }
  | { type: 'session'; sessionId: string };

export interface CartRequest extends AuthenticatedRequest {
  cartIdentity?: CartIdentity;
  /** Present when a guest session accompanies a verified user (merge). */
  guestSessionId?: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{8,64}$/;

/**
 * Shopper identity for cart routes.
 *
 * A valid Bearer token wins. Without one, the guest session comes from the
 * `x-session-id` header or cookie. A malformed token never falls back to the
 * session: that would let an expired user silently mutate a guest cart.
 */
@Injectable()
export class CartIdentityGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CartRequest>();
    const authHeader = request.headers.authorization;
    const sessionId = getSessionId(request);

    if (authHeader) {
      const [scheme, token] = authHeader.split(' ');
      if (scheme !== 'Bearer' || !token) {
        throw new UnauthorizedException(
          'Invalid authorization scheme, expected Bearer <token>',
        );
      }

      try {
        const user = await verifyAccessToken(this.jwtService, token);
        if (!user.sub) {
          throw new UnauthorizedException('Invalid access token subject');
        }
        request.user = user;
        request.cartIdentity = { type: 'user', userId: user.sub };
        if (sessionId) {
          request.guestSessionId = sessionId;
        }
        return true;
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          throw error;
        }
        throw new UnauthorizedException('Invalid or expired access token');
      }
    }

    if (!sessionId) {
      throw new UnauthorizedException(
        'Provide a user token or guest session',
      );
    }

    request.cartIdentity = { type: 'session', sessionId };
    request.guestSessionId = sessionId;
    return true;
  }
}

function getSessionId(request: Request): string | null {
  const header = request.headers['x-session-id'];
  const headerValue = Array.isArray(header) ? header[0] : header;

  if (typeof headerValue === 'string' && headerValue.trim()) {
    return normalizeSessionId(headerValue);
  }

  const cookie = request.headers.cookie;
  if (!cookie) {
    return null;
  }

  for (const part of cookie.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name !== 'x-session-id') {
      continue;
    }

    const value = valueParts.join('=');
    try {
      return normalizeSessionId(decodeURIComponent(value));
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeSessionId(value: string): string | null {
  const trimmed = value.trim();
  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : null;
}
