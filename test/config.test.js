import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG, hasCredentials } from '../src/config.js';

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
  assert.equal(normalizeConfig({ poll_frequency: 'abc' }).poll_frequency, 60);
});

test('an unknown language falls back to French', () => {
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('hasCredentials needs both email and password', () => {
  assert.equal(hasCredentials(normalizeConfig()), false);
  assert.equal(hasCredentials(normalizeConfig({ email: 'a@b.c' })), false);
  assert.equal(hasCredentials(normalizeConfig({ email: 'a@b.c', password: 'x' })), true);
});
