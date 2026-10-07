// -----------------------------------------------------------------------------
// Dashboard widget "Mammotion mower" (Gladys 5.1).
//
// A card is a declarative content the core renders, never HTML. It is built
// from the LAST status the polls and the broker pushes left in memory: opening
// a dashboard must not send a single message to the mower (every one disturbs
// the Mammotion app, see index.js). The map stays on its own camera device,
// which the core's camera widget already shows.
//
// Tiles carry inline values, not device_feature bindings: the core draws a
// bound gauge without its unit, and index.js nudges the widget whenever a
// status moves, so an inline value follows the mower just as closely.
//
// The buttons send the same orders as the features of the device (Mowing,
// Return to dock), through the same path: a refused order says why.
// Keys are stored in users' dashboards: add, never rename.
// -----------------------------------------------------------------------------

import { WIDGET_BUTTON_STYLES, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { isCharging, isMowing, isPaused, workModeLabel } from './mammotion/telemetry.js';
import { problemOf, PROBLEMS } from './scenes.js';

export const WIDGET = { MOWER: 'mower' };

export const WIDGET_ACTION = {
  START: 'start_mowing',
  PAUSE: 'pause_mowing',
  DOCK: 'return_to_dock',
};

const TTL_SECONDS = 60;

const PROBLEM_TEXT = {
  [PROBLEMS.OFFLINE]: { en: 'Offline', fr: 'Hors ligne' },
  [PROBLEMS.LOCATION_ERROR]: { en: 'Location error', fr: 'Erreur de position' },
  [PROBLEMS.OUT_OF_BOUNDARY]: { en: 'Out of boundary', fr: 'Hors zone' },
  [PROBLEMS.LOCKED]: { en: 'Locked', fr: 'Verrouillée' },
  [PROBLEMS.UPDATE_FAILED]: { en: 'Update failed', fr: 'Échec de mise à jour' },
};

/** Cut a text to the bound the core applies, with an ellipsis. */
function clip(text, length) {
  const characters = [...String(text)];
  return characters.length <= length
    ? String(text)
    : `${characters.slice(0, length - 1).join('')}…`;
}

/** Both languages of a work mode, the core picking the reader's. */
function stateText(status) {
  return {
    en: clip(workModeLabel(status.workMode, status.online, 'en') || 'Unknown', 40),
    fr: clip(workModeLabel(status.workMode, status.online, 'fr') || 'Inconnu', 40),
  };
}

function stateColor(status) {
  if (problemOf(status) !== null) return WIDGET_COLORS.DANGER;
  if (isMowing(status.workMode)) return WIDGET_COLORS.SUCCESS;
  if (isPaused(status.workMode)) return WIDGET_COLORS.WARNING;
  return WIDGET_COLORS.NEUTRAL;
}

/** Minutes as the tile shows them: `45 min`, `1 h 05`. */
function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** A card that only says something. */
export function messageContent(text) {
  return { ttl_seconds: TTL_SECONDS, components: [{ type: 'text', variant: 'body', text }] };
}

/**
 * The card of one mower.
 * @param {string} name the mower name
 * @param {object|null} status the last status read, null when none yet
 * @returns {object} the widget content
 */
export function buildMowerWidget(name, status) {
  const components = [{ type: 'text', variant: 'heading', text: clip(name, 40) }];
  if (!status || (status.workMode === null && status.online === null)) {
    components.push({
      type: 'text',
      variant: 'body',
      text: {
        en: 'No status from the mower yet: it will show at its next report.',
        fr: 'Pas encore d’état de la tondeuse : il s’affichera à son prochain rapport.',
      },
    });
    return { ttl_seconds: TTL_SECONDS, components };
  }

  const job = isMowing(status.workMode) || isPaused(status.workMode);
  if (Number.isFinite(status.battery)) {
    components.push({
      type: 'gauge',
      label: { en: 'Battery', fr: 'Batterie' },
      value: Math.round(status.battery),
      min: 0,
      max: 100,
      unit: '%',
      color: status.battery < 20 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    });
  }
  if (job && Number.isFinite(status.progressPercent)) {
    components.push({
      type: 'value',
      label: { en: 'Progress', fr: 'Avancement' },
      value: Math.round(status.progressPercent),
      unit: '%',
      icon: 'trending-up',
    });
  }
  if (job && Number.isFinite(status.remainingMinutes)) {
    components.push({
      type: 'value',
      label: { en: 'Remaining', fr: 'Restant' },
      value: formatMinutes(status.remainingMinutes),
      icon: 'clock',
    });
  }

  const items = [
    {
      label: { en: 'State', fr: 'État' },
      value: stateText(status),
      color: stateColor(status),
    },
  ];
  const problem = problemOf(status);
  if (problem !== null && problem !== PROBLEMS.OFFLINE) {
    items.push({
      label: { en: 'Problem', fr: 'Problème' },
      value: PROBLEM_TEXT[problem],
      color: WIDGET_COLORS.DANGER,
    });
  }
  const charging =
    typeof status.charging === 'boolean' ? status.charging : isCharging(status.workMode);
  items.push({
    label: { en: 'On the dock', fr: 'Sur la base' },
    value: charging ? { en: 'Charging', fr: 'En charge' } : { en: 'No', fr: 'Non' },
  });
  components.push({ type: 'status', items });

  if (status.online !== false) {
    if (isMowing(status.workMode)) {
      components.push(button(WIDGET_ACTION.PAUSE, { en: 'Pause', fr: 'Pause' }, 'pause'));
    } else {
      components.push(
        button(
          WIDGET_ACTION.START,
          isPaused(status.workMode)
            ? { en: 'Resume', fr: 'Reprendre' }
            : { en: 'Start mowing', fr: 'Tondre' },
          'play',
          WIDGET_BUTTON_STYLES.PRIMARY,
        ),
      );
    }
    if (!isCharging(status.workMode)) {
      components.push(button(WIDGET_ACTION.DOCK, { en: 'Back to dock', fr: 'Rentrer' }, 'home'));
    }
  }
  return { ttl_seconds: TTL_SECONDS, components };
}

function button(key, label, icon, style = WIDGET_BUTTON_STYLES.SECONDARY) {
  return { type: 'button', label, icon, style, action: { key } };
}
