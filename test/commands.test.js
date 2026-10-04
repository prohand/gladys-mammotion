import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  buildHashListRequestContent,
  buildMapElementRequestContent,
  buildMapFrameRequestContent,
  buildReportRequestContent,
  buildRouteContent,
  buildRouteQueryContent,
  buildSyncContent,
  buildTaskControlContent,
  buildZoneListRequestContent,
  MOWER_ACTIONS,
  receiverFor,
} from '../src/mammotion/commands.js';
import {
  bytesField,
  decodeMessage,
  encodeVarint,
  floatField,
  message,
  stringField,
  varintField,
} from '../src/mammotion/protobuf.js';
import {
  parseHashList,
  parseMapElement,
  parseRouteAnswer,
  parseRouteSettings,
  parseZoneList,
} from '../src/mammotion/report.js';

// Minimal protobuf reader, enough to check what we encode.
function decode(buf) {
  const fields = {};
  let pos = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buf[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  };
  while (pos < buf.length) {
    const tag = Number(readVarint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      fields[field] = readVarint();
    } else if (wire === 2) {
      const len = Number(readVarint());
      fields[field] = buf.subarray(pos, pos + len);
      pos += len;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  return fields;
}

test('encodeVarint follows the protobuf wire format', () => {
  assert.deepEqual([...encodeVarint(1)], [1]);
  assert.deepEqual([...encodeVarint(300)], [0xac, 0x02]);
  assert.deepEqual([...encodeVarint(-5)], [0]);
});

test('a dock command is a LubaMsg carrying a NavTaskCtrl', () => {
  const before = BigInt(Date.now());
  const content = buildTaskControlContent('dock', { userAccount: '123456' }, { name: 'Luba 2' });
  const msg = decode(Buffer.from(content, 'base64'));
  assert.equal(msg[1], 240n); // MSG_CMD_TYPE_NAV
  assert.equal(msg[2], 7n); // DEV_MOBILEAPP
  assert.equal(msg[3], 1n); // DEV_MAINCTL
  assert.equal(msg[4], 1n); // MSG_ATTR_REQ
  assert.equal(msg[7], 123456n); // user account
  assert.ok(msg[15] >= before);

  const nav = decode(msg[11]);
  const taskCtrl = decode(nav[37]);
  assert.equal(taskCtrl[1], 1n);
  assert.equal(taskCtrl[2], BigInt(MOWER_ACTIONS.dock));
  assert.equal(taskCtrl[3], 0n);
});

test('sequence numbers change between two commands', () => {
  const a = decode(
    Buffer.from(buildTaskControlContent('start', { userAccount: '1' }, {}), 'base64'),
  );
  const b = decode(
    Buffer.from(buildTaskControlContent('pause', { userAccount: '1' }, {}), 'base64'),
  );
  assert.notEqual(a[5], b[5]);
});

test('every mower but the Luba 1 takes navigation commands on its navigation board', () => {
  assert.equal(receiverFor({ deviceName: 'Luba-VPMBS8RA', productKey: '' }), 17);
  assert.equal(receiverFor({ deviceName: 'Luba-VSLKJX' }), 17);
  assert.equal(receiverFor({ deviceName: 'Yuka-MN6ABCDE' }), 17);
  assert.equal(receiverFor({ productKey: 'a1mb8v6tnAa' }), 17);
  assert.equal(receiverFor({ productKey: 'a1iMygIwxFC' }), 17);
  // Luba 1 (by product key) and unknown devices: main controller.
  assert.equal(receiverFor({ productKey: 'a1UBFdq6nNz', deviceName: 'Luba-ABCDEF' }), 1);
  assert.equal(receiverFor({}), 1);
});

test('a Luba 2 dock command goes to the navigation board', () => {
  const content = buildTaskControlContent(
    'dock',
    { userAccount: '1' },
    { deviceName: 'Luba-VPMBS8RA' },
  );
  assert.equal(decode(Buffer.from(content, 'base64'))[3], 17n);
});

test('a report request is an EMBED_SYS LubaMsg carrying a report_info_cfg', () => {
  const msg = decode(Buffer.from(buildReportRequestContent({ userAccount: '42' }), 'base64'));
  assert.equal(msg[1], 244n); // MSG_CMD_TYPE_EMBED_SYS
  assert.equal(msg[3], 1n); // DEV_MAINCTL
  assert.equal(msg[7], 42n);
  const cfg = decode(decode(msg[10])[38]);
  assert.equal(cfg[1], 0n); // RPT_START
  assert.equal(cfg[5], 1n); // count
  assert.deepEqual([...cfg[6]], [0, 1, 2, 3, 4, 6]); // packed channels, with maintenance
});

test('a sync is an ESP LubaMsg carrying DevNet.todev_ble_sync = 3', () => {
  const msg = decode(Buffer.from(buildSyncContent({ userAccount: '42' }), 'base64'));
  assert.equal(msg[1], 248n); // MSG_CMD_TYPE_ESP
  assert.equal(msg[2], 7n); // DEV_MOBILEAPP
  assert.equal(msg[3], 0n); // DEV_COMM_ESP
  assert.equal(msg[7], 42n);
  assert.equal(decode(msg[8])[1], 3n);
});

test('an unknown command is refused', () => {
  assert.throws(() => buildTaskControlContent('fly', { userAccount: '1' }, {}), /Unknown/);
});

const navOf = (content) => {
  const msg = decodeMessage(Buffer.from(content, 'base64'));
  return decodeMessage(msg[11][0]);
};
const session = { userAccount: '1' };
const luba2 = { iotId: 'iot-2', deviceName: 'Luba-VPMBS8RA' };

test('the zone list request names the mower', () => {
  const nameMsg = decodeMessage(navOf(buildZoneListRequestContent(session, luba2))[58][0]);
  assert.equal(nameMsg[5][0].toString(), 'iot-2');
  assert.equal(nameMsg[1], undefined); // rw 0: read
});

test('a route covers the given zones with the settings of the configuration', () => {
  const content = buildRouteContent(session, luba2, {
    zones: [11n, 2n ** 64n - 1n],
    settings: normalizeConfig(),
  });
  const route = decodeMessage(navOf(content)[34][0]);
  assert.equal(route[1][0], 1n); // pver
  assert.equal(route[4][0], 4n); // jobMode
  assert.equal(route[5], undefined); // subCmd 0: plan
  assert.equal(route[6][0], 0n); // no perimeter lap
  assert.equal(route[7][0], 60n); // blade height
  assert.equal(route[8][0], 32n); // 32 cm between passes
  assert.equal(route[9][0], 0n); // obstacle detection off
  assert.equal(route[10][0], 0n); // zigzag
  assert.equal(route[11][0], 69n); // angle 111° of the app, counted the other way
  assert.ok(Math.abs(route[12][0].readFloatLE(0) - 0.6) < 1e-6); // speed
  assert.equal(route[13][0].readBigUInt64LE(0), 11n);
  assert.equal(route[13][0].readBigUInt64LE(8), 2n ** 64n - 1n);
  // zigzag first, 0 lap around the no-go zones, start at 0 %, Luba 2+ bytes
  assert.deepEqual([...route[15][0]], [1, 0, 0, 0, 0, 8, 10, 0]);
  assert.equal(route[17][0], 0n); // angle type: optimal
  assert.equal(route[18][0], 0n); // no included angle off a chessboard
  assert.equal(route[20][0], 1n);
  assert.equal(route[21][0].length, 32);
});

test('the route follows the chosen settings', () => {
  const settings = normalizeConfig({
    blade_height: '45',
    mowing_speed: '0,4',
    line_spacing: 25,
    mowing_angle: 30,
    mowing_pattern: 'chessboard',
    border_laps: 2,
    obstacle_laps: 1,
    obstacle_detection: 'less',
    mowing_order: 'border_first',
  });
  const route = decodeMessage(
    navOf(buildRouteContent(session, luba2, { zones: [1n], settings }))[34][0],
  );
  assert.equal(route[6][0], 2n);
  assert.equal(route[7][0], 45n);
  assert.equal(route[8][0], 25n);
  assert.equal(route[9][0], 2n);
  assert.equal(route[10][0], 1n);
  assert.equal(route[11][0], 150n); // 30° of the app
  assert.ok(Math.abs(route[12][0].readFloatLE(0) - 0.4) < 1e-6);
  assert.deepEqual([...route[15][0]].slice(0, 2), [0, 1]);
  assert.equal(route[18][0], 90n); // chessboard: passes at 90°
});

test('the route carries the angle type, the adaptive zigzag and the start progress', () => {
  const settings = normalizeConfig({
    angle_mode: 'custom',
    mowing_angle: 45,
    mowing_pattern: 'zigzag_adaptive',
    start_progress: '35',
  });
  const route = decodeMessage(
    navOf(buildRouteContent(session, luba2, { zones: [1n], settings }))[34][0],
  );
  assert.equal(route[17][0], 1n); // custom: absolute angle
  assert.equal(route[11][0], 135n); // 45° of the app
  assert.equal(route[10][0], 2n); // segment grid
  assert.equal(route[15][0][3], 35); // start at 35 %
  const random = normalizeConfig({ angle_mode: 'random' });
  const randomRoute = decodeMessage(
    navOf(buildRouteContent(session, luba2, { zones: [1n], settings: random }))[34][0],
  );
  assert.equal(randomRoute[17][0], 2n);
});

test('a Yuka route has no blade height (-10, as the app sends)', () => {
  const content = buildRouteContent(
    session,
    { deviceName: 'Yuka-MN6ABCDE' },
    { zones: [1n], settings: normalizeConfig() },
  );
  const route = decodeMessage(navOf(content)[34][0]);
  assert.equal(BigInt.asIntN(64, route[7][0]), -10n);
});

test('the map element requests', () => {
  const all = decodeMessage(navOf(buildHashListRequestContent(session, luba2))[30][0]);
  assert.equal(all[1][0], 1n); // pver
  assert.equal(all[2], undefined); // subCmd 0: every element
  const next = decodeMessage(
    navOf(buildHashListRequestContent(session, luba2, { totalFrame: 3, currentFrame: 1 }))[30][0],
  );
  assert.deepEqual([next[2][0], next[3][0], next[4][0]], [2n, 3n, 1n]);
  const element = decodeMessage(
    navOf(buildMapElementRequestContent(session, luba2, 2n ** 63n))[32][0],
  );
  assert.equal(element[3][0], 8n); // action: synchronize
  assert.equal(element[5][0], 2n ** 63n);
});

test('nav answers: map element hashes, packed or not', () => {
  const packed = Buffer.concat([encodeVarint(7n), encodeVarint(2n ** 64n - 2n)]);
  const ack = message(
    varintField(3, 2),
    varintField(4, 1),
    bytesField(13, packed),
    varintField(13, 9n),
  );
  assert.deepEqual(parseHashList({ 31: [ack] }), {
    subCmd: 0,
    totalFrame: 2,
    currentFrame: 1,
    hashes: [7n, 2n ** 64n - 2n, 9n],
  });
  assert.equal(parseHashList({ 34: [Buffer.alloc(0)] }), null);
});

test('nav answers: one map element', () => {
  const hash = Buffer.alloc(8);
  hash.writeBigUInt64LE(2n ** 63n + 1n);
  const ack = message(
    varintField(5, 1),
    Buffer.from([0x31]), // field 6, fixed64
    hash,
    bytesField(15, bytesField(1, Buffer.from('Potager'))),
  );
  assert.deepEqual(parseMapElement({ 33: [ack] }, 2n ** 63n + 1n), {
    hash: 2n ** 63n + 1n,
    type: 1,
    name: 'Potager',
    action: 0,
    totalFrame: 1,
    currentFrame: 1,
    points: [],
  });
  assert.equal(parseMapElement({ 33: [ack] }, 5n), null);
});

test('nav answers: a frame of a map element outline', () => {
  const couple = (x, y) => bytesField(13, message(floatField(1, x), floatField(2, y)));
  const ack = message(
    varintField(4, 8),
    varintField(5, 0),
    Buffer.from([0x31]), // field 6, fixed64
    Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]),
    varintField(9, 3),
    varintField(10, 2),
    couple(1.5, -2),
    couple(3, 4.25),
  );
  const frame = parseMapElement({ 33: [ack] }, 7n);
  assert.equal(frame.totalFrame, 3);
  assert.equal(frame.currentFrame, 2);
  assert.equal(frame.action, 8);
  assert.deepEqual(frame.points, [
    { x: 1.5, y: -2 },
    { x: 3, y: 4.25 },
  ]);
  // Waiting for another frame: not this one.
  assert.equal(parseMapElement({ 33: [ack] }, 7n, 3), null);
  assert.ok(parseMapElement({ 33: [ack] }, 7n, 2));
});

test('the next frame of a map element is asked with its type and action', () => {
  const request = decodeMessage(
    navOf(
      buildMapFrameRequestContent(session, luba2, {
        hash: 2n ** 64n - 3n,
        type: 1,
        action: 8,
        totalFrame: 4,
        currentFrame: 2,
      }),
    )[32][0],
  );
  assert.equal(request[2][0], 2n); // subCmd 2: next frame
  assert.equal(request[3][0], 8n);
  assert.equal(request[4][0], 1n);
  assert.equal(request[5][0], 2n ** 64n - 3n);
  assert.equal(request[8][0], 4n);
  assert.equal(request[9][0], 2n);
});

test('the route settings of the app are read back, echoed reserved bytes included', () => {
  const nav = {
    34: [
      message(
        varintField(10, 2),
        varintField(11, 90),
        stringField(15, String.fromCharCode(11, 10, 10, 30)),
        varintField(17, 1),
      ),
    ],
  };
  const route = parseRouteSettings(nav);
  assert.equal(route.channelMode, 2);
  assert.equal(route.toward, 90);
  assert.equal(route.towardMode, 1);
  assert.deepEqual(route.reserved, [11, 10, 10, 30]);
  assert.equal(parseRouteSettings({ 33: [Buffer.alloc(0)] }), null);
});

test('the route query asks for the current route (subCmd 2)', () => {
  const route = decodeMessage(navOf(buildRouteQueryContent(session, luba2))[34][0]);
  assert.equal(route[5][0], 2n);
});

test('nav answers: zone list and route', () => {
  const zone = Buffer.concat([
    Buffer.from([0x09]),
    Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0x12, 1, 0x41]),
  ]);
  const list = Buffer.concat([Buffer.from([0x12, zone.length]), zone]);
  const nav = { 61: [list] };
  assert.deepEqual(parseZoneList(nav), [{ hash: 5n, name: 'A' }]);
  assert.equal(parseZoneList({ 34: [Buffer.alloc(0)] }), null);
  assert.deepEqual(parseRouteAnswer({ 34: [Buffer.alloc(0)] }, 0), { result: 0 });
  assert.equal(parseRouteAnswer({ 34: [Buffer.from([0x28, 2])] }, 0), null);
});
