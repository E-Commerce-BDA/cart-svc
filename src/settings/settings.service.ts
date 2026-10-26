import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SettingsRepository, SettingsRow } from './settings.repository.js';
import {
  getSettingDefinitions,
  isSettingKey,
  pickKnownOverrides,
  resolveSettingValues,
  SETTINGS_REGISTRY,
  SETTINGS_SCOPE,
  SettingDefinitionDto,
  SettingKey,
  SettingValue,
  SettingValues,
  type GuestMergeStrategy,
} from './settings.registry.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface UpdateSettingsInput {
  version: number;
  values?: Record<string, unknown>;
  reset?: string[];
  actorId: string;
  requestId: string | null;
}

export interface SettingsDocument {
  scope: string;
  version: number;
  values: SettingValues;
  overrides: Partial<SettingValues>;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SettingsResponse extends SettingsDocument {
  definitions: SettingDefinitionDto[];
}

@Injectable()
export class SettingsService {
  constructor(private readonly repository: SettingsRepository) {}

  async getSettings(): Promise<SettingsResponse> {
    const row = await this.requireRow();
    return {
      ...this.toDocument(row),
      definitions: getSettingDefinitions(),
    };
  }

  async getGuestMergeStrategy(): Promise<GuestMergeStrategy> {
    const row = await this.requireRow();
    return this.toDocument(row).values.guestMergeStrategy;
  }

  async updateSettings(
    input: UpdateSettingsInput,
  ): Promise<SettingsDocument> {
    this.assertVersion(input.version);

    const values = input.values ?? {};
    const reset = input.reset ?? [];

    if (!isRecord(values)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'values must be an object',
      });
    }

    if (!Array.isArray(reset) || reset.some((key) => typeof key !== 'string')) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'reset must be an array of setting keys',
      });
    }

    if (Object.keys(values).length === 0 && reset.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Provide values or reset',
      });
    }

    const parsedValues = this.validateValues(values);
    const resetKeys = this.validateReset(reset);
    const current = await this.requireRow();
    const nextOverrides = this.copyStoredOverrides(current.setting_values);

    for (const key of resetKeys) {
      delete nextOverrides[key];
    }

    for (const [key, value] of Object.entries(parsedValues)) {
      nextOverrides[key] = value;
    }

    const result = await this.repository.save({
      scope: SETTINGS_SCOPE,
      expectedVersion: input.version,
      values: nextOverrides,
      actorId: input.actorId,
      requestId: input.requestId,
    });

    if (result.kind === 'conflict') {
      throw new ConflictException({
        code: 'SETTINGS_VERSION_CONFLICT',
        message: 'Settings version conflict',
        details: { currentVersion: result.currentVersion },
      });
    }

    if (result.kind === 'missing') {
      throw new InternalServerErrorException('Settings document is missing');
    }

    return this.toDocument(result.row);
  }

  private assertVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'version must be a non-negative integer',
      });
    }
  }

  private validateValues(
    values: Record<string, unknown>,
  ): Record<string, SettingValue> {
    const parsedValues: Record<string, SettingValue> = {};

    for (const [key, value] of Object.entries(values)) {
      this.assertSettingKey(key);
      const parsed = SETTINGS_REGISTRY[key].schema.safeParse(value);

      if (!parsed.success) {
        throw new BadRequestException({
          code: 'INVALID_SETTING_VALUE',
          message: `Invalid value for setting: ${key}`,
          details: { key, issues: parsed.error.issues },
        });
      }

      parsedValues[key] = parsed.data as SettingValue;
    }

    return parsedValues;
  }

  private validateReset(reset: string[]): SettingKey[] {
    const keys: SettingKey[] = [];

    for (const key of reset) {
      this.assertSettingKey(key);
      keys.push(key);
    }

    return keys;
  }

  private assertSettingKey(key: string): asserts key is SettingKey {
    if (FORBIDDEN_KEYS.has(key) || !isSettingKey(key)) {
      throw new BadRequestException({
        code: 'UNKNOWN_SETTING',
        message: `Unknown setting: ${key}`,
        details: { key },
      });
    }
  }

  private copyStoredOverrides(
    stored: Record<string, unknown>,
  ): Record<string, unknown> {
    const overrides: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(stored)) {
      if (!FORBIDDEN_KEYS.has(key)) {
        overrides[key] = value;
      }
    }

    return overrides;
  }

  private async requireRow(): Promise<SettingsRow> {
    const row = await this.repository.find(SETTINGS_SCOPE);

    if (!row) {
      throw new InternalServerErrorException('Settings document is missing');
    }

    return row;
  }

  private toDocument(row: SettingsRow): SettingsDocument {
    return {
      scope: row.scope,
      version: row.version,
      values: resolveSettingValues(row.setting_values),
      overrides: pickKnownOverrides(row.setting_values),
      updatedAt: row.updated_at.toISOString(),
      updatedBy: row.updated_by,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
