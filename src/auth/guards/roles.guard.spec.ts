import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';

function makeContext(user?: { roles?: string[] }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => () => undefined,
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let getAllAndOverride: ReturnType<typeof vi.fn>;
  let guard: RolesGuard;

  beforeEach(() => {
    getAllAndOverride = vi.fn();
    guard = new RolesGuard({
      getAllAndOverride,
    } as unknown as Reflector);
  });

  it('allows routes without role metadata', () => {
    getAllAndOverride.mockReturnValue(undefined);

    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('allows an authenticated admin', () => {
    getAllAndOverride.mockReturnValue(['admin']);

    expect(guard.canActivate(makeContext({ roles: ['admin'] }))).toBe(true);
  });

  it('rejects an authenticated non-admin', () => {
    getAllAndOverride.mockReturnValue(['admin']);

    expect(() => guard.canActivate(makeContext({ roles: ['customer'] }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a request without an authenticated user', () => {
    getAllAndOverride.mockReturnValue(['admin']);

    expect(() => guard.canActivate(makeContext())).toThrow(
      UnauthorizedException,
    );
  });
});
