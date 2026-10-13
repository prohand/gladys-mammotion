// -----------------------------------------------------------------------------
// Orders given to the mowers, the parts that do not need the SDK: the guard of
// a job being started, what an order answers to a scene or a widget, and the
// "Refresh the mowers" action. index.js wires them; tests drive them alone.
// -----------------------------------------------------------------------------

import { FEATURE } from './devices/mower.js';

/**
 * Jobs being started, one at most per mower.
 *
 * Starting a job reads the zones, plans a route then starts: 30 to 60 s during
 * which the mower still reports "ready". Without a guard, a second press (the
 * widget, a scene, a double click on the switch) planned a second route and
 * sent a second "start". The guard is taken SYNCHRONOUSLY, before any await,
 * so two orders arriving together cannot both get through, and it is kept a
 * little after a success (`holdMs`): the mower takes a moment to report that
 * it mows, and its pushes meanwhile still say "ready".
 */
export class JobStarts {
  /**
   * @param {{ holdMs?: number, now?: () => number }} [options]
   */
  constructor({ holdMs = 45_000, now = Date.now } = {}) {
    this.holdMs = holdMs;
    this.now = now;
    // iotId -> time (ms) until which a new start is refused (Infinity while planning)
    this.until = new Map();
  }

  /** Whether a job is being started on that mower. */
  isStarting(iotId) {
    const until = this.until.get(iotId);
    if (until === undefined) {
      return false;
    }
    if (this.now() < until) {
      return true;
    }
    this.until.delete(iotId);
    return false;
  }

  /**
   * Run `start` in the background unless a start is already under way on that
   * mower. `onStarted` / `onFailed` run after it; a failure frees the mower at
   * once (nothing was started: the next press must be able to try again).
   * @param {string} iotId
   * @param {() => Promise<void>} start
   * @param {{ onStarted?: () => any, onFailed?: (err: Error) => any }} [hooks]
   * @returns {Promise<boolean> | null} null when refused, else the outcome
   *   (true: started), which never rejects
   */
  launch(iotId, start, { onStarted, onFailed } = {}) {
    if (this.isStarting(iotId)) {
      return null;
    }
    this.until.set(iotId, Infinity);
    return Promise.resolve()
      .then(start)
      .then(
        async () => {
          this.until.set(iotId, this.now() + this.holdMs);
          await onStarted?.();
          return true;
        },
        async (err) => {
          this.until.delete(iotId);
          await onFailed?.(err);
          return false;
        },
      )
      .catch(() => false);
  }
}

// controlMower's answer when a start is refused because one is under way.
export const STARTING = 'starting';

// What an order did, as the `result` output of the scene actions says it.
// These values are stored in users' scenes: add, never rename.
const ORDER_RESULTS = {
  [FEATURE.MOWING]: {
    1: {
      startJob: 'started',
      resume: 'resumed',
      none: 'already_mowing',
      [STARTING]: 'already_starting',
    },
    0: { pause: 'paused', none: 'not_mowing' },
  },
  [FEATURE.DOCK]: { 1: { dock: 'returning', none: 'already_docked' } },
};

/**
 * The `result` of an order, from the command controlMower sent (null: none).
 * @returns {string}
 */
export function orderResult(key, value, command) {
  return ORDER_RESULTS[key]?.[value]?.[command ?? 'none'] ?? command ?? 'nothing_to_do';
}

// What the widget buttons answer, per result.
const ORDER_MESSAGES = {
  started: {
    en: 'Mowing started.',
    fr: 'Tonte lancée.',
    de: 'Mähen gestartet.',
    es: 'Corte iniciado.',
  },
  resumed: {
    en: 'Mowing resumed.',
    fr: 'Tonte reprise.',
    de: 'Mähen fortgesetzt.',
    es: 'Corte reanudado.',
  },
  already_mowing: {
    en: 'Already mowing.',
    fr: 'Déjà en tonte.',
    de: 'Mäht bereits.',
    es: 'Ya está cortando.',
  },
  already_starting: {
    en: 'A job is already being started, please wait.',
    fr: 'Une tâche est déjà en cours de lancement, patientez.',
    de: 'Ein Auftrag wird bereits gestartet, bitte warten Sie.',
    es: 'Ya se está iniciando una tarea, espere por favor.',
  },
  paused: {
    en: 'Mowing paused.',
    fr: 'Tonte en pause.',
    de: 'Mähen pausiert.',
    es: 'Corte en pausa.',
  },
  not_mowing: {
    en: 'Not mowing.',
    fr: 'Pas en tonte.',
    de: 'Mäht gerade nicht.',
    es: 'No está cortando.',
  },
  returning: {
    en: 'Returning to the dock.',
    fr: 'Retour à la base.',
    de: 'Rückkehr zur Ladestation.',
    es: 'Volviendo a la base.',
  },
  already_docked: {
    en: 'Already on the dock.',
    fr: 'Déjà sur la base.',
    de: 'Bereits in der Ladestation.',
    es: 'Ya está en la base.',
  },
};

/** The message a widget button shows for a result. */
export function orderMessage(result) {
  return (
    ORDER_MESSAGES[result] ?? {
      en: 'Order sent.',
      fr: 'Ordre envoyé.',
      de: 'Befehl gesendet.',
      es: 'Orden enviada.',
    }
  );
}

/**
 * "Refresh the mowers now": read EVERY mower, even when one fails (one mower
 * out of reach must not leave the others stale), then say which ones failed.
 * Throws when any failed: the Configuration screen shows a resolved action in
 * green and a thrown one in red, and a failed read needs the user's attention.
 * A thrown error reaches Gladys as text, hence every language in one string.
 * @param {Array<{ name: string }>} mowers
 * @param {(mower: object) => Promise<void>} read
 * @returns {Promise<{ en: string, fr: string, de: string, es: string }>}
 */
export async function refreshAll(mowers, read) {
  const results = await Promise.allSettled(mowers.map((mower) => read(mower)));
  const failed = results
    .map((result, i) => ({ result, mower: mowers[i] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ result, mower }) => `${mower.name} (${result.reason?.message ?? result.reason})`);
  const done = mowers.length - failed.length;
  if (failed.length > 0) {
    const list = failed.join(', ');
    throw new Error(
      `${done}/${mowers.length} mower(s) refreshed, failed: ${list} / ` +
        `${done}/${mowers.length} tondeuse(s) rafraîchie(s), en échec : ${list} / ` +
        `${done}/${mowers.length} Mäher aktualisiert, fehlgeschlagen: ${list} / ` +
        `${done}/${mowers.length} cortacésped(es) actualizado(s), con error: ${list}`,
    );
  }
  return {
    en: `${mowers.length} mower(s) refreshed.`,
    fr: `${mowers.length} tondeuse(s) rafraîchie(s).`,
    de: `${mowers.length} Mäher aktualisiert.`,
    es: `${mowers.length} cortacésped(es) actualizado(s).`,
  };
}
