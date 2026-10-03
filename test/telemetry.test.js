import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK_MODES,
  isCharging,
  isDocking,
  isMowing,
  isPaused,
  parseProperties,
  workModeLabel,
} from '../src/mammotion/telemetry.js';

test('parseProperties reads the Aliyun "items.x.value" envelope', () => {
  const status = parseProperties({
    items: {
      batteryPercentage: { value: 76, time: 1 },
      deviceState: { value: 13 },
      iotState: { value: 1 },
      knifeHeight: { value: '60' },
      deviceVersion: { value: '1.2.3' },
      networkInfo: { value: JSON.stringify({ wt_sec: 36000, mileage: 12345, wifi_rssi: -60 }) },
    },
  });
  assert.deepEqual(status, {
    battery: 76,
    workMode: 13,
    online: true,
    bladeHeightMm: 60,
    totalWorkHours: 10,
    totalDistanceKm: 12.3,
    firmware: '1.2.3',
  });
});

test('parseProperties reads flat and data-wrapped snapshots', () => {
  const status = parseProperties({ data: { batteryPercentage: 50, deviceState: '15' } });
  assert.equal(status.battery, 50);
  assert.equal(status.workMode, 15);
  assert.equal(status.online, null);
  assert.equal(status.totalWorkHours, null);
});

test('parseProperties drops a 0 % battery (a missing value, not a measure)', () => {
  assert.equal(parseProperties({ batteryPercentage: 0 }).battery, null);
  assert.equal(parseProperties({ batteryPercentage: '0' }).battery, null);
  assert.equal(parseProperties({ batteryPercentage: 1 }).battery, 1);
});

test('parseProperties survives an empty or broken snapshot', () => {
  const status = parseProperties({ items: { networkInfo: { value: '{broken' } } });
  assert.equal(status.battery, null);
  assert.equal(status.totalDistanceKm, null);
  assert.doesNotThrow(() => parseProperties(null));
});

test('workModeLabel gives a readable label in both languages', () => {
  assert.equal(workModeLabel(WORK_MODES.WORKING, true, 'fr'), 'En tonte');
  assert.equal(workModeLabel(WORK_MODES.WORKING, true, 'en'), 'Mowing');
  assert.equal(workModeLabel(WORK_MODES.WORKING, false, 'fr'), 'Hors ligne');
  assert.equal(workModeLabel(99, true, 'fr'), 'État 99');
  assert.equal(workModeLabel(null, null, 'fr'), '');
});

test('work mode helpers', () => {
  assert.ok(isMowing(WORK_MODES.WORKING));
  assert.ok(!isMowing(WORK_MODES.PAUSE));
  assert.ok(isDocking(WORK_MODES.RETURNING));
  assert.ok(isCharging(WORK_MODES.CHARGING_PAUSE));
  assert.ok(isPaused(WORK_MODES.PAUSE));
  assert.ok(!isPaused(WORK_MODES.CHARGING));
});
