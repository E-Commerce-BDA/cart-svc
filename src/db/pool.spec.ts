import { Logger } from '@nestjs/common';
import { closePool, getPool } from './pool.js';

describe('db pool', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://ecom:secret@localhost:5433/ecom';
  });

  afterEach(async () => {
    await closePool();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;

    expect(() => getPool()).toThrow(
      'DATABASE_URL environment variable is not set',
    );
  });

  it('returns the same pool on every call', () => {
    expect(getPool()).toBe(getPool());
  });

  it('keeps an error listener so a database restart cannot crash the process', () => {
    const pool = getPool();
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });

  it('logs pool errors instead of throwing them', () => {
    const loggerSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const pool = getPool();

    expect(() =>
      pool.emit('error', new Error('connection terminated')),
    ).not.toThrow();
    expect(loggerSpy).toHaveBeenCalledWith(
      'Database pool error',
      expect.stringContaining('connection terminated'),
    );
  });

  it('bounds the wait for a connection so a dead database cannot hang a request', () => {
    const pool = getPool();

    expect(pool.options.connectionTimeoutMillis).toBe(5000);
    expect(pool.options.query_timeout).toBe(10000);
    expect(pool.options.statement_timeout).toBe(10000);
  });
});
