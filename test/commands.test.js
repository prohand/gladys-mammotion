import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskControlContent, MOWER_ACTIONS, receiverFor } from '../src/mammotion/commands.js';
import { encodeVarint } from '../src/mammotion/protobuf.js';

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

test('Luba Pro sends navigation commands to its navigation board', () => {
  assert.equal(receiverFor({ productKey: 'a1mb8v6tnAa' }), 17);
  assert.equal(receiverFor({ name: 'Luba Pro 5000' }), 17);
  assert.equal(receiverFor({ productKey: 'a1iMygIwxFC', name: 'Luba 2' }), 1);
});

test('an unknown command is refused', () => {
  assert.throws(() => buildTaskControlContent('fly', { userAccount: '1' }, {}), /Unknown/);
});
