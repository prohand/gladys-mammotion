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
  };
}

/** True when the user filled in what the cloud login needs. */
export function hasCredentials(config) {
  return Boolean(config.email && config.password);
}
