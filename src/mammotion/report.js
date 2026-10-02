// -----------------------------------------------------------------------------
// Mower state pushed as protobuf on the Mammotion broker.
//
// After a report request (commands.js buildReportRequestContent) the mower
// answers within seconds on `thing/event/device_protobuf_msg_event/post`:
//   { params: { content: <base64 LubaMsg> } }
//
//   LubaMsg { 10: sys MctlSys { 39: toapp_report_data report_info_data {
//     2: dev      rpt_dev_status { 1: sys_status, 2: charge_state, 3: battery_val }
//     5: work     rpt_work { 3: progress, 4: area, 20: knife_height }
//     7: maintain rpt_maintain { 1: mileage (m), 2: work_time (s) }
//   } } }
// `area` packs the done percentage in its high 16 bits, `progress` the
// remaining minutes in its high 16 bits (same reading as Mammotion-HA).
// Field numbers: PyMammotion proto/luba_msg.proto and mctrl_sys.proto.
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
 *   progressPercent?: number, remainingMinutes?: number, totalWorkHours?: number,
 *   totalDistanceKm?: number } | null}
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
