import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReportRequestContent,
  buildRouteContent,
  buildRouteQueryContent,
  buildSyncContent,
  buildTaskControlContent,
  buildZoneListRequestContent,
  MOWER_ACTIONS,
  receiverFor,
} from '../src/mammotion/commands.js';
import { decodeMessage, encodeVarint } from '../src/mammotion/protobuf.js';
import { parseRouteAnswer, parseZoneList } from '../src/mammotion/report.js';

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

test('a route covers the given zones with the default settings', () => {
  const content = buildRouteContent(session, luba2, {
    zones: [11n, 2n ** 64n - 1n],
    bladeHeightMm: 55,
  });
  const route = decodeMessage(navOf(content)[34][0]);
  assert.equal(route[1][0], 1n); // pver
  assert.equal(route[4][0], 4n); // jobMode
  assert.equal(route[5], undefined); // subCmd 0: plan
  assert.equal(route[6][0], 1n); // 1 border lap
  assert.equal(route[7][0], 55n); // blade height
  assert.equal(route[8][0], 25n); // 25 cm between lines
  assert.equal(route[9][0], 2n); // obstacle detection
  assert.ok(Math.abs(route[12][0].readFloatLE(0) - 0.3) < 1e-6); // speed
  assert.equal(route[13][0].readBigUInt64LE(0), 11n);
  assert.equal(route[13][0].readBigUInt64LE(8), 2n ** 64n - 1n);
  assert.deepEqual([...route[15][0]], [0, 1, 0, 0, 0, 8, 10, 0]); // reserved (Luba 2+)
  assert.equal(route[20][0], 1n);
  assert.equal(route[21][0].length, 32);
});

test('a Yuka route has no blade height (-10, as the app sends)', () => {
  const content = buildRouteContent(
    session,
    { deviceName: 'Yuka-MN6ABCDE' },
    {
      zones: [1n],
      bladeHeightMm: 60,
    },
  );
  const route = decodeMessage(navOf(content)[34][0]);
  assert.equal(BigInt.asIntN(64, route[7][0]), -10n);
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
