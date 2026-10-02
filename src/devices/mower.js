// -----------------------------------------------------------------------------
// Device type: ROBOT LAWN MOWER (Mammotion Luba / Yuka…)
//
// Gladys has no dedicated "lawn mower" category, so the mower is built from
// standard features every dashboard already knows how to render:
//   - Mowing          switch  (1 = start a job or resume a paused one, 0 = pause)
//   - Return to dock  switch  (1 = go home, 0 = cancel the return)
//   - Refresh         push button (asks the mower for its state now)
//   - Status          text    (Mowing (45 %), Charging, Paused…)
//   - Battery         battery %  + Charging binary
//   - Blade height    mm
//   - Remaining time of the job (min)
//   - Total mowing time (h) and total distance (km)
// Values are refreshed by polling, every `poll_frequency` seconds (Gladys
// calls onPoll every 30 or 60 s, index.js skips the calls that come too early).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  isCharging,
  isDocking,
  isMowing,
  isPaused,
  WORK_MODES,
  workModeLabel,
} from '../mammotion/telemetry.js';
import { devicePollFrequency } from '../config.js';

export const DEVICE_TYPE = 'mower';

const logger = createLogger({ name: DEVICE_TYPE });

// Feature keys, kept in one place so discovery, polling and commands agree.
export const FEATURE = {
  MOWING: 'mowing',
  DOCK: 'dock',
  STATUS: 'status',
  BATTERY: 'battery',
  CHARGING: 'charging',
  BLADE_HEIGHT: 'blade-height',
  REMAINING_TIME: 'remaining-time',
  WORK_TIME: 'work-time',
  DISTANCE: 'distance',
  REFRESH: 'refresh',
};

// Work modes from which a new job can start (Mammotion-HA async_start_mowing).
const STARTABLE_MODES = new Set([WORK_MODES.READY, WORK_MODES.INITIALIZATION]);

// Feature names, in the language chosen in the configuration.
const FEATURE_NAMES = {
  [FEATURE.MOWING]: { en: 'Mowing', fr: 'Tonte' },
  [FEATURE.DOCK]: { en: 'Return to dock', fr: 'Retour à la base' },
  [FEATURE.STATUS]: { en: 'Status', fr: 'État' },
  [FEATURE.BATTERY]: { en: 'Battery', fr: 'Batterie' },
  [FEATURE.CHARGING]: { en: 'Charging', fr: 'En charge' },
  [FEATURE.BLADE_HEIGHT]: { en: 'Blade height', fr: 'Hauteur de coupe' },
  [FEATURE.REMAINING_TIME]: { en: 'Remaining mowing time', fr: 'Temps de tonte restant' },
  [FEATURE.WORK_TIME]: { en: 'Total mowing time', fr: 'Temps de tonte total' },
  [FEATURE.DISTANCE]: { en: 'Total distance', fr: 'Distance totale' },
  [FEATURE.REFRESH]: { en: 'Refresh', fr: 'Rafraîchir' },
};

export function mowerIds(gladys, mower) {
  // The iotId is the unique, stable id the Mammotion cloud gives the mower.
  return gladys.externalIds(DEVICE_TYPE, mower.iotId);
}

/** Discovery payload of one mower. */
export function buildMowerDevice(gladys, mower, config) {
  const ids = mowerIds(gladys, mower);
  const name = (key) => FEATURE_NAMES[key][config.language] ?? FEATURE_NAMES[key].en;
  const sensor = (key, name, category, type, extra = {}) => ({
    name,
    external_id: ids.feature(key),
    category,
    type,
    read_only: true,
    has_feedback: false,
    keep_history: true,
    ...extra,
  });

  return {
    name: mower.name,
    external_id: ids.device,
    // Gladys calls onPoll for this device at this interval. It must be one of
    // the values Gladys accepts, in milliseconds (see devicePollFrequency).
    poll_frequency: devicePollFrequency(config.poll_frequency),
    features: [
      {
        name: name(FEATURE.MOWING),
        external_id: ids.feature(FEATURE.MOWING),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      },
      {
        name: name(FEATURE.DOCK),
        external_id: ids.feature(FEATURE.DOCK),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      },
      sensor(
        FEATURE.STATUS,
        name(FEATURE.STATUS),
        DEVICE_FEATURE_CATEGORIES.TEXT,
        DEVICE_FEATURE_TYPES.TEXT.TEXT,
        // Gladys requires min / max on every feature, even a text one.
        { min: 0, max: 0, keep_history: false },
      ),
      sensor(
        FEATURE.BATTERY,
        name(FEATURE.BATTERY),
        DEVICE_FEATURE_CATEGORIES.BATTERY,
        DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
        { unit: DEVICE_FEATURE_UNITS.PERCENT, min: 0, max: 100 },
      ),
      sensor(
        FEATURE.CHARGING,
        name(FEATURE.CHARGING),
        DEVICE_FEATURE_CATEGORIES.BATTERY,
        DEVICE_FEATURE_TYPES.BATTERY.CHARGING,
        { min: 0, max: 1 },
      ),
      sensor(
        FEATURE.BLADE_HEIGHT,
        name(FEATURE.BLADE_HEIGHT),
        DEVICE_FEATURE_CATEGORIES.DISTANCE_SENSOR,
        DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        { unit: DEVICE_FEATURE_UNITS.MM, min: 0, max: 100 },
      ),
      sensor(
        FEATURE.REMAINING_TIME,
        name(FEATURE.REMAINING_TIME),
        DEVICE_FEATURE_CATEGORIES.DURATION,
        DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        { unit: DEVICE_FEATURE_UNITS.MINUTES, min: 0, max: 1440, keep_history: false },
      ),
      sensor(
        FEATURE.WORK_TIME,
        name(FEATURE.WORK_TIME),
        DEVICE_FEATURE_CATEGORIES.DURATION,
        DEVICE_FEATURE_TYPES.DURATION.DECIMAL,
        { unit: DEVICE_FEATURE_UNITS.HOURS, min: 0, max: 100000 },
      ),
      sensor(
        FEATURE.DISTANCE,
        name(FEATURE.DISTANCE),
        DEVICE_FEATURE_CATEGORIES.DISTANCE_SENSOR,
        DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        { unit: DEVICE_FEATURE_UNITS.KM, min: 0, max: 100000 },
      ),
      {
        // Shown as a "Push" button on the dashboard.
        name: name(FEATURE.REFRESH),
        external_id: ids.feature(FEATURE.REFRESH),
        category: DEVICE_FEATURE_CATEGORIES.BUTTON,
        type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
        min: 0,
        max: 1,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}

/**
 * Turn a telemetry snapshot into Gladys states (unknown values are skipped).
 * A text feature carries its value in `text`, not in `state` (Gladys rejects the whole batch
 * otherwise).
 * @returns {Array<{ device_feature_external_id: string, state?: number, text?: string }>}
 */
export function buildMowerStates(gladys, mower, status, config) {
  const ids = mowerIds(gladys, mower);
  const states = [];
  const push = (key, state) => {
    if (state !== null && state !== undefined) {
      states.push({ device_feature_external_id: ids.feature(key), state });
    }
  };
  const pushText = (key, text) => {
    states.push({ device_feature_external_id: ids.feature(key), text });
  };

  const { workMode, online } = status;
  let label = workModeLabel(workMode, online, config.language);
  if (label && online !== false && isMowing(workMode) && status.progressPercent > 0) {
    label = `${label} (${status.progressPercent} %)`;
  }
  if (label) {
    pushText(FEATURE.STATUS, label);
  }
  if (workMode !== null) {
    push(FEATURE.MOWING, isMowing(workMode) ? 1 : 0);
    push(FEATURE.DOCK, isDocking(workMode) ? 1 : 0);
  }
  // The protobuf reports say it directly (charge_state); else read the mode.
  if (typeof status.charging === 'boolean') {
    push(FEATURE.CHARGING, status.charging ? 1 : 0);
  } else if (workMode !== null) {
    push(FEATURE.CHARGING, isCharging(workMode) ? 1 : 0);
  }
  push(FEATURE.BATTERY, status.battery);
  push(FEATURE.BLADE_HEIGHT, status.bladeHeightMm);
  // The mower keeps the time of its last job: it only means something during a job.
  if (workMode !== null && status.remainingMinutes !== undefined) {
    const inJob = isMowing(workMode) || isPaused(workMode);
    push(FEATURE.REMAINING_TIME, inJob ? status.remainingMinutes : 0);
  }
  push(FEATURE.WORK_TIME, status.totalWorkHours);
  push(FEATURE.DISTANCE, status.totalDistanceKm);
  return states;
}

/**
 * Map a Gladys command on a feature to a mower command.
 *
 * "Mowing" ON resumes a paused job, or starts a new one when the mower is
 * ready ('startJob': a route is planned first, see MammotionClient.startJob).
 * @param {string} featureKey one of FEATURE.MOWING / FEATURE.DOCK / FEATURE.REFRESH
 * @param {number} value 0 or 1
 * @param {number|null} workMode last known work mode
 * @returns {'startJob'|'resume'|'pause'|'dock'|'cancelDock'|'refresh'|null} null: nothing to do
 */
export function commandFor(featureKey, value, workMode) {
  const on = Number(value) === 1;
  if (featureKey === FEATURE.MOWING) {
    if (on) {
      if (isPaused(workMode)) return 'resume';
      if (isMowing(workMode)) return null;
      if (STARTABLE_MODES.has(workMode)) return 'startJob';
      throw new Error(
        workMode === null
          ? 'Mower state unknown yet, try again in a minute'
          : `Cannot start mowing now (${workModeLabel(workMode, null)})`,
      );
    }
    return workMode === null || isMowing(workMode) ? 'pause' : null;
  }
  if (featureKey === FEATURE.DOCK) {
    return on ? 'dock' : 'cancelDock';
  }
  if (featureKey === FEATURE.REFRESH) {
    return 'refresh';
  }
  throw new Error(`Feature "${featureKey}" cannot be controlled`);
}

/** Feature key from its external_id (the part after the device id). */
export function featureKeyOf(gladys, mower, featureExternalId) {
  const prefix = `${mowerIds(gladys, mower).device}:`;
  if (!featureExternalId.startsWith(prefix)) {
    return null;
  }
  return featureExternalId.slice(prefix.length);
}

export { logger as mowerLogger };
