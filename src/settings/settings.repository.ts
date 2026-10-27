import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool.js';

export interface SettingsRow {
  scope: string;
  setting_values: Record<string, unknown>;
  version: number;
  updated_by: string | null;
  updated_at: Date;
}

export interface SettingsAuditRow {
  id: string;
  scope: string;
  version: number;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown>;
  changed_by: string | null;
  request_id: string | null;
  changed_at: Date;
}

export interface SettingsAuditEntry {
  id: string;
  scope: string;
  version: number;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown>;
  changedBy: string | null;
  requestId: string | null;
  changedAt: string;
}

export interface SaveSettingsInput {
  scope: string;
  expectedVersion: number;
  values: Record<string, unknown>;
  actorId: string;
  requestId: string | null;
}

export type SaveSettingsResult =
  | { kind: 'saved'; row: SettingsRow }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'missing' };

@Injectable()
export class SettingsRepository {
  async find(scope: string): Promise<SettingsRow | null> {
    const { rows } = await getPool().query<SettingsRow>(
      `SELECT scope, setting_values, version, updated_by, updated_at
         FROM cart.settings
        WHERE scope = $1`,
      [scope],
    );

    return rows[0] ?? null;
  }

  async findAuditEntries(
    scope?: string,
    limit: number = 50,
  ): Promise<SettingsAuditEntry[]> {
    const query = scope
      ? `SELECT id, scope, version, old_values, new_values, changed_by, request_id, changed_at
           FROM cart.settings_audit
          WHERE scope = $1
          ORDER BY version DESC, changed_at DESC
          LIMIT $2`
      : `SELECT id, scope, version, old_values, new_values, changed_by, request_id, changed_at
           FROM cart.settings_audit
          ORDER BY version DESC, changed_at DESC
          LIMIT $1`;
    const params = scope ? [scope, limit] : [limit];

    const { rows } = await getPool().query<SettingsAuditRow>(query, params);

    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      version: r.version,
      oldValues: r.old_values,
      newValues: r.new_values,
      changedBy: r.changed_by,
      requestId: r.request_id,
      changedAt:
        r.changed_at instanceof Date
          ? r.changed_at.toISOString()
          : new Date(r.changed_at).toISOString(),
    }));
  }

  async save(input: SaveSettingsInput): Promise<SaveSettingsResult> {
    const client = await getPool().connect();

    try {
      await client.query('BEGIN');

      const currentResult = await client.query<SettingsRow>(
        `SELECT scope, setting_values, version, updated_by, updated_at
           FROM cart.settings
          WHERE scope = $1
          FOR UPDATE`,
        [input.scope],
      );
      const current = currentResult.rows[0];

      if (!current) {
        await client.query('ROLLBACK');
        return { kind: 'missing' };
      }

      if (current.version !== input.expectedVersion) {
        await client.query('ROLLBACK');
        return { kind: 'conflict', currentVersion: current.version };
      }

      const newVersion = current.version + 1;
      const updateResult = await client.query<SettingsRow>(
        `UPDATE cart.settings
            SET setting_values = $1::jsonb,
                version = $2,
                updated_by = $3
          WHERE scope = $4
            AND version = $5
          RETURNING scope, setting_values, version, updated_by, updated_at`,
        [
          JSON.stringify(input.values),
          newVersion,
          input.actorId,
          input.scope,
          input.expectedVersion,
        ],
      );

      if (updateResult.rowCount !== 1) {
        await client.query('ROLLBACK');
        const latest = await this.find(input.scope);
        return latest
          ? { kind: 'conflict', currentVersion: latest.version }
          : { kind: 'missing' };
      }

      await client.query(
        `INSERT INTO cart.settings_audit
           (scope, version, old_values, new_values, changed_by, request_id)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
        [
          input.scope,
          newVersion,
          JSON.stringify(current.setting_values),
          JSON.stringify(input.values),
          input.actorId,
          input.requestId,
        ],
      );

      await client.query('COMMIT');
      return { kind: 'saved', row: updateResult.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
