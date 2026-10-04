// -----------------------------------------------------------------------------
// Mower state pushed as protobuf on the Mammotion broker.
//
// After a report request (commands.js buildReportRequestContent) the mower
// answers within seconds on `thing/event/device_protobuf_msg_event/post`:
//   { params: { content: <base64 LubaMsg> } }
//
//   LubaMsg { 10: sys MctlSys { 39: toapp_report_data report_info_data {
//     2: dev       rpt_dev_status { 1: sys_status, 2: charge_state, 3: battery_val }
//     4: locations rpt_dev_location { 1: real_pos_x, 2: real_pos_y (1/10000 m), 5: zone_hash }
//     5: work      rpt_work { 3: progress, 4: area, 5: bp_info, 20: knife_height }
//     7: maintain  rpt_maintain { 1: mileage (m), 2: work_time (s) }
//   } } }
// `area` packs the done percentage in its high 16 bits and the area of the
// job (m²) in its low 16 bits, `progress` the remaining minutes in its high 16
// bits and the total minutes of the job in its low 16 bits (Mammotion-HA).
// The position is in the frame of the map points (metres, see parseMapElement).
// `bp_info` is not 0 while a job stopped halfway can be carried on.
//
// The answers to the navigation requests (map elements, zone names, route) come on the same
// topic, in LubaMsg { 11: nav MctlNav } (see parseNav).
// Field numbers: PyMammotion proto/luba_msg.proto, mctrl_sys.proto, mctrl_nav.proto.
// -----------------------------------------------------------------------------

import { decodeMessage } from './protobuf.js';

const first = (fields, n) => fields?.[n]?.[0];

function int(value) {
  if (typeof value !== 'bigint') {
    return null;
  }
  // int32 fields: negative values are sent on 10 bytes.
  return Number(BigInt.asIntN(32, value));
}

function int64(value) {
  return typeof value === 'bigint' ? Number(BigInt.asIntN(64, value)) : null;
}

function sub(fields, n) {
  const value = first(fields, n);
  return Buffer.isBuffer(value) ? decodeMessage(value) : null;
}

/**
 * Decode a base64 LubaMsg and return the telemetry it carries (only the known
 * fields are set), or null when it is not a state report.
 * @param {string} content
 * @returns {{ workMode?: number, battery?: number, charging?: boolean, bladeHeightMm?: number,
 *   progressPercent?: number, remainingMinutes?: number, totalMinutes?: number,
 *   jobAreaM2?: number, interruptedJob?: boolean, position?: { x: number, y: number },
 *   totalWorkHours?: number, totalDistanceKm?: number } | null}
 */
export function parseReport(content) {
  try {
    const luba = decodeMessage(Buffer.from(String(content), 'base64'));
    const report = sub(sub(luba, 10), 39);
    if (!report) {
      return null;
    }
    const status = {};
    const dev = sub(report, 2);
    if (dev) {
      const workMode = int(first(dev, 1));
      if (workMode !== null) {
        status.workMode = workMode;
      }
      const battery = int(first(dev, 3));
      // proto3 omits zeros: a report without battery_val says nothing.
      if (battery !== null && battery > 0 && battery <= 100) {
        status.battery = battery;
      }
      // 1 = charging, 2 = full on the dock (proto3 omits 0 = off the dock).
      const chargeState = int(first(dev, 2)) ?? 0;
      status.charging = chargeState === 1 || chargeState === 2;
    }
    const work = sub(report, 5);
    if (work) {
      const height = int(first(work, 20));
      if (height !== null && height > 0) {
        status.bladeHeightMm = height;
      }
      const area = int(first(work, 4)) ?? 0;
      const progress = int(first(work, 3)) ?? 0;
      status.progressPercent = Math.min(100, area >>> 16);
      status.jobAreaM2 = area & 0xffff;
      status.remainingMinutes = progress >>> 16;
      status.totalMinutes = progress & 0xffff;
      status.interruptedJob = (int(first(work, 5)) ?? 0) !== 0;
    }
    // The first location is the mower (PyMammotion update_report_data); a zero
    // y means no position (proto3 omits zeros, PyMammotion skips it too).
    const location = Buffer.isBuffer(first(report, 4)) ? decodeMessage(first(report, 4)) : null;
    const y = int(first(location, 2));
    if (location && y) {
      status.position = { x: (int(first(location, 1)) ?? 0) / 10_000, y: y / 10_000 };
    }
    const maintain = sub(report, 7);
    if (maintain) {
      const meters = int64(first(maintain, 1));
      const seconds = int(first(maintain, 2));
      if (meters !== null && meters > 0) {
        status.totalDistanceKm = Math.round(meters / 100) / 10;
      }
      if (seconds !== null && seconds > 0) {
        status.totalWorkHours = Math.round((seconds / 3600) * 10) / 10;
      }
    }
    return Object.keys(status).length > 0 ? status : null;
  } catch {
    return null;
  }
}

/**
 * Decode a base64 LubaMsg and return its MctlNav fields ({ fieldNumber: [values] }),
 * or null when it carries no navigation message.
 * @param {string} content
 */
export function parseNav(content) {
  try {
    return sub(decodeMessage(Buffer.from(String(content), 'base64')), 11);
  } catch {
    return null;
  }
}

/**
 * Zone hashes of a MctlNav.toapp_all_hash_name (61) answer, or null when the
 * nav message is something else.
 * @returns {Array<{ hash: bigint, name: string }> | null}
 */
export function parseZoneList(nav) {
  const list = sub(nav, 61);
  if (!list) {
    return null;
  }
  return (list[2] ?? [])
    .map((entry) => decodeMessage(entry))
    .map((zone) => ({ hash: first(zone, 1), name: first(zone, 2)?.toString('utf8') ?? '' }))
    .filter((zone) => typeof zone.hash === 'bigint' && zone.hash !== 0n);
}

/**
 * One frame of the map element hashes, MctlNav.toapp_gethash_ack (31), or null
 * when the nav message is something else. dataCouple is a repeated int64:
 * packed (proto3 default) or not.
 * @returns {{ subCmd: number, totalFrame: number, currentFrame: number, hashes: bigint[] } | null}
 */
export function parseHashList(nav) {
  const ack = sub(nav, 31);
  if (!ack) {
    return null;
  }
  const hashes = [];
  for (const value of ack[13] ?? []) {
    if (typeof value === 'bigint') {
      hashes.push(value);
    } else if (Buffer.isBuffer(value)) {
      hashes.push(...readPackedVarints(value));
    }
  }
  return {
    subCmd: int(first(ack, 2)) ?? 0,
    totalFrame: int(first(ack, 3)) ?? 0,
    currentFrame: int(first(ack, 4)) ?? 0,
    hashes: hashes.map((h) => BigInt.asUintN(64, h)).filter((h) => h !== 0n),
  };
}

function readPackedVarints(buf) {
  const values = [];
  let value = 0n;
  let shift = 0n;
  for (const byte of buf) {
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (!(byte & 0x80)) {
      values.push(value);
      value = 0n;
      shift = 0n;
    }
  }
  return values;
}

// NavGetCommDataAck.type of a mowing zone and of a no-go zone (PyMammotion PathType).
export const MAP_ELEMENT_ZONE = 0;
export const MAP_ELEMENT_OBSTACLE = 1;

const float32 = (value) =>
  Buffer.isBuffer(value) && value.length === 4 ? value.readFloatLE(0) : 0;

/**
 * One frame of a map element, MctlNav.toapp_get_commondata_ack (33), when it
 * is the element of the given hash (and frame, if given); null otherwise.
 * `points` is the part of the outline carried by this frame (dataCouple, in
 * metres, in the frame of the RTK base: x towards the east, y towards the
 * north, turned by the base heading).
 * @param {object} nav
 * @param {bigint} hash
 * @param {number} [frame] wanted frame (1 = first)
 * @returns {{ hash: bigint, type: number, name: string, action: number, totalFrame: number,
 *   currentFrame: number, points: Array<{ x: number, y: number }> } | null}
 */
export function parseMapElement(nav, hash, frame) {
  const ack = sub(nav, 33);
  if (!ack || first(ack, 6) !== BigInt.asUintN(64, BigInt(hash))) {
    return null;
  }
  const currentFrame = int(first(ack, 10)) ?? 1;
  if (frame !== undefined && currentFrame !== frame) {
    return null;
  }
  const nameTime = sub(ack, 15);
  const points = (ack[13] ?? [])
    .filter(Buffer.isBuffer)
    .map((couple) => decodeMessage(couple))
    .map((couple) => ({ x: float32(first(couple, 1)), y: float32(first(couple, 2)) }));
  return {
    hash: first(ack, 6),
    type: int(first(ack, 5)) ?? 0,
    name: first(nameTime, 1)?.toString('utf8') ?? '',
    action: int(first(ack, 4)) ?? 0,
    totalFrame: Math.max(1, int(first(ack, 9)) ?? 1),
    currentFrame,
    points,
  };
}

/**
 * Answer to a route request (MctlNav.bidire_reqconver_path, 34) of the given
 * sub command (0 = plan, 2 = read the current route), or null.
 * @returns {{ result: number } | null}
 */
export function parseRouteAnswer(nav, subCmd) {
  const route = sub(nav, 34);
  if (!route || (int(first(route, 5)) ?? 0) !== subCmd) {
    return null;
  }
  return { result: int(first(route, 16)) ?? 0 };
}

/**
 * Settings of a route seen on the broker (MctlNav.bidire_reqconver_path, 34),
 * whoever planned it (Gladys or the app), or null. Logged to check what each
 * choice of the app sends (angle type, path mode…).
 * The mower echoes the `reserved` bytes + 10 (PyMammotion RESERVED_ECHO_OFFSET).
 */
export function parseRouteSettings(nav) {
  const route = sub(nav, 34);
  if (!route) {
    return null;
  }
  const reserved = [...(first(route, 15) ?? Buffer.alloc(0))];
  return {
    subCmd: int(first(route, 5)) ?? 0,
    edgeMode: int(first(route, 6)) ?? 0,
    knifeHeight: int(first(route, 7)) ?? 0,
    channelWidth: int(first(route, 8)) ?? 0,
    ultraWave: int(first(route, 9)) ?? 0,
    channelMode: int(first(route, 10)) ?? 0,
    toward: int(first(route, 11)) ?? 0,
    speed: Math.round(float32(first(route, 12)) * 100) / 100,
    zones: (route[13] ?? []).length,
    reserved,
    towardMode: int(first(route, 17)) ?? 0,
    towardIncludedAngle: int(first(route, 18)) ?? 0,
  };
}
