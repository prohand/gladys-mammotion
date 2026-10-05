import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { buildMowerDevice, buildSettingStates } from '../src/devices/mower.js';
import {
  ALL_ZONES,
  applyConfigChanges,
  getSetting,
  LIST_KEYS,
  listKeysFor,
  isSlider,
  loadMowerSettings,
  mowerSettings,
  rememberZones,
  resetSettings,
  setSetting,
  setZone,
  settingFeatureKey,
  settingKeyOf,
  settingOptions,
  zoneSlugOf,
  zonesFromSwitches,
} from '../src/devices/settings.js';
import { modelLimits } from '../src/mammotion/models.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const gladys = createFakeGladys();
const luba = { iotId: 'iot-luba-1', name: 'Luba 2' };
const yuka = { iotId: 'iot-yuka-1', name: 'Yuka' };
// Chris75's mower on the forum: a Luba 2 AWD X.
const luba2x = { iotId: 'iot-luba-2x', name: 'Luba 2 X', deviceName: 'Luba-VPMBS8RA' };
const config = normalizeConfig();

beforeEach(() => resetSettings());

const option = (key, value) => settingOptions(key, { language: 'fr', current: value });

test('every mowing setting but the zones, the angle and the start progress is a select list of the device', () => {
  const device = buildMowerDevice(gladys, luba, config);
  assert.ok(!device.features.some((f) => f.external_id.endsWith(':setting-mowing-zones')));
  for (const key of LIST_KEYS.filter((k) => !isSlider(k))) {
    const feature = device.features.find((f) =>
      f.external_id.endsWith(`:${settingFeatureKey(key)}`),
    );
    assert.ok(feature, key);
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.TEXT);
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.TEXT.SELECT);
    assert.equal(feature.read_only, false);
    assert.ok(feature.supported_options.length >= 2, key);
    // Gladys refuses empty or duplicate values.
    const values = feature.supported_options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length, key);
    assert.ok(
      values.every((v) => typeof v === 'string' && v.trim() !== ''),
      key,
    );
    // The selected value is always in the list.
    assert.ok(values.includes(getSetting(luba, key, config)), key);
  }
  assert.equal(settingKeyOf('setting-blade-height'), 'blade_height');
  assert.equal(settingKeyOf('setting-mowing-angle'), 'mowing_angle');
  assert.equal(settingKeyOf('setting-mowing-zones'), null);
  assert.equal(settingKeyOf('mowing'), null);
});

test('the angle and the start progress are sliders, 1 by 1, without options', () => {
  const device = buildMowerDevice(gladys, luba2x, config);
  const slider = (key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
  for (const [key, max] of [
    ['setting-mowing-angle', 180],
    ['setting-start-progress', 99],
  ]) {
    const feature = slider(key);
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.SWITCH);
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.SWITCH.DIMMER);
    assert.deepEqual([feature.min, feature.max, feature.step], [0, max, 1]);
    // An empty list removes the options of the lists of 1.1.0.
    assert.deepEqual(feature.supported_options, []);
  }
  // Gladys takes 100 KB when the device page saves the device, map image included.
  const options = device.features.flatMap((f) => f.supported_options ?? []);
  assert.ok(options.length < 100, `${options.length} options`);
  loadMowerSettings(luba2x, config, () => undefined);
  setSetting(luba2x, 'mowing_angle', 45);
  assert.throws(() => setSetting(luba2x, 'mowing_angle', '45.5'), /Invalid/);
  const states = buildSettingStates(gladys, luba2x, config);
  const angle = states.find((s) => s.device_feature_external_id.endsWith(':setting-mowing-angle'));
  assert.equal(angle.state, 45);
});

test('the lists are labeled from the manifest, in the chosen language', () => {
  const fr = buildMowerDevice(gladys, luba, config);
  const en = buildMowerDevice(gladys, luba, normalizeConfig({ language: 'en' }));
  const name = (device) =>
    device.features.find((f) => f.external_id.endsWith(':setting-blade-height')).name;
  assert.equal(name(fr), 'Réglage – Hauteur de coupe (mm)');
  assert.equal(name(en), 'Setting – Blade height (mm)');
  assert.deepEqual(option('mowing_speed', '0.6')[4], { value: '0.6', label: '0,6 m/s' });
  assert.deepEqual(option('obstacle_detection', 'off')[0], { value: 'off', label: 'Désactivé' });
});

test('numeric lists cover the bounds, with exact steps, and keep a value typed in the configuration', () => {
  const speeds = option('mowing_speed', '0.6').map((o) => o.value);
  assert.deepEqual(speeds, [
    '0.2',
    '0.3',
    '0.4',
    '0.5',
    '0.6',
    '0.7',
    '0.8',
    '0.9',
    '1',
    '1.1',
    '1.2',
  ]);
  const heights = option('blade_height', '62').map((o) => o.value);
  assert.equal(heights[0], '15');
  assert.equal(heights.at(-1), '100');
  assert.ok(heights.includes('62'));
  assert.ok(heights.indexOf('62') > heights.indexOf('60'));
});

test('the lists follow the range of the mower model (Luba 2 X)', () => {
  const values = (key) =>
    settingOptions(key, { language: 'fr', mower: luba2x }).map((o) => Number(o.value));
  const heights = values('blade_height');
  assert.equal(heights[0], 25);
  assert.equal(heights.at(-1), 70);
  assert.ok(heights.every((h) => h % 5 === 0));
  assert.deepEqual(values('mowing_speed'), [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  const spacings = values('line_spacing');
  assert.equal(spacings[0], 20);
  assert.equal(spacings.at(-1), 35);
  assert.equal(spacings.length, 16);
  assert.deepEqual(values('obstacle_laps'), [0, 1, 2, 3]);
  const angles = values('mowing_angle');
  assert.equal(angles.length, 181);
  assert.equal(angles.at(-1), 180);
  const progress = values('start_progress');
  assert.equal(progress.length, 100);
  assert.equal(progress.at(-1), 99);
  assert.deepEqual(
    settingOptions('mowing_pattern', { language: 'fr' }).map((o) => o.label),
    ['Trajectoire en zigzag', 'Damier', 'Zigzag adaptatif'],
  );
  assert.deepEqual(
    settingOptions('angle_mode', { language: 'fr' }).map((o) => o.label),
    ['Optimal', 'Personnaliser', 'Aléatoire'],
  );
});

test('a value out of the model range is brought within it, for the list and the job', () => {
  loadMowerSettings(luba2x, normalizeConfig({ mowing_speed: '1.2', blade_height: 15 }), () => {});
  const conf = normalizeConfig({ mowing_speed: '1.2', blade_height: 15 });
  assert.equal(getSetting(luba2x, 'mowing_speed', conf), '0.8');
  assert.equal(getSetting(luba2x, 'blade_height', conf), '25');
  const settings = mowerSettings(luba2x, conf);
  assert.equal(settings.mowing_speed, 0.8);
  assert.equal(settings.blade_height, 25);
  assert.throws(() => setSetting(luba2x, 'mowing_speed', '1.0'), /Invalid/);
});

test('model ranges: families, Yuka without height, high cut models', () => {
  assert.deepEqual(modelLimits({ deviceName: 'Luba-VSABCDEF' }).mowing_speed, [0.2, 1.2]);
  assert.deepEqual(modelLimits({ deviceName: 'Luba-MNABCDEF' }).blade_height, [20, 65]);
  assert.equal(modelLimits({ deviceName: 'Yuka-ABCDEF' }).blade_height, null);
  assert.ok(!listKeysFor({ iotId: 'y', deviceName: 'Yuka-ABCDEF' }).includes('blade_height'));
  assert.ok(listKeysFor(luba2x).includes('blade_height'));
  // A Luba 2 reporting 85 mm is a high cut ("H") model.
  assert.deepEqual(
    modelLimits({ deviceName: 'Luba-VPMBS8RA', bladeHeightMm: 85 }).blade_height,
    [55, 100],
  );
  // Unknown name: the bounds of the configuration.
  assert.deepEqual(modelLimits({}).blade_height, [15, 100]);
});

test('the zone switches pick the zones of the next job; none means every zone', () => {
  loadMowerSettings(luba, config, () => undefined);
  rememberZones(luba, ['Devant', 'Côté Sud', 'Bas']);
  assert.equal(setZone(luba, 'cote-sud', true, config), 'cote-sud');
  assert.equal(setZone(luba, 'devant', true, config), 'cote-sud,devant');
  assert.equal(mowerSettings(luba, config).mowing_zones, 'cote-sud,devant');
  const states = Object.fromEntries(
    buildSettingStates(gladys, luba, config)
      .filter((s) => s.state !== undefined)
      .map((s) => [s.device_feature_external_id.split(':').pop(), s.state])
      .filter(([key]) => key.startsWith('zone-')),
  );
  assert.deepEqual(states, { 'zone-devant': 1, 'zone-cote-sud': 1, 'zone-bas': 0 });
  setZone(luba, 'cote-sud', false, config);
  assert.equal(setZone(luba, 'devant', false, config), ALL_ZONES);
  assert.equal(mowerSettings(luba, config).mowing_zones, '');
  assert.equal(zoneSlugOf('zone-cote-sud'), 'cote-sud');
  assert.equal(zoneSlugOf('setting-blade-height'), null);
});

test('the zones are read back from the switches Gladys keeps', () => {
  assert.equal(zonesFromSwitches([{ key: 'mowing', value: 1 }]), undefined);
  assert.equal(
    zonesFromSwitches([
      { key: 'zone-devant', value: 1 },
      { key: 'zone-bas', value: 0 },
      { key: 'zone-cote-sud', value: 1 },
    ]),
    'devant,cote-sud',
  );
  assert.equal(zonesFromSwitches([{ key: 'zone-bas', value: 0 }]), ALL_ZONES);
  // In the order they were switched ON.
  assert.equal(
    zonesFromSwitches([
      { key: 'zone-devant', value: 1, changed: '2026-10-05T14:02:00.000Z' },
      { key: 'zone-bas', value: 1, changed: '2026-10-05T14:00:00.000Z' },
      { key: 'zone-cote-sud', value: 1, changed: '2026-10-05T14:01:00.000Z' },
    ]),
    'bas,cote-sud,devant',
  );
});

test('a value picked on the device is used by the next job of that mower only', () => {
  loadMowerSettings(luba, config, () => undefined);
  loadMowerSettings(yuka, config, () => undefined);
  setSetting(luba, 'blade_height', '45');
  setSetting(luba, 'mowing_speed', '0.4');
  setSetting(luba, 'mowing_zones', 'Derrière');
  setSetting(luba, 'mowing_pattern', 'chessboard');
  const settings = mowerSettings(luba, config);
  assert.equal(settings.blade_height, 45);
  assert.equal(settings.mowing_speed, 0.4);
  assert.equal(settings.mowing_zones, 'Derrière');
  assert.equal(settings.mowing_pattern, 'chessboard');
  assert.equal(mowerSettings(yuka, config).blade_height, DEFAULT_CONFIG.blade_height);
  setSetting(luba, 'mowing_zones', ALL_ZONES);
  assert.equal(mowerSettings(luba, config).mowing_zones, '');
});

test('a value outside the list is refused', () => {
  assert.throws(() => setSetting(luba, 'blade_height', '500'), /Invalid/);
  assert.throws(() => setSetting(luba, 'mowing_pattern', 'spiral'), /Invalid/);
  assert.throws(() => setSetting(luba, 'mowing_zones', ''), /Invalid/);
});

test('the value Gladys kept is read back at startup, else the configuration', () => {
  loadMowerSettings(luba, config, (key) => ({ blade_height: '40', mowing_order: 'bogus' })[key]);
  assert.equal(getSetting(luba, 'blade_height', config), '40');
  assert.equal(getSetting(luba, 'mowing_order', config), 'zigzag_first');
  // Already known: a later load does not overwrite the user choice.
  setSetting(luba, 'blade_height', '50');
  loadMowerSettings(luba, config, () => '30');
  assert.equal(getSetting(luba, 'blade_height', config), '50');
});

test('a new value saved in the configuration applies to every mower', () => {
  loadMowerSettings(luba, config, () => undefined);
  loadMowerSettings(yuka, config, () => undefined);
  setSetting(luba, 'blade_height', '45');
  setSetting(luba, 'line_spacing', '20');
  const next = normalizeConfig({ blade_height: 70 });
  assert.deepEqual(applyConfigChanges(config, next), ['blade_height']);
  assert.equal(getSetting(luba, 'blade_height', next), '70');
  assert.equal(getSetting(yuka, 'blade_height', next), '70');
  // Untouched in the configuration: the device choice stays.
  assert.equal(getSetting(luba, 'line_spacing', next), '20');
});

test('the setting states carry the selected value as text', () => {
  loadMowerSettings(luba, config, () => undefined);
  const states = buildSettingStates(gladys, luba, config);
  assert.equal(states.length, LIST_KEYS.length);
  assert.deepEqual(
    states.find((s) => s.device_feature_external_id.endsWith(':setting-angle-mode')),
    { device_feature_external_id: 'mower:iot-luba-1:setting-angle-mode', text: 'optimal' },
  );
});

test('rememberZones tells when the zone list changed', () => {
  assert.equal(rememberZones(luba, ['A', 'B']), true);
  assert.equal(rememberZones(luba, ['A', 'B']), false);
  assert.equal(rememberZones(luba, ['A']), true);
});
