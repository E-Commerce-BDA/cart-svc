import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, from, mergeMap, of, switchMap } from 'rxjs';
import type { CartRequest } from '../auth/guards/cart-identity.guard.js';
import {
  hashRequestBody,
  IdempotencyScope,
  IdempotencyService,
} from './idempotency.service.js';

const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const IDEMPOTENCY_HEADER = 'x-idempotency-key';
const MAX_KEY_LENGTH = 128;

/**
 * Dedupe cart mutations before the handler runs.
 *
 * Replays bypass the service entirely, so the original commit and its single
 * `cart.updated` event are not repeated. The route's `@HttpCode` supplies the
 * replayed status; the stored record only needs the body.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context.switchToHttp().getRequest<CartRequest>();

    if (!MUTATION_METHODS.has(request.method)) {
      return next.handle();
    }

    const identity = request.cartIdentity;
    if (!identity) {
      throw new UnauthorizedException('Cart identity is required');
    }

    const key = readIdempotencyKey(request);
    const scope: IdempotencyScope =
      identity.type === 'user'
        ? { type: 'user', id: identity.userId }
        : { type: 'session', id: identity.sessionId };
    const redisKey = this.idempotency.buildKey(
      scope,
      request.method,
      request.path,
      key,
    );
    const bodyHash = hashRequestBody(request.body ?? null);

    return from(this.idempotency.begin(redisKey, bodyHash)).pipe(
      switchMap((replay) => {
        if (replay) {
          return of(replay.body);
        }

        return next.handle().pipe(
          mergeMap(async (body) => {
            await this.idempotency.complete(redisKey, bodyHash, body);
            return body;
          }),
        );
      }),
    );
  }
}

function readIdempotencyKey(request: CartRequest): string {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'x-idempotency-key is required for cart mutations',
    });
  }

  const key = value.trim();
  if (key.length > MAX_KEY_LENGTH) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `x-idempotency-key must be at most ${MAX_KEY_LENGTH} characters`,
    });
  }

  return key;
}
