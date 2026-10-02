// -----------------------------------------------------------------------------
// Mammotion broker: message routing and cached telemetry (no network).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MammotionMqtt, deviceTopics, parseBrokerUrl } from '../src/mammotion/mqtt.js';
import { bytesField, message, varintField } from '../src/mammotion/protobuf.js';

// LubaMsg { sys { toapp_report_data { dev { sys_status, battery_val }, work { knife_height } } } }
function reportContent({ workMode, battery, height }) {
  const dev = message(varintField(1, workMode), varintField(2, 1), varintField(3, battery));
  const work = message(varintField(20, height));
  const report = message(bytesField(2, dev), bytesField(5, work));
  const sys = message(bytesField(39, report));
  return message(varintField(1, 244), bytesField(10, sys), varintField(15, 1n)).toString('base64');
}

function followed(onUpdate) {
  const mqtt = new MammotionMqtt(async () => ({}), onUpdate);
  mqtt.devices.set('Luba-VP', { iotId: 'iot-2', productKey: 'pk' });
  return mqtt;
}

const post = (params) =>
  Buffer.from(JSON.stringify({ method: 'thing.event.property.post', params }));

test('parseBrokerUrl', () => {
  assert.deepEqual(parseBrokerUrl('mqtts://b.example:8883'), {
    protocol: 'mqtts',
    host: 'b.example',
    port: 8883,
  });
  assert.deepEqual(parseBrokerUrl('b.example'), {
    protocol: 'mqtt',
    host: 'b.example',
    port: 1883,
  });
});

test('deviceTopics falls back to a wildcard product key', () => {
  assert.equal(deviceTopics('', 'dn')[0], '/sys/+/dn/thing/event/+/post');
  assert.equal(deviceTopics('pk', 'dn')[2], '/sys/pk/dn/app/down/thing/status');
});

test('property posts are merged into one status', () => {
  const updates = [];
  const mqtt = followed((iotId) => updates.push(iotId));
  assert.equal(mqtt.getStatus('iot-2'), null);

  mqtt.handleMessage(
    '/sys/pk/Luba-VP/thing/event/property/post',
    post({
      batteryPercentage: 31,
      deviceState: 13,
      knifeHeight: 60,
      iotState: 1,
      networkInfo: JSON.stringify({ wt_sec: 683720, mileage: '155528' }),
    }),
  );
  mqtt.handleMessage('/sys/pk/Luba-VP/thing/event/property/post', post({ batteryPercentage: 30 }));

  const status = mqtt.getStatus('iot-2');
  assert.equal(status.battery, 30);
  assert.equal(status.workMode, 13);
  assert.equal(status.bladeHeightMm, 60);
  assert.equal(status.totalWorkHours, 189.9);
  assert.equal(status.totalDistanceKm, 155.5);
  assert.equal(status.online, true);
  assert.deepEqual(updates, ['iot-2', 'iot-2']);
});

test('status messages set the connectivity, unknown devices are ignored', () => {
  const mqtt = followed();
  mqtt.handleMessage(
    '/sys/pk/Luba-VP/app/down/thing/status',
    Buffer.from(JSON.stringify({ action: 'offline', iotId: 'iot-2' })),
  );
  assert.equal(mqtt.getStatus('iot-2').online, false);
  mqtt.handleMessage('/sys/pk/Other/thing/event/property/post', post({ batteryPercentage: 5 }));
  assert.equal(mqtt.cache.size, 1);
  mqtt.handleMessage('/sys/proto/pk/Luba-VP/thing/event/x/post', Buffer.from('{}'));
  mqtt.handleMessage('/sys/pk/Luba-VP/thing/event/property/post', Buffer.from('not json'));
});

test('protobuf reports carry the charge state, job progress and maintenance', () => {
  const mqtt = followed();
  const dev = message(varintField(1, 13), varintField(3, 64)); // charge_state 0: omitted
  const work = message(
    varintField(3, (38 << 16) | 120), // remaining 38 min of 120
    varintField(4, (45 << 16) | 300), // 45 %, 300 m2
    varintField(20, 55),
  );
  const maintain = message(varintField(1, 155528), varintField(2, 683720));
  const report = message(bytesField(2, dev), bytesField(5, work), bytesField(7, maintain));
  const content = message(varintField(1, 244), bytesField(10, message(bytesField(39, report))));
  mqtt.handleMessage(
    '/sys/pk/Luba-VP/thing/event/device_protobuf_msg_event/post',
    Buffer.from(JSON.stringify({ params: { content: content.toString('base64') } })),
  );
  const status = mqtt.getStatus('iot-2');
  assert.equal(status.charging, false);
  assert.equal(status.progressPercent, 45);
  assert.equal(status.remainingMinutes, 38);
  assert.equal(status.bladeHeightMm, 55);
  assert.equal(status.totalDistanceKm, 155.5);
  assert.equal(status.totalWorkHours, 189.9);
  assert.ok(mqtt.lastReportAt('iot-2') > 0);

  // A newer property post on the state drops the report's charge state.
  mqtt.handleMessage('/sys/pk/Luba-VP/thing/event/property/post', post({ deviceState: 15 }));
  assert.equal(mqtt.getStatus('iot-2').charging, undefined);
});

test('protobuf reports update the state and win over older property posts', () => {
  const updates = [];
  const mqtt = followed((iotId) => updates.push(iotId));
  mqtt.handleMessage(
    '/sys/pk/Luba-VP/thing/event/property/post',
    post({ batteryPercentage: 100, deviceState: 15, knifeHeight: 50 }),
  );
  mqtt.handleMessage(
    '/sys/pk/Luba-VP/thing/event/device_protobuf_msg_event/post',
    Buffer.from(
      JSON.stringify({
        params: { content: reportContent({ workMode: 13, battery: 97, height: 60 }) },
      }),
    ),
  );
  let status = mqtt.getStatus('iot-2');
  assert.equal(status.workMode, 13);
  assert.equal(status.battery, 97);
  assert.equal(status.bladeHeightMm, 60);
  assert.equal(status.online, true);
  assert.equal(updates.length, 2);

  // A later property post is newer again.
  mqtt.handleMessage('/sys/pk/Luba-VP/thing/event/property/post', post({ batteryPercentage: 95 }));
  status = mqtt.getStatus('iot-2');
  assert.equal(status.battery, 95);
  assert.equal(status.workMode, 13);

  // Not a report: ignored.
  mqtt.handleMessage(
    '/sys/pk/Luba-VP/thing/event/device_protobuf_msg_event/post',
    Buffer.from(JSON.stringify({ params: { content: 'AAAA' } })),
  );
  assert.equal(updates.length, 3);
});
