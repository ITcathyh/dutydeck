import { independentBotSettingFields, type PublicLarkConfig, type SaveLarkConfigInput, type StoredLarkConfig } from '@dutydeck/shared';

type Key = keyof typeof independentBotSettingFields;
const keys = Object.keys(independentBotSettingFields) as Key[];
type StrictTextKey = { [K in Key]: (typeof independentBotSettingFields)[K] extends { requiresStringInput: true } ? K : never }[Key];
const otherKeys = keys.filter(key => !('requiresStringInput' in independentBotSettingFields[key]));
const directPublicFields = new Set<Key>(['listening', 'groupToolsEnabled', 'preInjectPrompt', 'pushIntervalMs', 'hideTraceOnComplete', 'peerBotsAllowed']);

function readField(key: Key, value: unknown) {
  const field = independentBotSettingFields[key];
  switch (field.kind) {
    case 'boolean':
      if (key === 'structuredAskCards' || key === 'groupCardMention') return value === undefined || value === true;
      return field.default ? value !== false : value === true;
    case 'enum':
      if ('displayDefault' in field && value === field.displayDefault && (key === 'claudeAutoMemory' || key === 'executionMode')) return undefined;
      return (field.values as readonly unknown[]).includes(value) ? value : field.default;
    case 'integer': {
      const n = key === 'idleCompactHours' || key === 'replyPolishTimeoutMs' ? value : Number(value);
      return typeof n === 'number' && Number.isInteger(n) && n >= field.min && (!('max' in field) || n <= field.max) ? n : field.default;
    }
    case 'string':
      if (key === 'preInjectPrompt') return String(value ?? field.default).trim();
      if (key === 'defaultModel' || key === 'defaultReasoningEffort') return value || undefined;
      if (!('requiresStringInput' in field) && typeof value !== 'string') return undefined;
      // Old disk entries with a non-string in an unguarded text field are quarantined by readLarkConfigs.
      return (value as string | undefined)?.trim() || undefined;
  }
}

function publicField(key: Key, value: unknown) {
  const field = independentBotSettingFields[key];
  if (directPublicFields.has(key)) return value;
  switch (field.kind) {
    case 'boolean':
      if (key === 'groupCardMention') return value === true;
      return field.default ? value !== false : value === true;
    case 'enum':
      if (key === 'executionMode' || key === 'claudeAutoMemory') return readField(key, value) ?? independentBotSettingFields[key].displayDefault;
      return field.default === undefined ? value || undefined : readField(key, value);
    case 'integer':
      if (field.default === undefined && !('displayDefault' in field)) return value;
      return value ?? ('displayDefault' in field ? field.displayDefault : field.default);
    case 'string':
      return value || undefined;
  }
}

function mergedField(key: Key, input: SaveLarkConfigInput, current?: StoredLarkConfig) {
  const field = independentBotSettingFields[key];
  const value = input[key];
  if (value === undefined) return current?.[key] ?? field.default;
  if (field.kind === 'string') {
    if (!('requiresStringInput' in field) && typeof value !== 'string') return undefined;
    return (value as string).trim() || field.default;
  }
  if ('clearable' in field && field.clearable === 'null' && value === null) return field.default;
  if (key === 'executionMode' || key === 'claudeAutoMemory') return readField(key, value);
  if (key === 'peerBotsAllowed') return value;
  return value ?? current?.[key] ?? field.default;
}

function projectFields<K extends Key>(selected: readonly K[], select: (key: K) => unknown, publish = false) {
  const result: Partial<Record<Key, unknown>> = {};
  for (const key of selected) {
    const value = select(key);
    // Direct projections of required properties historically include them even on partial input.
    if (value !== undefined || (publish && directPublicFields.has(key))) {
      result[key] = value;
    }
  }
  return result;
}

export const readBotScalarFields = (raw: Partial<StoredLarkConfig>) =>
  projectFields(keys, key => readField(key, raw[key])) as Pick<StoredLarkConfig, Key>;
export const publicBotScalarFields = (config: StoredLarkConfig) =>
  projectFields(keys, key => publicField(key, config[key]), true) as Pick<PublicLarkConfig, Key>;
export const mergeBotScalarFields = (input: SaveLarkConfigInput, current?: StoredLarkConfig) =>
  projectFields(otherKeys, key => mergedField(key, input, current)) as Pick<StoredLarkConfig, Exclude<Key, StrictTextKey>>;

// A malformed patch can fail in several places. Evaluate unchecked text at its original
// validation stage so clients receive the same first error, including the field name.
export function mergeBotTextFields<K extends StrictTextKey>(input: SaveLarkConfigInput, current: StoredLarkConfig | undefined, ...selected: K[]) {
  return projectFields(selected, key => {
    const value = input[key];
    if (value != null && typeof value !== 'string') throw new TypeError(`input.${key}.trim is not a function`);
    return mergedField(key, input, current);
  }) as Pick<StoredLarkConfig, K>;
}
