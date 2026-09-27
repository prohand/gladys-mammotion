import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { FEATURE, buildMowerDevice, buildMowerStates, commandFor } from '../src/devices/mower.js';
import {
  buildDiscoveredDevices,
  findMowerByDevice,
  findMowerFeature,
  lastKnownWorkMode,
  rememberWorkMode,
  setMowers,
} from '../src/devices/index.js';
import { WORK_MODES } from '../src/mammotion/telemetry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const gladys = createFakeGladys();
const config = normalizeConfig({ poll_frequency: 90 });
const luba = {
  iotId: 'iot-luba-1',
  name: 'Luba 2',
  productKey: 'a1iMygIwxFC',
  deviceName: 'Luba-VS1',
};
const yuka = { iotId: 'iot-yuka-1', name: 'Yuka', productKey: 'a1kT0TlYEza', deviceName: 'Yuka-1' };

const feature = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

test('the mower device carries the poll_frequency from the config', () => {
  const device = buildMowerDevice(gladys, luba, config);
  assert.equal(device.poll_frequency, 90);
  assert.equal(device.name, 'Luba 2');
  assert.equal(device.external_id, 'mower:iot-luba-1');
});

test('only the mowing and dock switches are controllable', () => {
  const device = buildMowerDevice(gladys, luba, config);
  const writable = device.features.filter((f) => !f.read_only).map((f) => f.external_id);
  assert.deepEqual(writable.sort(), ['mower:iot-luba-1:dock', 'mower:iot-luba-1:mowing']);
  for (const key of [FEATURE.MOWING, FEATURE.DOCK]) {
    assert.equal(feature(device, key).category, DEVICE_FEATURE_CATEGORIES.SWITCH);
    assert.equal(feature(device, key).type, DEVICE_FEATURE_TYPES.SWITCH.BINARY);
  }
});

test('feature external_ids are unique', () => {
  const device = buildMowerDevice(gladys, luba, config);
  const ids = device.features.map((f) => f.external_id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a mowing snapshot turns the mowing switch ON', () => {
  const states = buildMowerStates(
    gladys,
    luba,
    {
      battery: 81,
      workMode: WORK_MODES.WORKING,
      online: true,
      bladeHeightMm: 55,
      totalWorkHours: 12.5,
      totalDistanceKm: 3.2,
    },
    config,
  );
  const byKey = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s.state]),
  );
  assert.equal(byKey.mowing, 1);
  assert.equal(byKey.dock, 0);
  assert.equal(byKey.charging, 0);
  assert.equal(byKey.battery, 81);
  assert.equal(byKey['blade-height'], 55);
  assert.equal(byKey['work-time'], 12.5);
  assert.equal(byKey.distance, 3.2);
  assert.deepEqual(byKey.status, { text: 'En tonte' });
});

test('a charging mower is docked and charging', () => {
  const states = buildMowerStates(
    gladys,
    luba,
    { battery: 40, workMode: WORK_MODES.CHARGING, online: true },
    normalizeConfig({ language: 'en' }),
  );
  const byKey = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s.state]),
  );
  assert.equal(byKey.mowing, 0);
  assert.equal(byKey.dock, 1);
  assert.equal(byKey.charging, 1);
  assert.deepEqual(byKey.status, { text: 'Charging' });
});

test('an offline mower shows "Hors ligne" and unknown values are skipped', () => {
  const states = buildMowerStates(
    gladys,
    luba,
    { battery: null, workMode: null, online: false },
    config,
  );
  assert.deepEqual(states, [
    { device_feature_external_id: 'mower:iot-luba-1:status', state: { text: 'Hors ligne' } },
  ]);
});

test('commandFor maps the switches to mower commands', () => {
  assert.equal(commandFor(FEATURE.MOWING, 1, WORK_MODES.CHARGING), 'start');
  assert.equal(commandFor(FEATURE.MOWING, 1, null), 'start');
  assert.equal(commandFor(FEATURE.MOWING, 1, WORK_MODES.PAUSE), 'resume');
  assert.equal(commandFor(FEATURE.MOWING, 1, WORK_MODES.CHARGING_PAUSE), 'resume');
  assert.equal(commandFor(FEATURE.MOWING, 0, WORK_MODES.WORKING), 'pause');
  assert.equal(commandFor(FEATURE.DOCK, 1, WORK_MODES.WORKING), 'dock');
  assert.equal(commandFor(FEATURE.DOCK, 0, WORK_MODES.RETURNING), 'cancelDock');
  assert.throws(() => commandFor(FEATURE.BATTERY, 1, null));
});

test('the registry routes devices and features back to their mower', () => {
  setMowers([luba, yuka]);
  const devices = buildDiscoveredDevices(gladys, config);
  assert.equal(devices.length, 2);
  assert.equal(findMowerByDevice(gladys, { external_id: 'mower:iot-yuka-1' }), yuka);
  assert.equal(findMowerByDevice(gladys, { external_id: 'nope' }), undefined);
  assert.deepEqual(findMowerFeature(gladys, 'mower:iot-luba-1:dock'), { mower: luba, key: 'dock' });
  assert.equal(findMowerFeature(gladys, 'mower:other:dock'), null);
});

test('the last known work mode is remembered per mower', () => {
  assert.equal(lastKnownWorkMode(yuka), null);
  rememberWorkMode(yuka, WORK_MODES.PAUSE);
  rememberWorkMode(yuka, null);
  assert.equal(lastKnownWorkMode(yuka), WORK_MODES.PAUSE);
});

test('feature names follow the configured language', () => {
  const fr = buildMowerDevice(gladys, luba, normalizeConfig());
  const en = buildMowerDevice(gladys, luba, normalizeConfig({ language: 'en' }));
  assert.equal(feature(fr, FEATURE.MOWING).name, 'Tonte');
  assert.equal(feature(en, FEATURE.MOWING).name, 'Mowing');
  assert.equal(feature(fr, FEATURE.DOCK).name, 'Retour à la base');
});
