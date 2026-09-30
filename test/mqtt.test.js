// -----------------------------------------------------------------------------
// Mammotion broker: message routing and cached telemetry (no network).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MammotionMqtt, deviceTopics, parseBrokerUrl } from '../src/mammotion/mqtt.js';

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
