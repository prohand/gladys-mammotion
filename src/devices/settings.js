// -----------------------------------------------------------------------------
// Mowing settings shown on the mower device (like the Dreame integration).
//
// Each setting of the "New mowing job" section of the configuration is also a
// feature of every mower, usable on the dashboard and in scenes:
//   - the zones: one switch per zone of the map ("Zone to mow – Front"), so
//     several zones can be picked; no switch ON means every zone;
//   - the custom angle (0 to 180°) and the start progress (0 to 99 %): a
//     slider (`switch`/`dimmer`, min / max / step 1). As lists, their 280
//     options made the device too big for Gladys: saving it from the device
//     page failed (the page posts the whole device, options and map image
//     included, and Gladys takes 100 KB at most);
//   - the others: a `text`/`select` drop-down list, whose values follow the
//     range of the mower model (see mammotion/models.js).
// A new job started from Gladys uses the settings of ITS mower
// (mowerSettings), not the configuration directly.
//
// Who wins: the last change.
//   - a choice on the device applies to that mower only;
//   - saving a NEW value in the configuration applies it to every mower
//     (applyConfigChanges): the configuration is the "all mowers" setting.
//
// Gladys keeps the selected value (last_value_string of a list, last_value of
// a zone switch, saved by Gladys itself since the features have no feedback).
// At startup the value is read back from the devices Gladys sends
// (gladys.devices), else taken from the configuration.
//
// The option labels and the feature names come from the manifest
// `config_schema`, so they are written in one place only.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { MOWING_BOUNDS, normalizeConfig, zoneSlug } from '../config.js';
import { clampTo, modelLimits } from '../mammotion/models.js';

const manifest = JSON.parse(
  readFileSync(new URL('../../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const FIELDS = new Map(manifest.config_schema.map((field) => [field.key, field]));

// Settings of a new job kept per mower, zones included.
export const SETTING_KEYS = [
  'mowing_zones',
  'blade_height',
  'mowing_speed',
  'line_spacing',
  'angle_mode',
  'mowing_angle',
  'mowing_pattern',
  'border_laps',
  'obstacle_detection',
  'obstacle_laps',
  'mowing_order',
  'start_progress',
];

// Settings shown as a drop-down list, in display order (the zones are switches).
export const LIST_KEYS = SETTING_KEYS.filter((key) => key !== 'mowing_zones');

// Settings shown as a slider (a number), not as a list: too many values.
export const SLIDER_KEYS = ['mowing_angle', 'start_progress'];

/** True for a setting shown as a slider. */
export function isSlider(key) {
  return SLIDER_KEYS.includes(key);
}

// Value of the "every zone" choice.
export const ALL_ZONES = '*';

// Steps of the numeric lists. The current value is added when it falls
// between two steps (a value typed in the configuration), so it shows up.
const NUMBER_STEPS = {
  blade_height: 5,
  mowing_speed: 0.1,
  line_spacing: 1,
  mowing_angle: 1,
  border_laps: 1,
  obstacle_laps: 1,
  start_progress: 1,
};

const UNITS = {
  blade_height: 'mm',
  mowing_speed: 'm/s',
  line_spacing: 'cm',
  mowing_angle: '°',
  start_progress: '%',
};

const PREFIX = { en: 'Setting', fr: 'Réglage' };
const ZONE_PREFIX = { en: 'Zone to mow', fr: 'Zone à tondre' };
const ZONE_FEATURE_PREFIX = 'zone-';

const localized = (text, language) => text?.[language] ?? text?.en ?? '';

/** Feature key of a setting: `setting-blade-height` for `blade_height`. */
export function settingFeatureKey(key) {
  return `setting-${key.replaceAll('_', '-')}`;
}

/** Configuration key behind a feature key, or null when it is not a list. */
export function settingKeyOf(featureKey) {
  return LIST_KEYS.find((key) => settingFeatureKey(key) === featureKey) ?? null;
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

/**
 * Range of a numeric setting for this mower: the model range for the
 * model-dependent ones, else the configuration bounds. null: not for this model.
 */
export function settingRange(mower, key) {
  const limits = modelLimits(mower);
  return key in limits ? limits[key] : MOWING_BOUNDS[key];
}

/** Settings shown on this mower, lists and sliders (a Yuka has no blade height). */
function settingKeysFor(mower) {
  return LIST_KEYS.filter((key) => !(key in NUMBER_STEPS) || settingRange(mower, key));
}

/** Drop-down list settings shown on this mower. */
export function listKeysFor(mower) {
  return settingKeysFor(mower).filter((key) => !isSlider(key));
}

/** Slider settings shown on this mower. */
export function sliderKeysFor(mower) {
  return settingKeysFor(mower).filter(isSlider);
}

/** Step of a numeric setting. */
export function settingStep(key) {
  return NUMBER_STEPS[key];
}

function numberLabel(key, value, language) {
  const text = language === 'fr' ? String(value).replace('.', ',') : String(value);
  return UNITS[key] ? `${text} ${UNITS[key]}` : text;
}

/**
 * Options of the drop-down list of a setting.
 * @param {string} key configuration key
 * @param {{ language: string, current?: string, mower?: object }} context
 *   current: selected value (kept in the list), mower: for the model range
 * @returns {Array<{ value: string, label: string }>}
 */
export function settingOptions(key, { language, current, mower = {} }) {
  const field = FIELDS.get(key);
  if (key in NUMBER_STEPS) {
    const [min, max] = settingRange(mower, key) ?? MOWING_BOUNDS[key];
    const step = NUMBER_STEPS[key];
    const numbers = [];
    // Work in tenths so 0.1 steps stay exact (0.30000000000000004…).
    for (let tenths = min * 10; tenths <= max * 10 + 1e-9; tenths += step * 10) {
      numbers.push(Math.round(tenths) / 10);
    }
    const currentNumber = Number(current);
    if (
      current !== undefined &&
      Number.isFinite(currentNumber) &&
      currentNumber >= min &&
      currentNumber <= max &&
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

// --- Zones -------------------------------------------------------------------

/** Feature key of the switch of a zone: `zone-cote-sud`. */
export function zoneFeatureKey(name) {
  return `${ZONE_FEATURE_PREFIX}${zoneSlug(name)}`;
}

/** Zone key behind a feature key, or null when it is not a zone switch. */
export function zoneSlugOf(featureKey) {
  return featureKey.startsWith(ZONE_FEATURE_PREFIX)
    ? featureKey.slice(ZONE_FEATURE_PREFIX.length)
    : null;
}

/** Name of a zone switch: "Zone à tondre – Devant". */
export function zoneName(name, language) {
  return `${ZONE_PREFIX[language] ?? ZONE_PREFIX.en} – ${name}`;
}

/** Zones of the map shown as switches: one per key (two zones with one name share it). */
export function zoneSwitches(mower) {
  const seen = new Set();
  return (knownZones(mower) ?? []).filter((name) => {
    const slug = zoneSlug(name);
    if (seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });
}

/** Keys of the zones chosen in a zone setting value (empty: every zone). */
export function selectedZoneSlugs(value) {
  if (!value || value === ALL_ZONES) {
    return new Set();
  }
  return new Set(
    String(value)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map(zoneSlug),
  );
}

/**
 * The user switched a zone ON or OFF: add it to, or remove it from, the zones
 * of the next job of this mower. No zone left means every zone.
 * @returns {string} the new zone setting value
 */
export function setZone(mower, slug, on, config) {
  const slugs = selectedZoneSlugs(getSetting(mower, 'mowing_zones', config));
  if (on) {
    slugs.add(slug);
  } else {
    slugs.delete(slug);
  }
  const value = slugs.size > 0 ? [...slugs].join(',') : ALL_ZONES;
  mowerValues(mower).set('mowing_zones', value);
  return value;
}

/**
 * Zone setting value from the zone switches Gladys keeps, or undefined when
 * the mower has no zone switch yet.
 * @param {Array<{ key: string, value: unknown }>} switches feature key + last_value
 */
export function zonesFromSwitches(switches) {
  const zones = switches.filter((s) => zoneSlugOf(s.key) !== null);
  if (zones.length === 0) {
    return undefined;
  }
  const on = zones.filter((s) => Number(s.value) === 1).map((s) => zoneSlugOf(s.key));
  return on.length > 0 ? on.join(',') : ALL_ZONES;
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
 * keeps, for the settings not known yet.
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
    known.set(key, isValidValue(mower, key, stored) ? String(stored) : configValue(config, key));
  }
}

function isValidValue(mower, key, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  if (key === 'mowing_zones') {
    return true;
  }
  if (key in NUMBER_STEPS) {
    const [min, max] = settingRange(mower, key) ?? MOWING_BOUNDS[key];
    const number = Number(value);
    // A slider moves by whole steps (1° / 1 %).
    if (isSlider(key) && !Number.isInteger(number)) {
      return false;
    }
    return Number.isFinite(number) && number >= min && number <= max;
  }
  return FIELDS.get(key).options.some((option) => option.value === value);
}

/**
 * Selected value of a setting (the configuration when nothing is chosen),
 * brought within the range of the mower model.
 */
export function getSetting(mower, key, config) {
  const value = values.get(mower.iotId)?.get(key) ?? configValue(config, key);
  if (key in NUMBER_STEPS) {
    const range = settingRange(mower, key);
    const number = Number(value);
    if (range && Number.isFinite(number)) {
      return String(clampTo(number, range));
    }
  }
  return value;
}

/**
 * The user picked a value on the device. Throws on a value outside the list,
 * so Gladys does not save it.
 */
export function setSetting(mower, key, value) {
  const text = String(value ?? '').trim();
  if (!isValidValue(mower, key, text)) {
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
 * @returns {boolean} true when the list changed (the zone switches must be re-published)
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
