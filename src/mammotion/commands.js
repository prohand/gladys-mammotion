// -----------------------------------------------------------------------------
// Mower commands, encoded as the protobuf `LubaMsg` the Mammotion app sends.
//
//   LubaMsg {
//     1: msgtype   (240 = MSG_CMD_TYPE_NAV)
//     2: sender    (7   = DEV_MOBILEAPP)
//     3: rcver     (1   = DEV_MAINCTL, 17 = DEV_NAVIGATION on Luba Pro)
//     4: msgattr   (1   = MSG_ATTR_REQ)
//     5: seqs
//     6: version   (1)
//     7: subtype   (numeric user account id)
//    11: nav       (MctlNav { 37: todev_taskctrl NavTaskCtrl { type, action, result } })
//    15: timestamp (ms)
//   }
// -----------------------------------------------------------------------------

import { bytesField, message, varintField } from './protobuf.js';

// NavTaskCtrl.action values understood by the mower.
export const MOWER_ACTIONS = {
  start: 1,
  pause: 2,
  resume: 3,
  stop: 4,
  dock: 5,
  cancelDock: 12,
};

const MSG_CMD_TYPE_NAV = 240;
const DEV_MOBILEAPP = 7;
const DEV_MAINCTL = 1;
const DEV_NAVIGATION = 17;

// Luba Pro (a.k.a. Luba VPro) routes navigation commands to its navigation
// board instead of the main controller.
const LUBA_PRO_PRODUCT_KEYS = new Set(['a1mb8v6tnAa', 'a1pHsTqyoPR']);

let seq = 0;

/**
 * Which board of the mower receives navigation commands.
 * @param {{ productKey?: string, name?: string, series?: string }} mower
 */
export function receiverFor(mower) {
  const hint = `${mower.name ?? ''} ${mower.series ?? ''}`.toLowerCase();
  if (LUBA_PRO_PRODUCT_KEYS.has(mower.productKey) || hint.includes('luba pro')) {
    return DEV_NAVIGATION;
  }
  return DEV_MAINCTL;
}

/**
 * Build the base64 `content` of a task control command (start, pause, dock…).
 * @param {keyof typeof MOWER_ACTIONS} command
 * @param {{ userAccount: string }} session
 * @param {{ productKey?: string, name?: string, series?: string }} mower
 */
export function buildTaskControlContent(command, session, mower) {
  const action = MOWER_ACTIONS[command];
  if (action === undefined) {
    throw new Error(`Unknown mower command "${command}"`);
  }
  const subtype = Number.parseInt(session.userAccount, 10);
  seq = (seq + 1) & 0xff;

  const taskCtrl = message(varintField(1, 1), varintField(2, action), varintField(3, 0));
  const nav = message(bytesField(37, taskCtrl));

  return message(
    varintField(1, MSG_CMD_TYPE_NAV),
    varintField(2, DEV_MOBILEAPP),
    varintField(3, receiverFor(mower)),
    varintField(4, 1),
    varintField(5, seq),
    varintField(6, 1),
    varintField(7, Number.isNaN(subtype) ? 0 : subtype),
    bytesField(11, nav),
    varintField(15, BigInt(Date.now())),
  ).toString('base64');
}
