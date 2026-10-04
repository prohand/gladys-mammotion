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
//    11: nav       (MctlNav { 30: todev_gethash NavGetHashList (every map element),
//                             32: todev_get_commondata NavGetCommData (one element),
//                             34: bidire_reqconver_path NavReqCoverPath (route),
//                             37: todev_taskctrl NavTaskCtrl { type, action, result },
//                             58: toapp_map_name_msg NavMapNameMsg (zone list) })
//    15: timestamp (ms)
//   }
// Field numbers: PyMammotion proto/luba_msg.proto, mctrl_nav.proto, mctrl_sys.proto,
// dev_net.proto.
// -----------------------------------------------------------------------------

import {
  bytesField,
  encodeVarint,
  floatField,
  message,
  packedFixed64Field,
  stringField,
  varintField,
} from './protobuf.js';

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
const YUKA_NAME = /^yuka-/i;

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

/** Wrap an encoded MctlNav into a LubaMsg sent to the right board. */
function navContent(nav, session, mower) {
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
  return navContent(message(bytesField(37, taskCtrl)), session, mower);
}

/**
 * Ask the mower for the zones of its map (PyMammotion get_area_name_list).
 * It answers with MctlNav.toapp_all_hash_name (61): { hashnames: [{ hash, name }] }.
 * @param {{ userAccount: string }} session
 * @param {{ iotId: string, productKey?: string, deviceName?: string }} mower
 */
export function buildZoneListRequestContent(session, mower) {
  // NavMapNameMsg { rw: 0 (read), deviceId: iotId } (zeros are omitted in proto3)
  const nameMsg = message(stringField(5, mower.iotId));
  return navContent(message(bytesField(58, nameMsg)), session, mower);
}

/**
 * Ask the mower for the hashes of every element of its map: zones, no-go
 * zones, paths… (PyMammotion get_all_boundary_hash_list(0)). The list may come
 * in several frames: the next one is asked with subCmd 2 and the frame just
 * received (get_hash_response). It answers with MctlNav.toapp_gethash_ack (31).
 * @param {{ userAccount: string }} session
 * @param {{ productKey?: string, deviceName?: string }} mower
 * @param {{ totalFrame: number, currentFrame: number }} [next] frame received, to get the next one
 */
export function buildHashListRequestContent(session, mower, next) {
  const request = next
    ? message(
        varintField(1, 1), // pver
        varintField(2, 2), // subCmd 2: next frame
        varintField(3, next.totalFrame),
        varintField(4, next.currentFrame),
      )
    : message(varintField(1, 1)); // pver, subCmd 0: every element of the map
  return navContent(message(bytesField(30, request)), session, mower);
}

/**
 * Ask the mower for one element of its map (PyMammotion synchronize_hash_data).
 * Its first frame, MctlNav.toapp_get_commondata_ack (33), gives its type
 * (0 = zone), its name and the start of its outline; the next frames are
 * asked with buildMapFrameRequestContent.
 * @param {{ userAccount: string }} session
 * @param {{ productKey?: string, deviceName?: string }} mower
 * @param {bigint} hash
 */
export function buildMapElementRequestContent(session, mower, hash) {
  const request = message(
    varintField(1, 1), // pver
    varintField(2, 1), // subCmd
    varintField(3, 8), // action: synchronize
    varintField(5, BigInt.asUintN(64, BigInt(hash))), // hash (int64)
  );
  return navContent(message(bytesField(32, request)), session, mower);
}

/**
 * Ask the mower for the next frame of a map element (PyMammotion
 * get_regional_data): the answer is the frame `currentFrame + 1`.
 * @param {{ userAccount: string }} session
 * @param {{ productKey?: string, deviceName?: string }} mower
 * @param {{ hash: bigint, type: number, action: number, totalFrame: number, currentFrame: number }} frame
 */
export function buildMapFrameRequestContent(session, mower, frame) {
  const request = message(
    varintField(1, 1), // pver
    varintField(2, 2), // subCmd 2: next frame
    varintField(3, frame.action), // action, as in the first frame
    varintField(4, frame.type), // type, as in the first frame
    varintField(5, BigInt.asUintN(64, BigInt(frame.hash))), // hash (int64)
    varintField(8, frame.totalFrame),
    varintField(9, frame.currentFrame),
  );
  return navContent(message(bytesField(32, request)), session, mower);
}

// Settings of the app -> NavReqCoverPath values (PyMammotion mowing_modes.py).
// CuttingMode: 0 single grid (zigzag), 1 double grid (chessboard), 2 segment
// grid, read as the "adaptive zigzag" of the app (to check: see logRoute).
const CHANNEL_MODES = { zigzag: 0, chessboard: 1, zigzag_adaptive: 2 };
const ULTRA_WAVE = { off: 0, slow: 1, less: 2 }; // DetectionStrategy
// PathAngleSetting: 0 relative (the mower picks the best angle), 1 absolute
// (the angle given), 2 random.
const TOWARD_MODES = { optimal: 0, custom: 1, random: 2 };
// toward_included_angle: angle between the two passes of a chessboard, only
// sent for a chessboard (PyMammotion build_route_information).
const INCLUDED_ANGLE = 90;

/**
 * 8-byte `reserved` string of a route (PyMammotion create_path_order): mowing
 * order (0 border first, 1 zigzag first), laps around the no-go zones, plan
 * enabled (0), start progress (%), then the model byte (8 on Luba 2 and later,
 * the "mow only" Yuka job mode on a Yuka) and the grass collection frequency (10).
 */
function pathOrder(mower, settings) {
  const bytes = [settings.mowing_order === 'border_first' ? 0 : 1, settings.obstacle_laps];
  bytes.push(0, settings.start_progress ?? 0, 0, 0, 0, 0);
  if (receiverFor(mower) === DEV_NAVIGATION) {
    bytes[5] = 8;
    bytes[6] = 10;
  }
  return String.fromCharCode(...bytes);
}

/**
 * Plan a mowing route over the given zones (PyMammotion generate_route_information)
 * with the mowing settings of the configuration (see config.js). The mower
 * answers with a MctlNav.bidire_reqconver_path (34); the job then starts with "start".
 * @param {{ userAccount: string }} session
 * @param {{ productKey?: string, deviceName?: string }} mower
 * @param {{ zones: bigint[], settings: object }} route settings: normalized config
 */
export function buildRouteContent(session, mower, { zones, settings }) {
  // A Yuka has no height to set: the app sends -10 (int32, 10 bytes on the wire).
  const height = YUKA_NAME.test(mower.deviceName ?? '') ? -10 : settings.blade_height;
  const route = message(
    varintField(1, 1), // pver
    varintField(4, 4), // jobMode
    varintField(6, settings.border_laps), // edgeMode: border laps
    varintField(7, height < 0 ? BigInt.asUintN(64, BigInt(height)) : height), // knifeHeight
    varintField(8, settings.line_spacing), // channelWidth (cm)
    varintField(9, ULTRA_WAVE[settings.obstacle_detection] ?? 0), // UltraWave: obstacle detection
    varintField(10, CHANNEL_MODES[settings.mowing_pattern] ?? 0), // channelMode
    varintField(11, settings.mowing_angle), // toward (degrees)
    floatField(12, settings.mowing_speed), // speed (m/s)
    packedFixed64Field(13, zones), // zoneHashs
    stringField(15, pathOrder(mower, settings)), // reserved
    varintField(17, TOWARD_MODES[settings.angle_mode] ?? 0), // toward_mode: angle type
    varintField(18, settings.mowing_pattern === 'chessboard' ? INCLUDED_ANGLE : 0), // toward_included_angle
    varintField(20, 1), // task_settings_mode: advanced
    bytesField(21, Buffer.alloc(32)), // auto_change_direction: off (packed, 32 bytes)
  );
  return navContent(message(bytesField(34, route)), session, mower);
}

/**
 * Ask the mower for the route of its interrupted job (PyMammotion
 * query_generate_route_information): the app sends it before "start" to carry
 * on a job that stopped halfway (low battery, rain…).
 * @param {{ userAccount: string }} session
 * @param {{ productKey?: string, deviceName?: string }} mower
 */
export function buildRouteQueryContent(session, mower) {
  const route = message(varintField(1, 1), varintField(5, 2)); // pver, subCmd 2
  return navContent(message(bytesField(34, route)), session, mower);
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
