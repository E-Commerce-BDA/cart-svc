import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { CartIdentityGuard } from './cart-identity.guard.js';
import type { CartRequest } from './cart-identity.guard.js';

describe('CartIdentityGuard', () => {
  let verifyAsync: ReturnType<typeof vi.fn>;
  let guard: CartIdentityGuard;

  beforeEach(() => {
    verifyAsync = vi.fn();
    guard = new CartIdentityGuard({
      verifyAsync,
    } as unknown as JwtService);
  });

  it('uses the verified JWT subject for a shopper', async () => {
    verifyAsync.mockResolvedValue({
      sub: 'user-1',
      email: 'shopper@example.com',
      roles: ['customer'],
    });
    const request = {
      headers: { authorization: 'Bearer token' },
    } as unknown as CartRequest;

    await expect(guard.canActivate(context(request))).resolves.toBe(true);

    expect(request.cartIdentity).toEqual({ type: 'user', userId: 'user-1' });
    expect(request.user?.sub).toBe('user-1');
  });

  it('uses the x-session-id header for a guest', async () => {
    const request = {
      headers: { 'x-session-id': 'guest-session-1' },
    } as unknown as CartRequest;

    await expect(guard.canActivate(context(request))).resolves.toBe(true);

    expect(request.cartIdentity).toEqual({
      type: 'session',
      sessionId: 'guest-session-1',
    });
  });

  it('reads the guest session from the x-session-id cookie', async () => {
    const request = {
      headers: {
        cookie: 'theme=dark; x-session-id=guest-session-2; other=1',
      },
    } as unknown as CartRequest;

    await expect(guard.canActivate(context(request))).resolves.toBe(true);

    expect(request.cartIdentity).toEqual({
      type: 'session',
      sessionId: 'guest-session-2',
    });
  });

  it('rejects a request with no token or session', async () => {
    const request = { headers: {} } as CartRequest;

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not fall back to a session when the token is invalid', async () => {
    verifyAsync.mockRejectedValue(new Error('bad token'));
    const request = {
      headers: {
        authorization: 'Bearer bad-token',
        'x-session-id': 'guest-session-1',
      },
    } as unknown as CartRequest;

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.cartIdentity).toBeUndefined();
  });

  it('rejects an invalid session id', async () => {
    const request = {
      headers: { 'x-session-id': 'short' },
    } as unknown as CartRequest;

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token without a subject', async () => {
    verifyAsync.mockResolvedValue({
      email: 'shopper@example.com',
      roles: ['customer'],
    });
    const request = {
      headers: { authorization: 'Bearer token' },
    } as unknown as CartRequest;

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

function context(request: CartRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}
