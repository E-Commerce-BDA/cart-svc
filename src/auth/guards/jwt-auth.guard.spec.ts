import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_CLOCK_TOLERANCE_SECONDS,
  JWT_ISSUER,
} from '../auth.constants.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const TEST_SECRET = 'unit-test-jwt-secret-at-least-32-characters';

function makeContext(authorization?: string): {
  context: ExecutionContext;
  request: { headers: Record<string, string>; user?: unknown };
} {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('JwtAuthGuard', () => {
  const jwt = new JwtService({ secret: TEST_SECRET });
  const guard = new JwtAuthGuard(jwt);
  const claims = {
    sub: '0190a8b0-0000-7000-8000-000000000001',
    email: 'admin@example.com',
    roles: ['admin'],
  };

  async function sign(
    options: Parameters<JwtService['signAsync']>[1] = {},
  ): Promise<string> {
    return jwt.signAsync(claims, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: JWT_ALGORITHM,
      expiresIn: '15m',
      ...options,
    });
  }

  it('accepts a token with the expected issuer and audience', async () => {
    const token = await sign();
    const { context, request } = makeContext(`Bearer ${token}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toMatchObject(claims);
  });

  it('rejects a missing authorization header', async () => {
    const { context } = makeContext();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a non-Bearer authorization scheme', async () => {
    const { context } = makeContext('Basic abc');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token from another issuer', async () => {
    const token = await sign({ issuer: 'not-ecom-auth' });
    const { context } = makeContext(`Bearer ${token}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token for another audience', async () => {
    const token = await sign({ audience: 'not-ecom-api' });
    const { context } = makeContext(`Bearer ${token}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token without issuer or audience claims', async () => {
    const token = await jwt.signAsync(claims, {
      algorithm: JWT_ALGORITHM,
      expiresIn: '15m',
    });
    const { context } = makeContext(`Bearer ${token}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('keeps the documented clock tolerance configured', () => {
    expect(JWT_CLOCK_TOLERANCE_SECONDS).toBe(30);
  });
});
