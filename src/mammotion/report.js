// -----------------------------------------------------------------------------
// Mower state pushed as protobuf on the Mammotion broker.
//
// After a report request (commands.js buildReportRequestContent) the mower
// answers within seconds on `thing/event/device_protobuf_msg_event/post`:
//   { params: { content: <base64 LubaMsg> } }
//
//   LubaMsg { 10: sys MctlSys { 39: toapp_report_data report_info_data {
//     2: dev      rpt_dev_status { 1: sys_status, 2: charge_state, 3: battery_val }
//     5: work     rpt_work { 3: progress, 4: area, 5: bp_info, 20: knife_height }
//     7: maintain rpt_maintain { 1: mileage (m), 2: work_time (s) }
//   } } }
// `area` packs the done percentage in its high 16 bits, `progress` the
// remaining minutes in its high 16 bits (same reading as Mammotion-HA).
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
 *   progressPercent?: number, remainingMinutes?: number, interruptedJob?: boolean,
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
      status.progressPercent = Math.min(100, (int(first(work, 4)) ?? 0) >>> 16);
      status.remainingMinutes = (int(first(work, 3)) ?? 0) >>> 16;
      status.interruptedJob = (int(first(work, 5)) ?? 0) !== 0;
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

// NavGetCommDataAck.type of a mowing zone (PyMammotion PathType.AREA).
export const MAP_ELEMENT_ZONE = 0;

/**
 * First frame of a map element, MctlNav.toapp_get_commondata_ack (33), when it
 * is the element of the given hash; null otherwise.
 * @returns {{ hash: bigint, type: number, name: string } | null}
 */
export function parseMapElement(nav, hash) {
  const ack = sub(nav, 33);
  if (!ack || first(ack, 6) !== BigInt.asUintN(64, BigInt(hash))) {
    return null;
  }
  const nameTime = sub(ack, 15);
  return {
    hash: first(ack, 6),
    type: int(first(ack, 5)) ?? 0,
    name: first(nameTime, 1)?.toString('utf8') ?? '',
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
