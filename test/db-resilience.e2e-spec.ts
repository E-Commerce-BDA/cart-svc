import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';

describe('Database resilience (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('survives a terminated database connection and keeps serving', async () => {
    const { rows } = await getPool().query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const victimPid = rows[0].pid;

    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend($1)', [victimPid]);
    await admin.end();

    // Give the pool a moment to observe the dropped connection.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The process must still be alive and serving
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });
});
