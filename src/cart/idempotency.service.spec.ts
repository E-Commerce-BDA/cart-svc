import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { RedisService } from '../redis/redis.service.js';
import {
  hashRequestBody,
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyService,
} from './idempotency.service.js';

describe('IdempotencyService', () => {
  let get: ReturnType<typeof vi.fn>;
  let set: ReturnType<typeof vi.fn>;
  let service: IdempotencyService;

  beforeEach(() => {
    get = vi.fn();
    set = vi.fn();
    service = new IdempotencyService({
      get,
      set,
    } as unknown as RedisService);
  });

  it('scopes keys by identity, method, path, and client key', () => {
    expect(
      service.buildKey(
        { type: 'session', id: 'guest-session' },
        'POST',
        '/api/v1/cart/items',
        'key-1',
      ),
    ).toBe('idem:session:guest-session:POST:/api/v1/cart/items:key-1');
  });

  it('returns null when the key has not been seen', async () => {
    get.mockResolvedValue(null);

    await expect(service.begin('idem:key', 'hash')).resolves.toBeNull();
  });

  it('replays a matching body', async () => {
    get.mockResolvedValue(
      JSON.stringify({ bodyHash: 'hash', body: { item: { qty: 2 } } }),
    );

    await expect(service.begin('idem:key', 'hash')).resolves.toEqual({
      body: { item: { qty: 2 } },
    });
  });

  it('rejects a reused key with a different body', async () => {
    get.mockResolvedValue(
      JSON.stringify({ bodyHash: 'first-hash', body: { qty: 2 } }),
    );

    await expect(service.begin('idem:key', 'second-hash')).rejects.toMatchObject(
      {
        response: {
          code: 'IDEMPOTENCY_CONFLICT',
          message:
            'Idempotency key was reused with a different request body',
        },
      },
    );
  });

  it('fails closed when Redis cannot be read', async () => {
    get.mockRejectedValue(new Error('redis down'));

    await expect(service.begin('idem:key', 'hash')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('fails closed when a stored record is corrupt', async () => {
    get.mockResolvedValue('not-json');

    await expect(service.begin('idem:key', 'hash')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('stores the response with a 24h TTL', async () => {
    set.mockResolvedValue(undefined);

    await service.complete('idem:key', 'hash', { ok: true });

    expect(set).toHaveBeenCalledWith(
      'idem:key',
      JSON.stringify({ bodyHash: 'hash', body: { ok: true } }),
      IDEMPOTENCY_TTL_SECONDS,
    );
  });

  it('does not throw when the post-commit write fails', async () => {
    set.mockRejectedValue(new Error('redis down'));

    await expect(
      service.complete('idem:key', 'hash', { ok: true }),
    ).resolves.toBeUndefined();
  });

  it('hashes object bodies independent of property order', () => {
    expect(hashRequestBody({ qty: 2, productId: 'p' })).toBe(
      hashRequestBody({ productId: 'p', qty: 2 }),
    );
    expect(hashRequestBody({ qty: 2 })).not.toBe(
      hashRequestBody({ qty: 3 }),
    );
  });

  it('turns a conflicting replay into a ConflictException', async () => {
    get.mockResolvedValue(JSON.stringify({ bodyHash: 'other', body: null }));

    await expect(service.begin('idem:key', 'hash')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
