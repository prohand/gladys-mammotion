// -----------------------------------------------------------------------------
// Device type: ROBOT LAWN MOWER (Mammotion Luba / Yuka…)
//
// Gladys has no dedicated "lawn mower" category, so the mower is built from
// standard features every dashboard already knows how to render:
//   - Mowing          switch  (1 = start a job or resume a paused one, 0 = pause)
//   - Return to dock  switch  (1 = go home, ending a paused job; 0 = cancel the return)
//   - Refresh         push button (asks the mower for its state now)
//   - Status          text    (Mowing (45 %), Charging, Paused…)
//   - Battery         battery %  + Charging binary (see below)
//   - Blade height    mm
//   - Progress (%), elapsed and remaining time (min) and area (m²) of the job
//   - Total mowing time (h) and total distance (km)
//   - Settings of a new job: one switch per zone, sliders for the angle and
//     the start progress, drop-down lists (`text`/`select`) for the others
//     (height, speed…), see settings.js
// The map (camera image: zones, no-go zones and mower) is a second device,
// see buildMapDevice.
// Values are refreshed by polling, every `poll_frequency` seconds (Gladys
// calls onPoll every 30 or 60 s, index.js skips the calls that come too early).
//
// The Charging feature is deliberately NOT in the `battery` CATEGORY, even
// though Gladys has a `battery`/`charging` pair for exactly this. The core
// warns "battery level under X%" for every feature of the `battery` category
// whose last value is below the threshold, whatever its TYPE (it never reads
// the type: see device.checkBatteries). A charging sensor holds 0 or 1, so it
// was read as "0%" and sent a false low-battery alert every Saturday while the
// mower was off its dock, whatever the real battery level.
//
// It is therefore published as `input`/`binary`, the generic read-only binary
// sensor of Gladys: same 0/1 value, same use in a scene, but outside the
// category the battery check scans. Its external_id changed with it
// (`charging-state`, not `charging`), so the old battery-category feature of
// mowers created before 1.0.10 is never fed again: clicking Update on the
// Discovery screen deletes it for good.
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
import {
  getSetting,
  listKeysFor,
  selectedZoneSlugs,
  settingFeatureKey,
  settingName,
  settingOptions,
  settingRange,
  settingStep,
  sliderKeysFor,
  zoneFeatureKey,
  zoneName,
  zoneSwitches,
} from './settings.js';
import { zoneSlug } from '../config.js';

export const DEVICE_TYPE = 'mower';

const logger = createLogger({ name: DEVICE_TYPE });

// Feature keys, kept in one place so discovery, polling and commands agree.
export const FEATURE = {
  MOWING: 'mowing',
  DOCK: 'dock',
  STATUS: 'status',
  BATTERY: 'battery',
  // Not `charging`: that external_id belongs to the battery-category feature of
  // the versions before 1.0.10, the one that fired the false alert. See above.
  CHARGING: 'charging-state',
  BLADE_HEIGHT: 'blade-height',
  REMAINING_TIME: 'remaining-time',
  PROGRESS: 'progress',
  ELAPSED_TIME: 'elapsed-time',
  JOB_AREA: 'job-area',
  MAP: 'map',
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
  [FEATURE.PROGRESS]: { en: 'Mowing progress', fr: 'Avancement de la tonte' },
  [FEATURE.ELAPSED_TIME]: { en: 'Elapsed mowing time', fr: 'Temps de tonte écoulé' },
  [FEATURE.JOB_AREA]: { en: 'Area to mow', fr: 'Surface à tondre' },
  [FEATURE.MAP]: { en: 'Map', fr: 'Carte' },
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
        // `input`/`binary`, NOT `battery`/`charging`: see the header of this file.
        DEVICE_FEATURE_CATEGORIES.INPUT,
        DEVICE_FEATURE_TYPES.INPUT.BINARY,
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
        FEATURE.PROGRESS,
        name(FEATURE.PROGRESS),
        // Gladys has no "progress" category: a generic sensor in %.
        DEVICE_FEATURE_CATEGORIES.UNKNOWN,
        DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
        { unit: DEVICE_FEATURE_UNITS.PERCENT, min: 0, max: 100, keep_history: false },
      ),
      sensor(
        FEATURE.ELAPSED_TIME,
        name(FEATURE.ELAPSED_TIME),
        DEVICE_FEATURE_CATEGORIES.DURATION,
        DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        { unit: DEVICE_FEATURE_UNITS.MINUTES, min: 0, max: 1440, keep_history: false },
      ),
      sensor(
        FEATURE.JOB_AREA,
        name(FEATURE.JOB_AREA),
        DEVICE_FEATURE_CATEGORIES.SURFACE,
        DEVICE_FEATURE_TYPES.SURFACE.DECIMAL,
        { unit: DEVICE_FEATURE_UNITS.SQUARE_METER, min: 0, max: 100000, keep_history: false },
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
      ...zoneSwitches(mower).map((zone) => ({
        name: zoneName(zone, config.language),
        external_id: ids.feature(zoneFeatureKey(zone)),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: false,
        // Gladys saves the switch position itself (last_value).
        has_feedback: false,
        keep_history: false,
      })),
      ...listKeysFor(mower).map((key) => ({
        name: settingName(key, config.language),
        external_id: ids.feature(settingFeatureKey(key)),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: false,
        // Gladys saves the chosen value itself (last_value_string).
        has_feedback: false,
        keep_history: false,
        supported_options: settingOptions(key, {
          language: config.language,
          current: getSetting(mower, key, config),
          mower,
        }),
      })),
      ...sliderKeysFor(mower).map((key) => {
        const [min, max] = settingRange(mower, key);
        return {
          name: settingName(key, config.language),
          external_id: ids.feature(settingFeatureKey(key)),
          category: DEVICE_FEATURE_CATEGORIES.SWITCH,
          type: DEVICE_FEATURE_TYPES.SWITCH.DIMMER,
          min,
          max,
          step: settingStep(key),
          read_only: false,
          // Gladys saves the chosen value itself (last_value).
          has_feedback: false,
          keep_history: false,
          // These were lists before 1.1.1: an empty list removes their old options.
          supported_options: [],
        };
      }),
    ],
  };
}

// The map is a device of its own ("Luba-… – Map"), with the camera image as
// its only feature. On the mower device (1.1.0 and 1.1.1) the Camera widget
// took every new value of the mower (battery, status…) for the image: the
// map vanished at each one, until the next image.
export const MAP_DEVICE_TYPE = 'mower-map';

export function mapIds(gladys, mower) {
  return gladys.externalIds(MAP_DEVICE_TYPE, mower.iotId);
}

/** Discovery payload of the map of one mower (camera image: see map/render.js). */
export function buildMapDevice(gladys, mower, config) {
  const ids = mapIds(gladys, mower);
  const name = FEATURE_NAMES[FEATURE.MAP][config.language] ?? FEATURE_NAMES[FEATURE.MAP].en;
  return {
    name: `${mower.name} – ${name}`,
    external_id: ids.device,
    features: [
      {
        // Camera image drawn from the map (publishCameraImage / onGetImage).
        name,
        external_id: ids.feature(FEATURE.MAP),
        category: DEVICE_FEATURE_CATEGORIES.CAMERA,
        type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}

/** States of the setting lists and zone switches: the values selected for this mower. */
export function buildSettingStates(gladys, mower, config) {
  const ids = mowerIds(gladys, mower);
  const zones = selectedZoneSlugs(getSetting(mower, 'mowing_zones', config));
  return [
    ...zoneSwitches(mower).map((zone) => ({
      device_feature_external_id: ids.feature(zoneFeatureKey(zone)),
      state: zones.has(zoneSlug(zone)) ? 1 : 0,
    })),
    ...listKeysFor(mower).map((key) => ({
      device_feature_external_id: ids.feature(settingFeatureKey(key)),
      text: getSetting(mower, key, config),
    })),
    ...sliderKeysFor(mower).map((key) => ({
      device_feature_external_id: ids.feature(settingFeatureKey(key)),
      state: Number(getSetting(mower, key, config)),
    })),
  ];
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
  const inJob = workMode !== null && (isMowing(workMode) || isPaused(workMode));
  if (workMode !== null && status.remainingMinutes !== undefined) {
    push(FEATURE.REMAINING_TIME, inJob ? status.remainingMinutes : 0);
  }
  if (workMode !== null && status.progressPercent !== undefined) {
    push(FEATURE.PROGRESS, inJob ? status.progressPercent : 0);
  }
  if (workMode !== null && status.totalMinutes !== undefined) {
    const elapsed = Math.max(0, status.totalMinutes - (status.remainingMinutes ?? 0));
    push(FEATURE.ELAPSED_TIME, inJob ? elapsed : 0);
  }
  // The area of the last job stays meaningful after it.
  if (status.jobAreaM2 > 0) {
    push(FEATURE.JOB_AREA, status.jobAreaM2);
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
 * @returns {'startJob'|'resume'|'pause'|'dock'|'stop'|'stopAndDock'|'cancelDock'|'refresh'|null} null: nothing to do
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
    if (!on) return 'cancelDock';
    // A bare "dock" on a paused job brings the mower home but leaves the job
    // paused, in Gladys and in the app ("Stop" had to be pressed in the app):
    // the job is ended first, as the app does. Already home with the job
    // paused: only the job is ended.
    if (workMode === WORK_MODES.CHARGING_PAUSE) return 'stop';
    return workMode === WORK_MODES.PAUSE ? 'stopAndDock' : 'dock';
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
