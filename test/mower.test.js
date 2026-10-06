import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import {
  FEATURE,
  buildMapDevice,
  buildMowerDevice,
  buildMowerStates,
  commandFor,
} from '../src/devices/mower.js';
import {
  buildDiscoveredDevices,
  findMowerByDevice,
  findMowerByMap,
  findMowerFeature,
  lastKnownWorkMode,
  rememberWorkMode,
  setMowers,
} from '../src/devices/index.js';
import { WORK_MODES } from '../src/mammotion/telemetry.js';
import { normalizeConfig } from '../src/config.js';
import { rememberZones } from '../src/devices/settings.js';
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

test('the mower device uses a poll_frequency accepted by Gladys (ms)', () => {
  const device = buildMowerDevice(gladys, luba, config);
  assert.equal(device.poll_frequency, 60_000);
  assert.equal(
    buildMowerDevice(gladys, luba, normalizeConfig({ poll_frequency: 30 })).poll_frequency,
    30_000,
  );
  assert.equal(device.name, 'Luba 2');
  assert.equal(device.external_id, 'mower:iot-luba-1');
});

test('only the switches, the refresh button and the settings are controllable', () => {
  rememberZones(luba, ['Devant', 'Côté Sud']);
  const device = buildMowerDevice(gladys, luba, config);
  const writable = device.features
    .filter((f) => !f.read_only && f.type !== DEVICE_FEATURE_TYPES.TEXT.SELECT)
    .map((f) => f.external_id);
  assert.deepEqual(writable.sort(), [
    'mower:iot-luba-1:dock',
    'mower:iot-luba-1:mowing',
    'mower:iot-luba-1:refresh',
    'mower:iot-luba-1:setting-mowing-angle',
    'mower:iot-luba-1:setting-start-progress',
    'mower:iot-luba-1:zone-cote-sud',
    'mower:iot-luba-1:zone-devant',
  ]);
  assert.equal(feature(device, 'zone-cote-sud').name, 'Zone à tondre – Côté Sud');
  // The map is not on the mower device (see the map device test).
  assert.equal(feature(device, FEATURE.MAP), undefined);
  for (const key of [FEATURE.MOWING, FEATURE.DOCK]) {
    assert.equal(feature(device, key).category, DEVICE_FEATURE_CATEGORIES.SWITCH);
    assert.equal(feature(device, key).type, DEVICE_FEATURE_TYPES.SWITCH.BINARY);
  }
  // A push button on the dashboard.
  assert.equal(feature(device, FEATURE.REFRESH).category, DEVICE_FEATURE_CATEGORIES.BUTTON);
  assert.equal(feature(device, FEATURE.REFRESH).type, DEVICE_FEATURE_TYPES.BUTTON.PUSH);
});

test('the map is a device of its own, with the camera image as its only feature', () => {
  // The Camera widget takes every state of its device for the image.
  const device = buildMapDevice(gladys, luba, config);
  assert.equal(device.external_id, 'mower-map:iot-luba-1');
  assert.equal(device.name, 'Luba 2 – Carte');
  assert.equal(device.poll_frequency, undefined);
  assert.equal(device.features.length, 1);
  assert.equal(device.features[0].external_id, 'mower-map:iot-luba-1:map');
  assert.equal(device.features[0].category, DEVICE_FEATURE_CATEGORIES.CAMERA);
  assert.equal(device.features[0].type, DEVICE_FEATURE_TYPES.CAMERA.IMAGE);
});

test('only the battery level is in the battery category (Gladys low-battery alert)', () => {
  // Gladys warns for every feature of the battery category under the threshold,
  // whatever its type: a charging binary at 0 would be read as "0%".
  const device = buildMowerDevice(gladys, luba, config);
  const battery = device.features.filter((f) => f.category === DEVICE_FEATURE_CATEGORIES.BATTERY);
  assert.deepEqual(
    battery.map((f) => f.external_id),
    ['mower:iot-luba-1:battery'],
  );
  assert.equal(battery[0].type, DEVICE_FEATURE_TYPES.BATTERY.INTEGER);
  const charging = feature(device, FEATURE.CHARGING);
  assert.equal(charging.external_id, 'mower:iot-luba-1:charging-state');
  assert.equal(charging.category, DEVICE_FEATURE_CATEGORIES.INPUT);
  assert.equal(charging.type, DEVICE_FEATURE_TYPES.INPUT.BINARY);
  assert.equal(charging.read_only, true);
});

test('feature external_ids are unique', () => {
  const device = buildMowerDevice(gladys, luba, config);
  const ids = device.features.map((f) => f.external_id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every feature has min and max (Gladys refuses the device otherwise)', () => {
  const device = buildMowerDevice(gladys, luba, config);
  for (const f of device.features) {
    assert.equal(typeof f.min, 'number', `${f.external_id} has no min`);
    assert.equal(typeof f.max, 'number', `${f.external_id} has no max`);
  }
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
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s.text ?? s.state]),
  );
  assert.equal(byKey.mowing, 1);
  assert.equal(byKey.dock, 0);
  assert.equal(byKey['charging-state'], 0);
  assert.equal(byKey.battery, 81);
  assert.equal(byKey['blade-height'], 55);
  assert.equal(byKey['work-time'], 12.5);
  assert.equal(byKey.distance, 3.2);
  assert.equal(byKey.status, 'En tonte');
});

test('a charging mower is docked and charging', () => {
  const states = buildMowerStates(
    gladys,
    luba,
    { battery: 40, workMode: WORK_MODES.CHARGING, online: true },
    normalizeConfig({ language: 'en' }),
  );
  const byKey = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s.text ?? s.state]),
  );
  assert.equal(byKey.mowing, 0);
  assert.equal(byKey.dock, 1);
  assert.equal(byKey['charging-state'], 1);
  assert.equal(byKey.status, 'Charging');
});

test('a report shows the job progress, remaining time and charge state', () => {
  const states = buildMowerStates(
    gladys,
    luba,
    {
      workMode: WORK_MODES.WORKING,
      online: true,
      charging: false,
      progressPercent: 45,
      remainingMinutes: 38,
      totalMinutes: 120,
      jobAreaM2: 300,
    },
    config,
  );
  const byKey = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').pop(), s.text ?? s.state]),
  );
  assert.equal(byKey.status, 'En tonte (45 %)');
  assert.equal(byKey['remaining-time'], 38);
  assert.equal(byKey.progress, 45);
  assert.equal(byKey['elapsed-time'], 82);
  assert.equal(byKey['job-area'], 300);
  assert.equal(byKey['charging-state'], 0);

  // Full on the dock: the work mode says READY, charge_state says docked.
  const docked = buildMowerStates(
    gladys,
    luba,
    { workMode: WORK_MODES.READY, online: true, charging: true },
    config,
  );
  assert.ok(
    docked.some((s) => s.device_feature_external_id.endsWith(':charging-state') && s.state === 1),
  );

  // Out of a job, the time left of the last job means nothing: 0.
  const ready = buildMowerStates(
    gladys,
    luba,
    {
      workMode: WORK_MODES.READY,
      online: true,
      remainingMinutes: 382,
      progressPercent: 100,
      totalMinutes: 400,
      jobAreaM2: 300,
    },
    config,
  );
  const readyKey = Object.fromEntries(
    ready.map((s) => [s.device_feature_external_id.split(':').pop(), s.state]),
  );
  assert.equal(readyKey['remaining-time'], 0);
  assert.equal(readyKey.progress, 0);
  assert.equal(readyKey['elapsed-time'], 0);
  // The area of the last job stays.
  assert.equal(readyKey['job-area'], 300);
});

test('an offline mower shows "Hors ligne" and unknown values are skipped', () => {
  const states = buildMowerStates(
    gladys,
    luba,
    { battery: null, workMode: null, online: false },
    config,
  );
  assert.deepEqual(states, [
    { device_feature_external_id: 'mower:iot-luba-1:status', text: 'Hors ligne' },
  ]);
});

test('commandFor maps the switches to mower commands', () => {
  assert.equal(commandFor(FEATURE.MOWING, 1, WORK_MODES.PAUSE), 'resume');
  assert.equal(commandFor(FEATURE.MOWING, 1, WORK_MODES.CHARGING_PAUSE), 'resume');
  assert.equal(commandFor(FEATURE.MOWING, 1, WORK_MODES.WORKING), null);
  // A ready mower starts a new job (route planned first): never a bare "start".
  assert.equal(commandFor(FEATURE.MOWING, 1, WORK_MODES.READY), 'startJob');
  assert.equal(commandFor(FEATURE.MOWING, 1, WORK_MODES.INITIALIZATION), 'startJob');
  assert.throws(() => commandFor(FEATURE.MOWING, 1, WORK_MODES.RETURNING), /Returning/);
  assert.throws(() => commandFor(FEATURE.MOWING, 1, null), /unknown/);
  assert.equal(commandFor(FEATURE.MOWING, 0, WORK_MODES.WORKING), 'pause');
  assert.equal(commandFor(FEATURE.MOWING, 0, null), 'pause');
  assert.equal(commandFor(FEATURE.MOWING, 0, WORK_MODES.CHARGING), null);
  // A job, mowing or paused, is ended before going home, or it stays paused
  // in the app.
  assert.equal(commandFor(FEATURE.DOCK, 1, WORK_MODES.WORKING), 'stopAndDock');
  assert.equal(commandFor(FEATURE.DOCK, 1, WORK_MODES.MANUAL_MOWING), 'stopAndDock');
  assert.equal(commandFor(FEATURE.DOCK, 1, WORK_MODES.PAUSE), 'stopAndDock');
  assert.equal(commandFor(FEATURE.DOCK, 1, WORK_MODES.READY), 'dock');
  // Already home with the job paused: only the job is ended.
  assert.equal(commandFor(FEATURE.DOCK, 1, WORK_MODES.CHARGING_PAUSE), 'stop');
  assert.equal(commandFor(FEATURE.DOCK, 0, WORK_MODES.RETURNING), 'cancelDock');
  assert.equal(commandFor(FEATURE.REFRESH, 1, null), 'refresh');
  assert.throws(() => commandFor(FEATURE.BATTERY, 1, null));
});

test('the registry routes devices and features back to their mower', () => {
  setMowers([luba, yuka]);
  const devices = buildDiscoveredDevices(gladys, config);
  // A mower and its map each.
  assert.equal(devices.length, 4);
  assert.equal(findMowerByDevice(gladys, { external_id: 'mower:iot-yuka-1' }), yuka);
  assert.equal(findMowerByDevice(gladys, { external_id: 'mower-map:iot-yuka-1' }), undefined);
  assert.equal(findMowerByMap(gladys, { external_id: 'mower-map:iot-yuka-1' }), yuka);
  assert.equal(findMowerByMap(gladys, { external_id: 'mower:iot-yuka-1' }), undefined);
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
