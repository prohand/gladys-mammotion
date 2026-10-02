// -----------------------------------------------------------------------------
// Mower commands, encoded as the protobuf `LubaMsg` the Mammotion app sends.
//
//   LubaMsg {
//     1: msgtype   (240 = MSG_CMD_TYPE_NAV)
//     2: sender    (7   = DEV_MOBILEAPP)
//     3: rcver     (1   = DEV_MAINCTL, 17 = DEV_NAVIGATION, see receiverFor)
//     4: msgattr   (1   = MSG_ATTR_REQ)
//     5: seqs
//     6: version   (1)
//     7: subtype   (numeric user account id)
//     8: net       (DevNet { 1: todev_ble_sync })
//    10: sys       (MctlSys { 38: todev_report_cfg })
//    11: nav       (MctlNav { 37: todev_taskctrl NavTaskCtrl { type, action, result } })
//    15: timestamp (ms)
//   }
// Field numbers: PyMammotion proto/luba_msg.proto, mctrl_nav.proto, mctrl_sys.proto,
// dev_net.proto.
// -----------------------------------------------------------------------------

import { bytesField, encodeVarint, message, varintField } from './protobuf.js';

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
const MSG_CMD_TYPE_EMBED_SYS = 244;
const MSG_CMD_TYPE_ESP = 248;
const DEV_COMM_ESP = 0;
const DEV_MOBILEAPP = 7;
const DEV_MAINCTL = 1;
const DEV_NAVIGATION = 17;

// Luba 1 product keys (PyMammotion utility/device_type.py, LubaProductKey).
const LUBA1_PRODUCT_KEYS = new Set([
  'a1UBFdq6nNz',
  'a1x0zHD3Xop',
  'a1pvCnb3PPu',
  'a1kweSOPylG',
  'a1JFpmAV5Ur',
  'a1BmXWlsdbA',
  'a1jOhAYOIG8',
  'a1K4Ki2L5rK',
  'a1ae1QnXZGf',
  'a1nf9kRBWoH',
  'a1ZU6bdGjaM',
  'a1FbaU4Bqk5',
  'b9tzVWaMxDZ',
]);

// Product keys of the later mowers (Luba 2, Luba 2 VPro, Luba mini, Yuka…).
const NEW_GEN_PRODUCT_KEYS = new Set([
  'a1iMygIwxFC',
  'a1LLmy1zc0j',
  '6kWUnPW8UrW',
  'a1mb8v6tnAa',
  'a1pHsTqyoPR',
  'ATyVu9QkAdX',
  'a1L5ZfJIxGl',
  'a1dCWYFLROK',
  'ftDnXns2cdT',
  'a1kT0TlYEza',
  'a1IQV0BrnXb',
  'KJHXKHMEvj3',
  'a1lNESu9VST',
  'a1zAEzmvWDa',
  'UfsEwwHp8uz',
  'a1BqmEWMRbX',
  'a1biqVGvxrE',
  '8xMGQS6DESC',
  'a1jFe8HzcDb',
  'a16cz0iXgUJ',
  'USpE46bNTC7',
  'pdA6uJrBfjz',
  'a1jDMfG2Fgj',
  'a1vtZq9LUFS',
  'FpstPz2SpwH',
  'a1Ce85210Be',
  'a1BBOJnnjb9',
  'uY54W5rM8YH',
  'a1OWGO8WXbh',
  'a1s6znKxGvI',
  '5BMtap5Q3Yq',
]);

// Technical names of the later mowers: "Luba-VS…", "Luba-VP…", "Yuka-MN…"…
const NEW_GEN_NAME = /^(luba-[a-z]{2}|yuka-)/i;

// rpt_info_type channels asked in a report request: connection, device state
// (work mode, battery, charge), RTK, location, work (blade height, progress),
// maintenance (total distance and mowing time).
const REPORT_CHANNELS = [0, 1, 2, 3, 4, 6];

// todev_ble_sync value the app sends over the cloud (2 is for Bluetooth).
const SYNC_CLOUD = 3;

let seq = 0;

function nextSeq() {
  seq = (seq + 1) & 0xff;
  return seq;
}

function accountId(session) {
  const subtype = Number.parseInt(session.userAccount, 10);
  return Number.isNaN(subtype) ? 0 : subtype;
}

/**
 * Which board of the mower receives navigation commands. Every mower but the
 * Luba 1 takes them on its navigation board (PyMammotion get_msg_device /
 * DeviceType.is_luba_pro); a command sent to the main controller is accepted
 * by the cloud and silently ignored by the mower.
 * @param {{ productKey?: string, deviceName?: string }} mower
 */
export function receiverFor(mower) {
  if (LUBA1_PRODUCT_KEYS.has(mower.productKey)) {
    return DEV_MAINCTL;
  }
  if (NEW_GEN_PRODUCT_KEYS.has(mower.productKey) || NEW_GEN_NAME.test(mower.deviceName ?? '')) {
    return DEV_NAVIGATION;
  }
  return DEV_MAINCTL;
}

/**
 * Build the base64 `content` of a task control command (start, pause, dock…).
 * @param {keyof typeof MOWER_ACTIONS} command
 * @param {{ userAccount: string }} session
 * @param {{ productKey?: string, deviceName?: string }} mower
 */
export function buildTaskControlContent(command, session, mower) {
  const action = MOWER_ACTIONS[command];
  if (action === undefined) {
    throw new Error(`Unknown mower command "${command}"`);
  }
  const taskCtrl = message(varintField(1, 1), varintField(2, action), varintField(3, 0));
  const nav = message(bytesField(37, taskCtrl));

  return message(
    varintField(1, MSG_CMD_TYPE_NAV),
    varintField(2, DEV_MOBILEAPP),
    varintField(3, receiverFor(mower)),
    varintField(4, 1),
    varintField(5, nextSeq()),
    varintField(6, 1),
    varintField(7, accountId(session)),
    bytesField(11, nav),
    varintField(15, BigInt(Date.now())),
  ).toString('base64');
}

/**
 * Build the base64 `content` asking the mower to push its state now
 * (MctlSys.todev_report_cfg, PyMammotion request_iot_sys with count = 1).
 * The mower answers with a `toapp_report_data` on the broker (see report.js).
 * @param {{ userAccount: string }} session
 */
export function buildReportRequestContent(session) {
  const reportCfg = message(
    varintField(1, 0), // act: RPT_START
    varintField(2, 10_000), // timeout (ms)
    varintField(3, 1_000), // period (ms)
    varintField(4, 4_000), // no_change_period (ms)
    varintField(5, 1), // count: one report
    bytesField(6, message(...REPORT_CHANNELS.map((c) => encodeVarint(c)))), // sub (packed)
  );
  const sys = message(bytesField(38, reportCfg));

  return message(
    varintField(1, MSG_CMD_TYPE_EMBED_SYS),
    varintField(2, DEV_MOBILEAPP),
    varintField(3, DEV_MAINCTL),
    varintField(4, 1),
    varintField(5, nextSeq()),
    varintField(6, 1),
    varintField(7, accountId(session)),
    bytesField(10, sys),
    varintField(15, BigInt(Date.now())),
  ).toString('base64');
}

/**
 * Build the base64 `content` of the "sync" keep-alive (DevNet.todev_ble_sync = 3).
 * The mower only listens to the cloud for ~10 s after a sync: without it, it
 * ignores commands and report requests ("Device not responding"). The app
 * sends one before its commands, and so does PyMammotion (device/handle.py).
 * @param {{ userAccount: string }} session
 */
export function buildSyncContent(session) {
  return message(
    varintField(1, MSG_CMD_TYPE_ESP),
    varintField(2, DEV_MOBILEAPP),
    varintField(3, DEV_COMM_ESP),
    varintField(4, 1),
    varintField(5, nextSeq()),
    varintField(6, 1),
    varintField(7, accountId(session)),
    bytesField(8, message(varintField(1, SYNC_CLOUD))),
    varintField(15, BigInt(Date.now())),
  ).toString('base64');
}
