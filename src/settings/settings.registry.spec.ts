import {
  DEFAULT_SETTING_VALUES,
  getSettingDefinitions,
  guestMergeStrategySchema,
  isSettingKey,
  pickKnownOverrides,
  resolveSettingValues,
  SETTING_KEYS,
} from './settings.registry.js';

describe('settings registry', () => {
  it('defines guestMergeStrategy with the documented default', () => {
    expect(SETTING_KEYS).toEqual(['guestMergeStrategy']);
    expect(DEFAULT_SETTING_VALUES).toEqual({
      guestMergeStrategy: 'merge',
    });
  });

  it('accepts only the documented merge policies', () => {
    expect(guestMergeStrategySchema.safeParse('merge').success).toBe(true);
    expect(guestMergeStrategySchema.safeParse('guest_wins').success).toBe(
      true,
    );
    expect(guestMergeStrategySchema.safeParse('user_wins').success).toBe(true);
    expect(guestMergeStrategySchema.safeParse('ask_customer').success).toBe(
      false,
    );
  });

  it('rejects keys outside the registry, including prototype keys', () => {
    expect(isSettingKey('guestMergeStrategy')).toBe(true);
    expect(isSettingKey('__proto__')).toBe(false);
    expect(isSettingKey('constructor')).toBe(false);
    expect(isSettingKey('prototype')).toBe(false);
  });

  it('resolves defaults and valid overrides', () => {
    expect(resolveSettingValues({})).toEqual({
      guestMergeStrategy: 'merge',
    });
    expect(
      resolveSettingValues({ guestMergeStrategy: 'guest_wins' }),
    ).toEqual({ guestMergeStrategy: 'guest_wins' });
  });

  it('falls back to the default for invalid stored values', () => {
    expect(
      resolveSettingValues({ guestMergeStrategy: 'not-a-policy' }),
    ).toEqual({ guestMergeStrategy: 'merge' });
  });

  it('projects only known valid overrides', () => {
    expect(
      pickKnownOverrides({
        guestMergeStrategy: 'user_wins',
        futureSetting: true,
        brokenSetting: 'nope',
      }),
    ).toEqual({ guestMergeStrategy: 'user_wins' });
  });

  it('projects the admin definition without secrets or permissions', () => {
    const [definition] = getSettingDefinitions();

    expect(definition).toEqual({
      key: 'guestMergeStrategy',
      group: 'guestCart',
      label: 'Guest-to-account cart behavior',
      type: 'select',
      options: ['merge', 'guest_wins', 'user_wins'],
      defaultValue: 'merge',
      visibility: 'admin',
    });
  });
});
