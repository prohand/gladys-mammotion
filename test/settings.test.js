import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { buildMowerDevice, buildSettingStates } from '../src/devices/mower.js';
import {
  ALL_ZONES,
  applyConfigChanges,
  getSetting,
  loadMowerSettings,
  mowerSettings,
  rememberZones,
  resetSettings,
  setSetting,
  SETTING_KEYS,
  settingFeatureKey,
  settingKeyOf,
  settingOptions,
} from '../src/devices/settings.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const gladys = createFakeGladys();
const luba = { iotId: 'iot-luba-1', name: 'Luba 2' };
const yuka = { iotId: 'iot-yuka-1', name: 'Yuka' };
const config = normalizeConfig();

beforeEach(() => resetSettings());

const option = (key, value) => settingOptions(key, { language: 'fr', current: value });

test('every mowing setting of the configuration is a select list of the device', () => {
  const device = buildMowerDevice(gladys, luba, config);
  for (const key of SETTING_KEYS) {
    const feature = device.features.find((f) =>
      f.external_id.endsWith(`:${settingFeatureKey(key)}`),
    );
    assert.ok(feature, key);
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.TEXT);
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.TEXT.SELECT);
    assert.equal(feature.read_only, false);
    // The zone list only holds "every zone" until the map is read.
    assert.ok(feature.supported_options.length >= (key === 'mowing_zones' ? 1 : 2), key);
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
  assert.equal(settingKeyOf('mowing'), null);
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

test('the zone list offers every zone, then each zone of the map', () => {
  rememberZones(luba, ['Derrière', 'Bas']);
  const options = settingOptions('mowing_zones', {
    language: 'fr',
    current: ALL_ZONES,
    zones: ['Derrière', 'Bas'],
  });
  assert.deepEqual(options, [
    { value: '*', label: 'Toutes les zones' },
    { value: 'Derrière', label: 'Derrière' },
    { value: 'Bas', label: 'Bas' },
  ]);
  // Zones typed in the configuration stay selectable.
  const typed = settingOptions('mowing_zones', { language: 'fr', current: 'Bas, Devant' });
  assert.equal(typed.at(-1).value, 'Bas, Devant');
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
  assert.equal(states.length, SETTING_KEYS.length);
  assert.deepEqual(
    states.find((s) => s.device_feature_external_id.endsWith(':setting-mowing-zones')),
    { device_feature_external_id: 'mower:iot-luba-1:setting-mowing-zones', text: '*' },
  );
});

test('rememberZones tells when the zone list changed', () => {
  assert.equal(rememberZones(luba, ['A', 'B']), true);
  assert.equal(rememberZones(luba, ['A', 'B']), false);
  assert.equal(rememberZones(luba, ['A']), true);
});
