import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SettingsRepository, SettingsRow } from './settings.repository.js';
import { SettingsService } from './settings.service.js';

function row(overrides: Partial<SettingsRow> = {}): SettingsRow {
  return {
    scope: 'global',
    setting_values: {},
    version: 4,
    updated_by: null,
    updated_at: new Date('2026-10-26T10:00:00.000Z'),
    ...overrides,
  };
}

describe('SettingsService', () => {
  let repository: SettingsRepository;
  let find: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;
  let service: SettingsService;

  beforeEach(() => {
    find = vi.fn();
    save = vi.fn();
    repository = { find, save } as unknown as SettingsRepository;
    service = new SettingsService(repository);
  });

  it('returns defaults plus admin definitions', async () => {
    find.mockResolvedValue(row());

    const result = await service.getSettings();

    expect(result.values).toEqual({ guestMergeStrategy: 'merge' });
    expect(result.overrides).toEqual({});
    expect(result.definitions).toHaveLength(1);
    expect(result.updatedAt).toBe('2026-10-26T10:00:00.000Z');
  });

  it('returns a valid stored override', async () => {
    find.mockResolvedValue(
      row({ setting_values: { guestMergeStrategy: 'guest_wins' } }),
    );

    const result = await service.getSettings();

    expect(result.values).toEqual({ guestMergeStrategy: 'guest_wins' });
    expect(result.overrides).toEqual({
      guestMergeStrategy: 'guest_wins',
    });
  });

  it('ignores invalid or unknown stored keys', async () => {
    find.mockResolvedValue(
      row({
        setting_values: {
          guestMergeStrategy: 'not-a-policy',
          futureSetting: true,
        },
      }),
    );

    const result = await service.getSettings();

    expect(result.values).toEqual({ guestMergeStrategy: 'merge' });
    expect(result.overrides).toEqual({});
  });

  it('saves a valid override and returns the new version', async () => {
    find.mockResolvedValue(row());
    save.mockResolvedValue({
      kind: 'saved',
      row: row({
        setting_values: { guestMergeStrategy: 'guest_wins' },
        version: 5,
        updated_by: 'admin-1',
      }),
    });

    const result = await service.updateSettings({
      version: 4,
      values: { guestMergeStrategy: 'guest_wins' },
      actorId: 'admin-1',
      requestId: 'req-1',
    });

    expect(save).toHaveBeenCalledWith({
      scope: 'global',
      expectedVersion: 4,
      values: { guestMergeStrategy: 'guest_wins' },
      actorId: 'admin-1',
      requestId: 'req-1',
    });
    expect(result.version).toBe(5);
    expect(result.values).toEqual({ guestMergeStrategy: 'guest_wins' });
    expect(result.overrides).toEqual({
      guestMergeStrategy: 'guest_wins',
    });
  });

  it('deletes a reset key from the stored overrides', async () => {
    find.mockResolvedValue(
      row({ setting_values: { guestMergeStrategy: 'guest_wins' } }),
    );
    save.mockResolvedValue({
      kind: 'saved',
      row: row({ version: 5 }),
    });

    const result = await service.updateSettings({
      version: 4,
      reset: ['guestMergeStrategy'],
      actorId: 'admin-1',
      requestId: 'req-2',
    });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ values: {} }),
    );
    expect(result.values).toEqual({ guestMergeStrategy: 'merge' });
  });

  it('preserves unknown stored keys for rollback safety', async () => {
    find.mockResolvedValue(
      row({ setting_values: { futureSetting: true } }),
    );
    save.mockResolvedValue({
      kind: 'saved',
      row: row({
        setting_values: {
          futureSetting: true,
          guestMergeStrategy: 'guest_wins',
        },
        version: 5,
      }),
    });

    await service.updateSettings({
      version: 4,
      values: { guestMergeStrategy: 'guest_wins' },
      actorId: 'admin-1',
      requestId: 'req-3',
    });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        values: {
          futureSetting: true,
          guestMergeStrategy: 'guest_wins',
        },
      }),
    );
  });

  it('returns 409 details when the version is stale', async () => {
    find.mockResolvedValue(row());
    save.mockResolvedValue({
      kind: 'conflict',
      currentVersion: 5,
    });

    const error = await service
      .updateSettings({
        version: 4,
        values: { guestMergeStrategy: 'guest_wins' },
        actorId: 'admin-1',
        requestId: null,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'SETTINGS_VERSION_CONFLICT',
      details: { currentVersion: 5 },
    });
  });

  it('rejects unknown setting keys', async () => {
    const error = await service
      .updateSettings({
        version: 4,
        values: { notASetting: true },
        actorId: 'admin-1',
        requestId: null,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'UNKNOWN_SETTING',
      details: { key: 'notASetting' },
    });
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects prototype-pollution keys', async () => {
    const error = await service
      .updateSettings({
        version: 4,
        values: JSON.parse('{"__proto__":{"admin":true}}') as Record<
          string,
          unknown
        >,
        actorId: 'admin-1',
        requestId: null,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'UNKNOWN_SETTING',
      details: { key: '__proto__' },
    });
  });

  it('rejects invalid setting values', async () => {
    const error = await service
      .updateSettings({
        version: 4,
        values: { guestMergeStrategy: 'ask_customer' },
        actorId: 'admin-1',
        requestId: null,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'INVALID_SETTING_VALUE',
      details: { key: 'guestMergeStrategy' },
    });
  });

  it('rejects an empty patch', async () => {
    await expect(
      service.updateSettings({
        version: 4,
        actorId: 'admin-1',
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a negative or fractional version', async () => {
    await expect(
      service.updateSettings({
        version: -1,
        values: { guestMergeStrategy: 'guest_wins' },
        actorId: 'admin-1',
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.updateSettings({
        version: 1.5,
        values: { guestMergeStrategy: 'guest_wins' },
        actorId: 'admin-1',
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when the settings row is missing', async () => {
    find.mockResolvedValue(null);

    await expect(service.getSettings()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
