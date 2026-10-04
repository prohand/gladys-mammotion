// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Bounds of the refresh interval, kept in sync with the manifest `min` / `max`.
export const POLL_FREQUENCY_MIN = 30;
export const POLL_FREQUENCY_MAX = 3600;

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  email: '', // Mammotion app account
  password: '',
  poll_frequency: 300, // seconds, how often each mower is refreshed
  language: 'fr', // 'fr' | 'en', language of the "Status" text
  // Settings of a new mowing job started from Gladys (the app keeps its own
  // settings on the phone: the mower cannot give them back).
  mowing_zones: '', // zone names, comma separated; empty = every zone of the map
  blade_height: 60, // mm
  mowing_speed: 0.6, // m/s
  line_spacing: 32, // cm between two passes
  angle_mode: 'optimal', // 'optimal' | 'custom' | 'random', how the angle is chosen
  mowing_angle: 111, // degrees, angle of the passes (used with angle_mode 'custom')
  mowing_pattern: 'zigzag', // 'zigzag' | 'chessboard' | 'zigzag_adaptive'
  border_laps: 0, // laps around the perimeter
  obstacle_laps: 0, // laps around the no-go zones
  obstacle_detection: 'off', // 'off' | 'slow' | 'less'
  mowing_order: 'zigzag_first', // 'zigzag_first' | 'border_first'
  start_progress: 0, // %, where the job starts in the zone (0: from the beginning)
};

// Bounds of the mowing settings, kept in sync with the manifest `min` / `max`.
export const MOWING_BOUNDS = {
  blade_height: [15, 100],
  mowing_speed: [0.2, 1.2],
  line_spacing: [15, 40],
  mowing_angle: [0, 180],
  border_laps: [0, 4],
  obstacle_laps: [0, 3],
  start_progress: [0, 99],
};

const MOWING_CHOICES = {
  angle_mode: ['optimal', 'custom', 'random'],
  mowing_pattern: ['zigzag', 'chessboard', 'zigzag_adaptive'],
  obstacle_detection: ['off', 'slow', 'less'],
  mowing_order: ['zigzag_first', 'border_first'],
};

// Gladys only accepts a few fixed device poll intervals, in MILLISECONDS
// (1 s, 2 s, 10 s, 15 s, 30 s, 60 s). Any other value is refused with
// "invalid poll frequency". The device is published with the closest allowed
// value, and onPoll skips the calls that come before `poll_frequency`.
export const GLADYS_POLL_FREQUENCIES_MS = [1000, 2000, 10000, 15000, 30000, 60000];

/** Gladys device poll_frequency (ms) used for a user interval (s). */
export function devicePollFrequency(seconds) {
  return seconds < 60 ? 30_000 : 60_000;
}

function clampPollFrequency(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_CONFIG.poll_frequency;
  }
  return Math.min(POLL_FREQUENCY_MAX, Math.max(POLL_FREQUENCY_MIN, Math.round(seconds)));
}

// Numbers from a form may be strings, with a decimal comma ("0,6").
function clampNumber(key, value, { integer = true } = {}) {
  const number = Number(String(value ?? '').replace(',', '.'));
  if (value === '' || value === null || value === undefined || !Number.isFinite(number)) {
    return DEFAULT_CONFIG[key];
  }
  const [min, max] = MOWING_BOUNDS[key];
  const clamped = Math.min(max, Math.max(min, number));
  return integer ? Math.round(clamped) : Math.round(clamped * 10) / 10;
}

function choice(key, value) {
  return MOWING_CHOICES[key].includes(value) ? value : DEFAULT_CONFIG[key];
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    email: String(raw.email ?? DEFAULT_CONFIG.email).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    // Config may arrive as strings from a form: force a number within bounds.
    poll_frequency: clampPollFrequency(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    language: raw.language === 'en' ? 'en' : DEFAULT_CONFIG.language,
    mowing_zones: String(raw.mowing_zones ?? DEFAULT_CONFIG.mowing_zones).trim(),
    blade_height: clampNumber('blade_height', raw.blade_height),
    mowing_speed: clampNumber('mowing_speed', raw.mowing_speed, { integer: false }),
    line_spacing: clampNumber('line_spacing', raw.line_spacing),
    mowing_angle: clampNumber('mowing_angle', raw.mowing_angle),
    border_laps: clampNumber('border_laps', raw.border_laps),
    obstacle_laps: clampNumber('obstacle_laps', raw.obstacle_laps),
    start_progress: clampNumber('start_progress', raw.start_progress),
    angle_mode: choice('angle_mode', raw.angle_mode),
    mowing_pattern: choice('mowing_pattern', raw.mowing_pattern),
    obstacle_detection: choice('obstacle_detection', raw.obstacle_detection),
    mowing_order: choice('mowing_order', raw.mowing_order),
  };
}

/** True when the user filled in what the cloud login needs. */
export function hasCredentials(config) {
  return Boolean(config.email && config.password);
}

/** Zone names chosen by the user (lower case), or [] for every zone. */
export function mowingZoneNames(config) {
  return String(config.mowing_zones ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Stable key of a zone name: no case, no accent, dashes ("Côté Sud" ->
 * "cote-sud"). Used in the external_id of the zone switches, and to match
 * the zones chosen by the user with the zones of the map. A key of a key is
 * the same key, so a list may mix names and keys.
 */
export function zoneSlug(name) {
  return (
    String(name ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'zone'
  );
}
