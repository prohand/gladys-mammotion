import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  DEFAULT_CONFIG,
  devicePollFrequency,
  GLADYS_POLL_FREQUENCIES_MS,
  hasCredentials,
  mowingZoneNames,
  zoneSlug,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values and trims the email', () => {
  const config = normalizeConfig({ email: ' me@example.com ', password: 'secret', language: 'en' });
  assert.equal(config.email, 'me@example.com');
  assert.equal(config.password, 'secret');
  assert.equal(config.language, 'en');
});

test('poll_frequency coming from a form is coerced to a number', () => {
  const config = normalizeConfig({ poll_frequency: '120' });
  assert.equal(config.poll_frequency, 120);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('poll_frequency is kept within the manifest bounds', () => {
  assert.equal(normalizeConfig({ poll_frequency: 5 }).poll_frequency, 30);
  assert.equal(normalizeConfig({ poll_frequency: 99999 }).poll_frequency, 3600);
  assert.equal(normalizeConfig({ poll_frequency: 'abc' }).poll_frequency, 300);
});

test('an unknown language falls back to French', () => {
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('hasCredentials needs both email and password', () => {
  assert.equal(hasCredentials(normalizeConfig()), false);
  assert.equal(hasCredentials(normalizeConfig({ email: 'a@b.c' })), false);
  assert.equal(hasCredentials(normalizeConfig({ email: 'a@b.c', password: 'x' })), true);
});

test('the device poll frequency is always a value Gladys accepts', () => {
  for (const seconds of [30, 45, 59, 60, 90, 600, 3600]) {
    const ms = devicePollFrequency(seconds);
    assert.ok(GLADYS_POLL_FREQUENCIES_MS.includes(ms), `${seconds} s -> ${ms} ms`);
    assert.ok(ms <= seconds * 1000, 'Gladys polls at least as often as asked');
  }
});

test('the mowing settings come from a form as strings and stay within bounds', () => {
  const config = normalizeConfig({
    blade_height: '200',
    mowing_speed: '0,55',
    line_spacing: '',
    mowing_angle: 'abc',
    mowing_pattern: 'spiral',
  });
  assert.equal(config.blade_height, 100);
  assert.equal(config.mowing_speed, 0.6);
  assert.equal(config.line_spacing, 32);
  assert.equal(config.mowing_angle, 111);
  assert.equal(config.mowing_pattern, 'zigzag');
});

test('mowingZoneNames splits the zone list', () => {
  assert.deepEqual(mowingZoneNames(normalizeConfig()), []);
  assert.deepEqual(mowingZoneNames(normalizeConfig({ mowing_zones: ' Avant, ,Arrière ' })), [
    'avant',
    'arrière',
  ]);
});

test('the new job settings: angle type, start progress, no-go laps', () => {
  const config = normalizeConfig({
    angle_mode: 'random',
    start_progress: '150',
    obstacle_laps: 4,
    mowing_angle: 270,
    mowing_pattern: 'zigzag_adaptive',
  });
  assert.equal(config.angle_mode, 'random');
  assert.equal(config.start_progress, 99);
  assert.equal(config.obstacle_laps, 3);
  assert.equal(config.mowing_angle, 180);
  assert.equal(config.mowing_pattern, 'zigzag_adaptive');
  assert.equal(normalizeConfig({ angle_mode: 'north' }).angle_mode, 'optimal');
});

test('zoneSlug ignores case, accents and signs, and is stable', () => {
  assert.equal(zoneSlug('Côté Sud'), 'cote-sud');
  assert.equal(zoneSlug(' Jardin  (devant) '), 'jardin-devant');
  assert.equal(zoneSlug(zoneSlug('Côté Sud')), 'cote-sud');
  assert.equal(zoneSlug('***'), 'zone');
});
