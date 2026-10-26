import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

interface SettingsSnapshot {
  scope: string;
  setting_values: Record<string, unknown>;
  version: number;
  updated_by: string | null;
}

interface AuditRow {
  scope: string;
  version: number;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown>;
  changed_by: string | null;
  request_id: string | null;
}

const ADMIN_ID = '0190a8b0-0000-7000-8000-000000000001';
const CUSTOMER_ID = '0190a8b0-0000-7000-8000-000000000002';
const REQUEST_ID_PREFIX = 'settings-e2e-';

describe('Cart Settings (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let adminToken: string;
  let customerToken: string;
  let originalSettings: SettingsSnapshot | null;
  let version: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', {
      exclude: ['health', 'health/ready'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    await app.init();

    const config = app.get(ConfigService);
    const jwt = new JwtService({
      secret: config.getOrThrow<string>('JWT_SECRET'),
    });

    adminToken = await signToken(jwt, ADMIN_ID, ['admin']);
    customerToken = await signToken(jwt, CUSTOMER_ID, ['customer']);

    pool = getPool();
    const snapshot = await pool.query<SettingsSnapshot>(
      `SELECT scope, setting_values, version, updated_by
         FROM cart.settings
        WHERE scope = 'global'`,
    );
    originalSettings = snapshot.rows[0] ?? null;

    await resetSettings();
    await deleteTestAuditRows();
  });

  afterAll(async () => {
    if (pool) {
      if (originalSettings) {
        await pool.query(
          `UPDATE cart.settings
              SET setting_values = $1::jsonb,
                  version = $2,
                  updated_by = $3
            WHERE scope = $4`,
          [
            JSON.stringify(originalSettings.setting_values),
            originalSettings.version,
            originalSettings.updated_by,
            originalSettings.scope,
          ],
        );
      }

      await deleteTestAuditRows();
    }

    if (app) {
      await app.close();
    }
    await closePool();
  });

  it('rejects an anonymous GET with the shared 401 envelope', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart/settings')
      .expect(401);

    expect(response.body.error).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Missing authorization header',
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it('rejects a customer token with 403', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart/settings')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.message).toBe('Insufficient role');
  });

  it('returns the seeded defaults and admin definitions', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    version = response.body.version;
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.vary).toContain('Authorization');
    expect(response.body).toMatchObject({
      scope: 'global',
      version: 0,
      values: { guestMergeStrategy: 'merge' },
      overrides: {},
      updatedBy: null,
    });
    expect(response.body.definitions).toEqual([
      {
        key: 'guestMergeStrategy',
        group: 'guestCart',
        label: 'Guest-to-account cart behavior',
        type: 'select',
        options: ['merge', 'guest_wins', 'user_wins'],
        defaultValue: 'merge',
        visibility: 'admin',
      },
    ]);
  });

  it('rejects an unknown setting key', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/cart/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-request-id', `${REQUEST_ID_PREFIX}unknown`)
      .send({ version, values: { notASetting: true } })
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: 'UNKNOWN_SETTING',
      message: 'Unknown setting: notASetting',
      details: { key: 'notASetting' },
    });
  });

  it('rejects an invalid setting value', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/cart/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-request-id', `${REQUEST_ID_PREFIX}invalid`)
      .send({
        version,
        values: { guestMergeStrategy: 'ask_customer' },
      })
      .expect(400);

    expect(response.body.error.code).toBe('INVALID_SETTING_VALUE');
    expect(response.body.error.details).toMatchObject({
      key: 'guestMergeStrategy',
    });
  });

  it('rejects a stale version with the current version', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/cart/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-request-id', `${REQUEST_ID_PREFIX}stale`)
      .send({
        version: version + 1,
        values: { guestMergeStrategy: 'guest_wins' },
      })
      .expect(409);

    expect(response.body.error).toMatchObject({
      code: 'SETTINGS_VERSION_CONFLICT',
      message: 'Settings version conflict',
      details: { currentVersion: version },
    });
  });

  it('saves a valid override and returns the new version', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/cart/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-request-id', `${REQUEST_ID_PREFIX}valid`)
      .send({
        version,
        values: { guestMergeStrategy: 'guest_wins' },
      })
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.vary).toContain('Authorization');
    expect(response.body).toMatchObject({
      scope: 'global',
      version: version + 1,
      values: { guestMergeStrategy: 'guest_wins' },
      overrides: { guestMergeStrategy: 'guest_wins' },
      updatedBy: ADMIN_ID,
    });
    expect(response.body).not.toHaveProperty('definitions');
    version = response.body.version;
  });

  it('reads back the saved override', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.version).toBe(version);
    expect(response.body.values).toEqual({
      guestMergeStrategy: 'guest_wins',
    });
    expect(response.body.overrides).toEqual({
      guestMergeStrategy: 'guest_wins',
    });
  });

  it('resets the override and returns to the registry default', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/cart/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-request-id', `${REQUEST_ID_PREFIX}reset`)
      .send({ version, reset: ['guestMergeStrategy'] })
      .expect(200);

    expect(response.body).toMatchObject({
      version: version + 1,
      values: { guestMergeStrategy: 'merge' },
      overrides: {},
      updatedBy: ADMIN_ID,
    });
    version = response.body.version;
  });

  it('writes append-only audit rows for both successful saves', async () => {
    const audit = await pool.query<AuditRow>(
      `SELECT scope, version, old_values, new_values, changed_by, request_id
         FROM cart.settings_audit
        WHERE request_id IN ($1, $2)
        ORDER BY changed_at ASC`,
      [`${REQUEST_ID_PREFIX}valid`, `${REQUEST_ID_PREFIX}reset`],
    );

    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]).toMatchObject({
      scope: 'global',
      version: version - 1,
      changed_by: ADMIN_ID,
      request_id: `${REQUEST_ID_PREFIX}valid`,
    });
    expect(audit.rows[0].old_values).toEqual({});
    expect(audit.rows[0].new_values).toEqual({
      guestMergeStrategy: 'guest_wins',
    });

    expect(audit.rows[1]).toMatchObject({
      scope: 'global',
      version,
      changed_by: ADMIN_ID,
      request_id: `${REQUEST_ID_PREFIX}reset`,
    });
    expect(audit.rows[1].old_values).toEqual({
      guestMergeStrategy: 'guest_wins',
    });
    expect(audit.rows[1].new_values).toEqual({});
  });

  async function resetSettings(): Promise<void> {
    await pool.query(
      `UPDATE cart.settings
          SET setting_values = '{}'::jsonb,
              version = 0,
              updated_by = NULL
        WHERE scope = 'global'`,
    );
  }

  async function deleteTestAuditRows(): Promise<void> {
    await pool.query(
      `DELETE FROM cart.settings_audit WHERE request_id LIKE $1`,
      [`${REQUEST_ID_PREFIX}%`],
    );
  }
});

async function signToken(
  jwt: JwtService,
  sub: string,
  roles: string[],
): Promise<string> {
  return jwt.signAsync(
    {
      sub,
      email: `${roles[0]}@example.com`,
      roles,
    },
    {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: JWT_ALGORITHM,
      expiresIn: '15m',
    },
  );
}
