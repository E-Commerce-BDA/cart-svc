import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  DEFAULT_INTERNAL_SERVICE_KEY,
  ServiceKeyGuard,
} from './service-key.guard.js';

function makeContext(headers: Record<string, string | string[]>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('ServiceKeyGuard', () => {
  const guard = new ServiceKeyGuard();
  const originalKey = process.env.INTERNAL_SERVICE_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.INTERNAL_SERVICE_KEY;
    } else {
      process.env.INTERNAL_SERVICE_KEY = originalKey;
    }
  });

  it('allows the configured key', () => {
    process.env.INTERNAL_SERVICE_KEY = 'prod-internal-service-key-1234';

    expect(
      guard.canActivate(
        makeContext({ 'x-service-key': 'prod-internal-service-key-1234' }),
      ),
    ).toBe(true);
  });

  it('falls back to the development key when the env var is absent', () => {
    delete process.env.INTERNAL_SERVICE_KEY;

    expect(
      guard.canActivate(
        makeContext({ 'x-service-key': DEFAULT_INTERNAL_SERVICE_KEY }),
      ),
    ).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(() => guard.canActivate(makeContext({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong key with SERVICE_KEY_INVALID', () => {
    process.env.INTERNAL_SERVICE_KEY = 'prod-internal-service-key-1234';

    try {
      guard.canActivate(makeContext({ 'x-service-key': 'guess' }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        code: 'SERVICE_KEY_INVALID',
      });
    }
  });

  it('rejects a repeated header instead of comparing the first value', () => {
    process.env.INTERNAL_SERVICE_KEY = 'prod-internal-service-key-1234';

    expect(() =>
      guard.canActivate(
        makeContext({
          'x-service-key': [
            'prod-internal-service-key-1234',
            'prod-internal-service-key-1234',
          ],
        }),
      ),
    ).toThrow(UnauthorizedException);
  });
});
