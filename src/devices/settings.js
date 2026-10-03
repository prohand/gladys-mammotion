// -----------------------------------------------------------------------------
// Mowing settings shown on the mower device (like the Dreame integration).
//
// Each setting of the "New mowing job" section of the configuration is also a
// `text`/`select` feature of every mower: a drop-down list on the dashboard,
// usable in scenes. A new job started from Gladys uses the settings of ITS
// mower (mowerSettings), not the configuration directly.
//
// Who wins: the last change.
//   - a choice on the device applies to that mower only;
//   - saving a NEW value in the configuration applies it to every mower
//     (applyConfigChanges): the configuration is the "all mowers" setting.
//
// Gladys keeps the selected value (last_value_string of the feature, saved by
// Gladys itself since the features have no feedback). At startup the value is
// read back from the devices Gladys sends (gladys.devices), else taken from the
// configuration.
//
// The option labels and the feature names come from the manifest
// `config_schema`, so they are written in one place only.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { MOWING_BOUNDS, normalizeConfig } from '../config.js';

const manifest = JSON.parse(
  readFileSync(new URL('../../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const FIELDS = new Map(manifest.config_schema.map((field) => [field.key, field]));

// Configuration keys shown on the device, in display order.
export const SETTING_KEYS = [
  'mowing_zones',
  'blade_height',
  'mowing_speed',
  'line_spacing',
  'mowing_angle',
  'mowing_pattern',
  'border_laps',
  'obstacle_detection',
  'obstacle_laps',
  'mowing_order',
];

// Value of the "every zone" choice (a select option cannot be empty).
export const ALL_ZONES = '*';

// Steps of the numeric lists. The current value is added when it falls
// between two steps (a value typed in the configuration), so it shows up.
const NUMBER_STEPS = {
  blade_height: 5,
  mowing_speed: 0.1,
  line_spacing: 1,
  mowing_angle: 15,
  border_laps: 1,
  obstacle_laps: 1,
};

const UNITS = {
  blade_height: 'mm',
  mowing_speed: 'm/s',
  line_spacing: 'cm',
  mowing_angle: '°',
};

const PREFIX = { en: 'Setting', fr: 'Réglage' };
const ALL_ZONES_LABEL = { en: 'Every zone', fr: 'Toutes les zones' };

const localized = (text, language) => text?.[language] ?? text?.en ?? '';

/** Feature key of a setting: `setting-blade-height` for `blade_height`. */
export function settingFeatureKey(key) {
  return `setting-${key.replaceAll('_', '-')}`;
}

/** Configuration key behind a feature key, or null when it is not a setting. */
export function settingKeyOf(featureKey) {
  return SETTING_KEYS.find((key) => settingFeatureKey(key) === featureKey) ?? null;
}

/** Name of the feature: "Réglage – Hauteur de coupe (mm)". */
export function settingName(key, language) {
  return `${PREFIX[language] ?? PREFIX.en} – ${localized(FIELDS.get(key).label, language)}`;
}

/** Value of a setting in the configuration, as a select value (string). */
export function configValue(config, key) {
  if (key === 'mowing_zones') {
    return config.mowing_zones ? config.mowing_zones : ALL_ZONES;
  }
  return String(config[key]);
}

function numberLabel(key, value, language) {
  const text = language === 'fr' ? String(value).replace('.', ',') : String(value);
  return UNITS[key] ? `${text} ${UNITS[key]}` : text;
}

/**
 * Options of the drop-down list of a setting.
 * @param {string} key configuration key
 * @param {{ language: string, current?: string, zones?: string[] }} context
 *   current: selected value (kept in the list), zones: zone names of the map
 * @returns {Array<{ value: string, label: string }>}
 */
export function settingOptions(key, { language, current, zones = [] }) {
  const field = FIELDS.get(key);
  if (key === 'mowing_zones') {
    const values = [ALL_ZONES, ...zones];
    if (current && !values.includes(current)) {
      // Zones typed in the configuration, or zones not read yet.
      values.push(current);
    }
    return [...new Set(values)].map((value) => ({
      value,
      label: value === ALL_ZONES ? localized(ALL_ZONES_LABEL, language) : value,
    }));
  }
  if (key in NUMBER_STEPS) {
    const [min, max] = MOWING_BOUNDS[key];
    const step = NUMBER_STEPS[key];
    const numbers = [];
    // Work in tenths so 0.1 steps stay exact (0.30000000000000004…).
    for (let tenths = min * 10; tenths <= max * 10; tenths += step * 10) {
      numbers.push(Math.round(tenths) / 10);
    }
    const currentNumber = Number(current);
    if (
      current !== undefined &&
      Number.isFinite(currentNumber) &&
      !numbers.includes(currentNumber)
    ) {
      numbers.push(currentNumber);
      numbers.sort((a, b) => a - b);
    }
    return numbers.map((n) => ({ value: String(n), label: numberLabel(key, n, language) }));
  }
  return field.options.map((option) => ({
    value: option.value,
    label: localized(option.label, language),
  }));
}

// --- Selected values ---------------------------------------------------------

// iotId -> Map(configuration key -> select value)
const values = new Map();
// iotId -> zone names of the map, as read on the mower
const zoneNames = new Map();

function mowerValues(mower) {
  if (!values.has(mower.iotId)) {
    values.set(mower.iotId, new Map());
  }
  return values.get(mower.iotId);
}

/**
 * Value of each setting the user chose earlier, read from the device Gladys
 * keeps (last_value_string), for the settings not known yet.
 * @param {{ iotId: string }} mower
 * @param {object} config normalized configuration
 * @param {(key: string) => string | null | undefined} storedValue value Gladys holds for a setting
 */
export function loadMowerSettings(mower, config, storedValue) {
  const known = mowerValues(mower);
  for (const key of SETTING_KEYS) {
    if (known.has(key)) {
      continue;
    }
    const stored = storedValue(key);
    known.set(key, isValidValue(key, stored) ? String(stored) : configValue(config, key));
  }
}

function isValidValue(key, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  if (key === 'mowing_zones') {
    return true;
  }
  if (key in NUMBER_STEPS) {
    const [min, max] = MOWING_BOUNDS[key];
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max;
  }
  return FIELDS.get(key).options.some((option) => option.value === value);
}

/** Selected value of a setting (the configuration when nothing is chosen). */
export function getSetting(mower, key, config) {
  return values.get(mower.iotId)?.get(key) ?? configValue(config, key);
}

/**
 * The user picked a value on the device. Throws on a value outside the list,
 * so Gladys does not save it.
 */
export function setSetting(mower, key, value) {
  const text = String(value ?? '').trim();
  if (!isValidValue(key, text)) {
    throw new Error(`Invalid value "${value}" for ${key}`);
  }
  mowerValues(mower).set(key, text);
}

/**
 * New values saved in the configuration apply to every mower.
 * @returns {string[]} the settings that changed
 */
export function applyConfigChanges(previous, next) {
  const changed = SETTING_KEYS.filter(
    (key) => configValue(previous, key) !== configValue(next, key),
  );
  for (const known of values.values()) {
    for (const key of changed) {
      known.set(key, configValue(next, key));
    }
  }
  return changed;
}

/** Settings of a new job for this mower: the configuration + the device choices. */
export function mowerSettings(mower, config) {
  const overrides = {};
  for (const key of SETTING_KEYS) {
    const value = getSetting(mower, key, config);
    overrides[key] = key === 'mowing_zones' && value === ALL_ZONES ? '' : value;
  }
  return normalizeConfig({ ...config, ...overrides });
}

/**
 * Remember the zone names of a mower map.
 * @returns {boolean} true when the list changed (the drop-down list must be re-published)
 */
export function rememberZones(mower, names) {
  const previous = zoneNames.get(mower.iotId) ?? [];
  zoneNames.set(mower.iotId, [...names]);
  return previous.join('\n') !== names.join('\n');
}

export function knownZones(mower) {
  return zoneNames.get(mower.iotId);
}

/** Forget everything (tests). */
export function resetSettings() {
  values.clear();
  zoneNames.clear();
}
