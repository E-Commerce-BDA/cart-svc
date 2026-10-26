import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getPool } from '../db/pool.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  /**
   * Liveness: is this process able to answer HTTP?
   * Performs no external dependency calls (4.API-Design.md §1.9).
   */
  checkLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: probes PostgreSQL to verify database connectivity.
   */
  async checkReadiness(): Promise<{
    status: 'ready';
    checks: { db: 'up' };
  }> {
    try {
      await getPool().query('SELECT 1');
      return { status: 'ready', checks: { db: 'up' } };
    } catch (error) {
      this.logger.error(
        'Database connection failed',
        error instanceof Error ? error.stack : '',
      );
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: { db: 'down' },
      });
    }
  }
}
