import { Test, TestingModule } from '@nestjs/testing';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { HealthService } from './health.service.js';
import { getPool } from '../db/pool.js';

vi.mock('../db/pool.js', () => ({
  getPool: vi.fn(),
}));

const mockedGetPool = vi.mocked(getPool);

describe('HealthService', () => {
  let service: HealthService;
  let query: ReturnType<typeof vi.fn>;
  let loggerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [HealthService],
    }).compile();

    service = module.get<HealthService>(HealthService);

    query = vi.fn();
    mockedGetPool.mockReturnValue({ query } as unknown as Pool);

    loggerSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('reports liveness without touching the database', () => {
    expect(service.checkLiveness()).toEqual({ status: 'ok' });
    expect(mockedGetPool).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('reports ready with the database mark when the database answers', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    await expect(service.checkReadiness()).resolves.toEqual({
      status: 'ready',
      checks: { db: 'up' },
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('throws 503 with the not_ready body when the database is unreachable', async () => {
    query.mockRejectedValue(new Error('connection refused'));

    const error = await service
      .checkReadiness()
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'not_ready',
      checks: { db: 'down' },
    });
  });

  it('never leaks the database error to the caller', async () => {
    query.mockRejectedValue(new Error('password authentication failed'));

    const error = await service
      .checkReadiness()
      .then(() => null)
      .catch((caught: unknown) => caught);

    const response = JSON.stringify(
      (error as ServiceUnavailableException).getResponse(),
    );
    expect(response).not.toContain('password');
    expect(response).not.toContain('authentication');
  });

  it('logs the underlying database error for the operator', async () => {
    query.mockRejectedValue(new Error('connection refused'));

    await expect(service.checkReadiness()).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(loggerSpy).toHaveBeenCalledWith(
      'Database connection failed',
      expect.stringContaining('connection refused'),
    );
  });
});
