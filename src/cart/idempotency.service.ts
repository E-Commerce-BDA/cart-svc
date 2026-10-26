import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisService } from '../redis/redis.service.js';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface IdempotencyScope {
  type: 'user' | 'session';
  id: string;
}

interface IdempotencyRecord {
  bodyHash: string;
  body: unknown;
}

export interface IdempotencyReplay {
  body: unknown;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly redis: RedisService) {}

  buildKey(
    scope: IdempotencyScope,
    method: string,
    path: string,
    key: string,
  ): string {
    return `idem:${scope.type}:${scope.id}:${method}:${path}:${key}`;
  }

  /**
   * Fail closed: any Redis read failure becomes 503 before the mutation runs.
   */
  async begin(
    key: string,
    bodyHash: string,
  ): Promise<IdempotencyReplay | null> {
    let raw: string | null;

    try {
      raw = await this.redis.get(key);
    } catch {
      throw this.unavailable();
    }

    if (raw === null) {
      return null;
    }

    let record: IdempotencyRecord;
    try {
      record = JSON.parse(raw) as IdempotencyRecord;
    } catch {
      this.logger.error(`Corrupt idempotency record at ${key}`);
      throw this.unavailable();
    }

    if (record.bodyHash !== bodyHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key was reused with a different request body',
      });
    }

    return { body: record.body };
  }

  /**
   * The mutation has committed by this point. A Redis write failure is logged
   * but does not turn a successful commit into an error response.
   */
  async complete(
    key: string,
    bodyHash: string,
    body: unknown,
  ): Promise<void> {
    const record: IdempotencyRecord = {
      bodyHash,
      body: body ?? null,
    };

    try {
      await this.redis.set(
        key,
        JSON.stringify(record),
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not store idempotency result at ${key}: ${detail}`);
    }
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Idempotency service unavailable',
    });
  }
}

export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`,
    );

  return `{${entries.join(',')}}`;
}
