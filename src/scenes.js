// -----------------------------------------------------------------------------
// Scene triggers and scene action outputs (Gladys 5.1).
//
// A trigger is a TRANSITION, never a state: "the mower is mowing" is already a
// feature (Mowing), what a scene needs on top is the move — mowing started, the
// job ended, the mower is back on its dock, something went wrong — fired once.
// Two rules keep that honest:
//   - no baseline, no event: the first status read after a start only records,
//     or a restart would announce that every mower "arrived" on its dock;
//   - an unknown work mode (null) moves nothing: a mower that has not reported
//     yet did not leave its dock.
//
// Everything here is pure: index.js feeds the statuses and publishes the events.
// Keys (triggers, actions, fields, variables, outputs, option values) are stored
// in users' scenes: add, never rename.
// -----------------------------------------------------------------------------

import {
  isCharging,
  isDocking,
  isMowing,
  isPaused,
  WORK_MODES,
  workModeLabel,
} from './mammotion/telemetry.js';

export const SCENE_TRIGGER = {
  MOWING_STARTED: 'mowing_started',
  JOB_ENDED: 'job_ended',
  DOCKED: 'docked',
  PROBLEM: 'mower_problem',
};

export const SCENE_ACTION = {
  START_MOWING: 'start_mowing',
  PAUSE_MOWING: 'pause_mowing',
  RETURN_TO_DOCK: 'return_to_dock',
  GET_STATUS: 'get_mower_status',
};

/** What went wrong, as the `problem` filter of the trigger compares it. */
export const PROBLEMS = {
  OFFLINE: 'offline',
  LOCATION_ERROR: 'location_error',
  OUT_OF_BOUNDARY: 'out_of_boundary',
  LOCKED: 'locked',
  UPDATE_FAILED: 'update_failed',
};

const PROBLEM_BY_WORK_MODE = {
  [WORK_MODES.LOCATION_ERROR]: PROBLEMS.LOCATION_ERROR,
  [WORK_MODES.BOUNDARY_JUMP]: PROBLEMS.OUT_OF_BOUNDARY,
  [WORK_MODES.LOCK]: PROBLEMS.LOCKED,
  [WORK_MODES.OTA_UPGRADE_FAIL]: PROBLEMS.UPDATE_FAILED,
};

/** The problem a status shows, or null. */
export function problemOf(status) {
  if (status?.online === false) {
    return PROBLEMS.OFFLINE;
  }
  return PROBLEM_BY_WORK_MODE[status?.workMode] ?? null;
}

/** Inside a job: mowing, paused, or paused on the dock to recharge. */
function inJob(workMode) {
  return isMowing(workMode) || isPaused(workMode);
}

/** The variables every event carries. */
function eventBase(deviceExternalId, name, status, language) {
  return {
    mower: deviceExternalId,
    mower_name: name,
    state: workModeLabel(status.workMode, status.online, language) || null,
    battery: status.battery ?? null,
  };
}

/**
 * Follows the statuses of every mower and turns their changes into events.
 *
 * One instance for the whole integration; a mower is keyed by its device
 * external_id, the value the `mower` filter of the triggers compares against.
 */
export class MowerEventTracker {
  constructor() {
    /** @type {Map<string, { workMode: number|null, online: boolean|null, problem: string|null, job: boolean }>} */
    this.last = new Map();
  }

  /** Forget everything (tests, a new account). */
  reset() {
    this.last.clear();
  }

  /**
   * @param {string} deviceExternalId the mower device external_id
   * @param {string} name the mower name
   * @param {object} status a status read (see client.getStatus)
   * @param {string} [language] the language of the texts stored in the events
   * @returns {{ key: string, data: object }[]} the events to fire, in order
   */
  observe(deviceExternalId, name, status, language = 'en') {
    const workMode = status?.workMode ?? null;
    const online = status?.online ?? null;
    const problem = problemOf(status);
    const previous = this.last.get(deviceExternalId);

    // A job is "on" from the moment the mower mows until it is back to an idle
    // state outside a pause: a recharge in the middle of a job (returning,
    // then charging with the job paused) is not its end.
    let job = previous?.job ?? false;
    if (workMode !== null && inJob(workMode)) {
      job = true;
    }
    const jobEnded =
      previous !== undefined &&
      previous.job &&
      (workMode === WORK_MODES.READY || workMode === WORK_MODES.CHARGING);
    if (jobEnded) {
      job = false;
    }

    this.last.set(deviceExternalId, { workMode, online, problem, job });
    if (previous === undefined) {
      return [];
    }

    const base = eventBase(deviceExternalId, name, status, language);
    const events = [];

    if (
      workMode !== null &&
      isMowing(workMode) &&
      previous.workMode !== null &&
      !isMowing(previous.workMode)
    ) {
      events.push({
        key: SCENE_TRIGGER.MOWING_STARTED,
        data: { ...base, resumed: isPaused(previous.workMode) },
      });
    }

    if (jobEnded) {
      events.push({
        key: SCENE_TRIGGER.JOB_ENDED,
        data: { ...base, progress: status.progressPercent ?? null },
      });
    }

    if (
      workMode !== null &&
      isCharging(workMode) &&
      previous.workMode !== null &&
      !isCharging(previous.workMode)
    ) {
      events.push({
        key: SCENE_TRIGGER.DOCKED,
        data: { ...base, job_paused: workMode === WORK_MODES.CHARGING_PAUSE },
      });
    }

    if (problem !== null && problem !== previous.problem) {
      events.push({ key: SCENE_TRIGGER.PROBLEM, data: { ...base, problem } });
    }

    return events;
  }
}

/**
 * Outputs of the get_mower_status scene action: the scalars the manifest
 * declares, null when the mower did not report the value.
 * @param {string} name the mower name
 * @param {object|null} status the last status read, null when none yet
 * @param {string} [language]
 */
export function statusOutputs(name, status, language = 'en') {
  const workMode = status?.workMode ?? null;
  const online = status?.online ?? null;
  const job = workMode !== null && inJob(workMode);
  return {
    mower_name: name,
    state: status ? workModeLabel(workMode, online, language) || null : null,
    online,
    mowing: workMode === null ? null : isMowing(workMode),
    docked: workMode === null ? null : isDocking(workMode),
    battery: status?.battery ?? null,
    progress: job ? (status.progressPercent ?? null) : null,
    remaining_minutes: job ? (status.remainingMinutes ?? null) : null,
    problem: status ? problemOf(status) : null,
  };
}
