// -----------------------------------------------------------------------------
// Mower telemetry: turn the raw Aliyun "thing properties" snapshot into a flat,
// typed object the Gladys devices can publish.
//
// A property can arrive as `items.x.value`, `items.x`, `x.value` or `x`, and
// some of them (networkInfo, deviceOtherInfo) are JSON strings: this module
// hides those variations.
// -----------------------------------------------------------------------------

// `deviceState` values reported by the mower (Mammotion "work mode").
export const WORK_MODES = {
  NOT_ACTIVE: 0,
  ONLINE: 1,
  OFFLINE: 2,
  DISABLE: 8,
  INITIALIZATION: 10,
  READY: 11,
  UNCONNECTED: 12,
  WORKING: 13,
  RETURNING: 14,
  CHARGING: 15,
  UPDATING: 16,
  LOCK: 17,
  PAUSE: 19,
  MANUAL_MOWING: 20,
  UPDATE_SUCCESS: 22,
  OTA_UPGRADE_FAIL: 23,
  JOB_DRAW: 31,
  OBSTACLE_DRAW: 32,
  CHANNEL_DRAW: 34,
  ERASER_DRAW: 35,
  EDIT_BOUNDARY: 36,
  LOCATION_ERROR: 37,
  BOUNDARY_JUMP: 38,
  CHARGING_PAUSE: 39,
};

// Human readable label of each work mode, shown in the "Status" feature.
const WORK_MODE_LABELS = {
  [WORK_MODES.NOT_ACTIVE]: { en: 'Not activated', fr: 'Non activée' },
  [WORK_MODES.ONLINE]: { en: 'Online', fr: 'En ligne' },
  [WORK_MODES.OFFLINE]: { en: 'Offline', fr: 'Hors ligne' },
  [WORK_MODES.DISABLE]: { en: 'Disabled', fr: 'Désactivée' },
  [WORK_MODES.INITIALIZATION]: { en: 'Starting', fr: 'Démarrage' },
  [WORK_MODES.READY]: { en: 'Ready', fr: 'Prête' },
  [WORK_MODES.UNCONNECTED]: { en: 'Not connected', fr: 'Non connectée' },
  [WORK_MODES.WORKING]: { en: 'Mowing', fr: 'En tonte' },
  [WORK_MODES.RETURNING]: { en: 'Returning to dock', fr: 'Retour à la base' },
  [WORK_MODES.CHARGING]: { en: 'Charging', fr: 'En charge' },
  [WORK_MODES.UPDATING]: { en: 'Updating', fr: 'Mise à jour' },
  [WORK_MODES.LOCK]: { en: 'Locked', fr: 'Verrouillée' },
  [WORK_MODES.PAUSE]: { en: 'Paused', fr: 'En pause' },
  [WORK_MODES.MANUAL_MOWING]: { en: 'Manual mowing', fr: 'Tonte manuelle' },
  [WORK_MODES.UPDATE_SUCCESS]: { en: 'Update done', fr: 'Mise à jour terminée' },
  [WORK_MODES.OTA_UPGRADE_FAIL]: { en: 'Update failed', fr: 'Échec de mise à jour' },
  [WORK_MODES.JOB_DRAW]: { en: 'Mapping', fr: 'Cartographie' },
  [WORK_MODES.OBSTACLE_DRAW]: { en: 'Mapping obstacles', fr: 'Cartographie obstacles' },
  [WORK_MODES.CHANNEL_DRAW]: { en: 'Mapping channel', fr: 'Cartographie passage' },
  [WORK_MODES.ERASER_DRAW]: { en: 'Editing map', fr: 'Édition de carte' },
  [WORK_MODES.EDIT_BOUNDARY]: { en: 'Editing boundary', fr: 'Édition de bordure' },
  [WORK_MODES.LOCATION_ERROR]: { en: 'Location error', fr: 'Erreur de position' },
  [WORK_MODES.BOUNDARY_JUMP]: { en: 'Out of boundary', fr: 'Hors zone' },
  [WORK_MODES.CHARGING_PAUSE]: { en: 'Charging (job paused)', fr: 'En charge (tâche en pause)' },
};

// Work modes where the mower is out mowing (the "Mowing" switch is ON).
const MOWING_MODES = new Set([WORK_MODES.WORKING, WORK_MODES.MANUAL_MOWING]);

// Work modes where the mower is heading to, or sitting on, its dock.
const DOCK_MODES = new Set([WORK_MODES.RETURNING, WORK_MODES.CHARGING, WORK_MODES.CHARGING_PAUSE]);

const CHARGING_MODES = new Set([WORK_MODES.CHARGING, WORK_MODES.CHARGING_PAUSE]);

export function toNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Read one property whatever its envelope (items.x.value, x.value, x). */
function property(snapshot, key) {
  const data = snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;
  const items = data?.items && typeof data.items === 'object' ? data.items : {};
  for (const candidate of [items[key], data?.[key]]) {
    if (candidate === undefined || candidate === null) {
      continue;
    }
    if (typeof candidate === 'object' && 'value' in candidate) {
      return candidate.value;
    }
    return candidate;
  }
  return undefined;
}

/**
 * Normalize a properties snapshot. Every field is `null` when unknown.
 * @returns {{ battery: number|null, workMode: number|null, online: boolean|null,
 *   bladeHeightMm: number|null, totalWorkHours: number|null, totalDistanceKm: number|null,
 *   firmware: string|null }}
 */
export function parseProperties(snapshot) {
  const networkInfo = parseMaybeJson(property(snapshot, 'networkInfo')) ?? {};
  const iotState = toNumber(property(snapshot, 'iotState'));
  const workSeconds = toNumber(networkInfo.wt_sec);
  const mileageMeters = toNumber(networkInfo.mileage);
  const firmware = property(snapshot, 'deviceVersion');
  // A mower that answers is not at 0 %: 0 is a missing value (same rule as the
  // protobuf reports), and publishing it fires the Gladys low-battery alert.
  const battery = toNumber(property(snapshot, 'batteryPercentage'));

  return {
    battery: battery !== null && battery > 0 && battery <= 100 ? battery : null,
    workMode: toNumber(property(snapshot, 'deviceState')),
    online: iotState === null ? null : iotState === 1,
    bladeHeightMm: toNumber(property(snapshot, 'knifeHeight')),
    totalWorkHours: workSeconds === null ? null : Math.round((workSeconds / 3600) * 10) / 10,
    totalDistanceKm: mileageMeters === null ? null : Math.round(mileageMeters / 100) / 10,
    firmware: typeof firmware === 'string' && firmware ? firmware : null,
  };
}

/** Readable label of a work mode, in the requested language (en fallback). */
export function workModeLabel(workMode, online, language = 'en') {
  if (online === false) {
    return WORK_MODE_LABELS[WORK_MODES.OFFLINE][language] ?? 'Offline';
  }
  const labels = WORK_MODE_LABELS[workMode];
  if (!labels) {
    return workMode === null ? '' : `${language === 'fr' ? 'État' : 'State'} ${workMode}`;
  }
  return labels[language] ?? labels.en;
}

export function isMowing(workMode) {
  return MOWING_MODES.has(workMode);
}

export function isDocking(workMode) {
  return DOCK_MODES.has(workMode);
}

export function isCharging(workMode) {
  return CHARGING_MODES.has(workMode);
}

export function isPaused(workMode) {
  return workMode === WORK_MODES.PAUSE || workMode === WORK_MODES.CHARGING_PAUSE;
}
