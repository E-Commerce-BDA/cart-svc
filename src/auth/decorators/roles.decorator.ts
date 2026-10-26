import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/** Require every listed role on the authenticated user. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
