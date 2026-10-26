import { Request } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Echo the gateway request id when present; otherwise create one so direct
 * local calls still produce a traceable error envelope and audit row.
 */
export function getRequestId(request: Request): string {
  const header = request.headers['x-request-id'];

  if (Array.isArray(header)) {
    return header[0]?.trim() || randomUUID();
  }

  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }

  return randomUUID();
}
