import { z } from 'zod';

export const SETTINGS_SCOPE = 'global';

export const guestMergeStrategySchema = z.enum([
  'merge',
  'guest_wins',
  'user_wins',
]);

export type GuestMergeStrategy = z.infer<typeof guestMergeStrategySchema>;
export type SettingValue = GuestMergeStrategy;
export type SettingVisibility = 'admin' | 'public' | 'secret';
export type SettingControl = 'select' | 'text' | 'number' | 'boolean';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDefinition {
  key: string;
  group: string;
  label: string;
  description: string;
  schema: z.ZodType<unknown>;
  defaultValue: unknown;
  control: SettingControl;
  options?: SettingOption[];
  visibility: SettingVisibility;
  permission: string;
}

export interface SettingDefinitionDto {
  key: string;
  group: string;
  label: string;
  type: SettingControl;
  options?: string[];
  defaultValue: unknown;
  visibility: SettingVisibility;
}

/**
 * The registry is the single source of truth for setting keys, defaults,
 * validation, and admin metadata. The database stores overrides only.
 */
export const SETTINGS_REGISTRY = {
  guestMergeStrategy: {
    key: 'guestMergeStrategy',
    group: 'guestCart',
    label: 'Guest-to-account cart behavior',
    description:
      'What happens when a guest signs in with items in both carts.',
    schema: guestMergeStrategySchema,
    defaultValue: 'merge',
    control: 'select',
    options: [
      { value: 'merge', label: 'Merge carts' },
      { value: 'guest_wins', label: 'Guest cart wins' },
      { value: 'user_wins', label: 'Account cart wins' },
    ],
    visibility: 'admin',
    permission: 'cart.write',
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;

export type SettingValues = {
  guestMergeStrategy: GuestMergeStrategy;
};

export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export const DEFAULT_SETTING_VALUES = Object.fromEntries(
  Object.entries(SETTINGS_REGISTRY).map(([key, definition]) => [
    key,
    definition.defaultValue,
  ]),
) as SettingValues;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS_REGISTRY, key);
}

export function getSettingDefinition(key: SettingKey): SettingDefinition {
  return SETTINGS_REGISTRY[key];
}

export function getSettingDefinitions(): SettingDefinitionDto[] {
  return Object.values(SETTINGS_REGISTRY).map((definition) => ({
    key: definition.key,
    group: definition.group,
    label: definition.label,
    type: definition.control,
    options: definition.options?.map((option) => option.value),
    defaultValue: definition.defaultValue,
    visibility: definition.visibility,
  }));
}

export function resolveSettingValues(
  overrides: Record<string, unknown>,
): SettingValues {
  const values: Record<string, unknown> = { ...DEFAULT_SETTING_VALUES };

  for (const key of SETTING_KEYS) {
    const parsed = SETTINGS_REGISTRY[key].schema.safeParse(overrides[key]);
    if (parsed.success) {
      values[key] = parsed.data;
    }
  }

  return values as SettingValues;
}

export function pickKnownOverrides(
  overrides: Record<string, unknown>,
): Partial<SettingValues> {
  const known: Record<string, SettingValue> = {};

  for (const key of SETTING_KEYS) {
    const parsed = SETTINGS_REGISTRY[key].schema.safeParse(overrides[key]);
    if (parsed.success) {
      known[key] = parsed.data as SettingValue;
    }
  }

  return known;
}
