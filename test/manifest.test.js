// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_CONFIG,
  LANGUAGES,
  MOWING_BOUNDS,
  normalizeConfig,
  POLL_FREQUENCY_MAX,
  POLL_FREQUENCY_MIN,
} from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action has a registered handler in index.js', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      indexSource.includes(`gladys.onAction('${action.key}'`),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(major > 4 || (major === 4 && minor >= 86));
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      // A select holds strings: the speed list ("0.6") stands for a number (0.6).
      assert.equal(
        String(DEFAULT_CONFIG[field.key]),
        String(field.default),
        `DEFAULT_CONFIG.${field.key}`,
      );
    }
  }
});

test('the poll_frequency field matches the bounds enforced by the code', () => {
  const field = manifest.config_schema.find((f) => f.key === 'poll_frequency');
  assert.ok(field, 'the manifest declares a poll_frequency field');
  assert.equal(field.type, 'number');
  assert.equal(field.min, POLL_FREQUENCY_MIN);
  assert.equal(field.max, POLL_FREQUENCY_MAX);
});

test('credentials are required and the password is a secret', () => {
  const email = manifest.config_schema.find((f) => f.key === 'email');
  const password = manifest.config_schema.find((f) => f.key === 'password');
  assert.equal(email.required, true);
  assert.equal(password.required, true);
  assert.equal(password.type, 'secret');
  assert.equal(password.default, undefined, 'a secret must not ship a default');
});

test('section fields are purely presentational', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.ok(section.label?.en);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('manifest version and docker image tag stay in lockstep', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('every speed of the list is kept as is by the config', () => {
  // A number field only took 0.2 and 1.2: the form steps by 1 from the minimum.
  const field = manifest.config_schema.find((f) => f.key === 'mowing_speed');
  assert.equal(field.type, 'select');
  const [min, max] = MOWING_BOUNDS.mowing_speed;
  assert.equal(Number(field.options[0].value), min);
  assert.equal(Number(field.options.at(-1).value), max);
  for (const { value } of field.options) {
    assert.equal(normalizeConfig({ mowing_speed: value }).mowing_speed, Number(value));
  }
});

test('the manifest declares the transports used (the mowers are reached through the Mammotion cloud only)', () => {
  assert.deepEqual(manifest.transports, ['cloud']);
});

// Every text a user reads, in the four languages of the Gladys interface.
const MANIFEST_LANGUAGES = ['en', 'fr', 'de', 'es'];

/** Every multi-language object of the manifest, with where it sits. */
function multiLanguageTexts(value, path = '') {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => multiLanguageTexts(item, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    if (typeof value.en === 'string') {
      return [{ path, text: value }];
    }
    return Object.entries(value).flatMap(([key, item]) =>
      multiLanguageTexts(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

const length = (text) => [...text].length;

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = multiLanguageTexts(manifest);
  assert.ok(texts.length > 100);
  for (const { path, text } of texts) {
    assert.deepEqual(Object.keys(text), MANIFEST_LANGUAGES, path);
    for (const language of MANIFEST_LANGUAGES) {
      assert.ok(text[language].trim().length > 0, `${path}.${language}`);
    }
  }
});

test('the texts respect the store length limits in every language', () => {
  for (const language of MANIFEST_LANGUAGES) {
    const description = length(manifest.description[language]);
    assert.ok(description >= 10 && description <= 100, `description.${language}`);
    for (const widget of manifest.widgets) {
      const label = length(widget.label[language]);
      assert.ok(label >= 3 && label <= 30, `widget ${widget.key} label.${language}`);
      assert.ok(length(widget.description[language]) <= 100, `widget ${widget.key}`);
    }
    for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
      assert.ok(length(section.description[language]) <= 1000, `section ${section.key}`);
    }
  }
});

test('the status language select offers every language the code speaks', () => {
  const field = manifest.config_schema.find((f) => f.key === 'language');
  assert.deepEqual(
    field.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.ok(LANGUAGES.includes(field.default));
});
