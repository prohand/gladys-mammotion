// -----------------------------------------------------------------------------
// Scene triggers, scene action outputs and the widget, against the manifest.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WORK_MODES } from '../src/mammotion/telemetry.js';
import {
  MowerEventTracker,
  PROBLEMS,
  SCENE_ACTION,
  SCENE_TRIGGER,
  statusOutputs,
} from '../src/scenes.js';
import { buildMowerWidget, messageContent, WIDGET, WIDGET_ACTION } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

const DEVICE = 'mammotion-mower:abc';
const status = (workMode, extra = {}) => ({
  workMode,
  online: true,
  battery: 80,
  charging: false,
  ...extra,
});

/** Feed a list of statuses, return the keys of the events fired. */
function run(statuses, tracker = new MowerEventTracker()) {
  return statuses.flatMap((s) =>
    tracker.observe(DEVICE, 'Luba', s, 'fr').map((event) => event.key),
  );
}

// --- Transitions -------------------------------------------------------------

test('the first status after a start only records: a restart announces nothing', () => {
  assert.deepEqual(run([status(WORK_MODES.CHARGING)]), []);
  assert.deepEqual(run([status(WORK_MODES.WORKING)]), []);
  assert.deepEqual(run([status(WORK_MODES.LOCATION_ERROR)]), []);
});

test('a whole job: started, ended, docked, each once', () => {
  assert.deepEqual(
    run([
      status(WORK_MODES.CHARGING),
      status(WORK_MODES.READY),
      status(WORK_MODES.WORKING),
      status(WORK_MODES.WORKING),
      status(WORK_MODES.RETURNING),
      status(WORK_MODES.CHARGING),
      status(WORK_MODES.CHARGING),
    ]),
    [SCENE_TRIGGER.MOWING_STARTED, SCENE_TRIGGER.JOB_ENDED, SCENE_TRIGGER.DOCKED],
  );
});

test('a recharge in the middle of a job does not end it', () => {
  const tracker = new MowerEventTracker();
  const keys = run(
    [
      status(WORK_MODES.READY),
      status(WORK_MODES.WORKING),
      status(WORK_MODES.RETURNING),
      status(WORK_MODES.CHARGING_PAUSE),
      status(WORK_MODES.WORKING),
    ],
    tracker,
  );
  assert.deepEqual(keys, [
    SCENE_TRIGGER.MOWING_STARTED,
    SCENE_TRIGGER.DOCKED,
    SCENE_TRIGGER.MOWING_STARTED,
  ]);
  const [docked] = tracker
    .observe(DEVICE, 'Luba', status(WORK_MODES.CHARGING_PAUSE), 'fr')
    .filter((event) => event.key === SCENE_TRIGGER.DOCKED);
  assert.equal(docked.data.job_paused, true);
});

test('sending the mower home without a job ends nothing', () => {
  assert.deepEqual(
    run([status(WORK_MODES.READY), status(WORK_MODES.RETURNING), status(WORK_MODES.CHARGING)]),
    [SCENE_TRIGGER.DOCKED],
  );
});

test('a job stopped from a pause ends it', () => {
  assert.deepEqual(
    run([status(WORK_MODES.WORKING), status(WORK_MODES.PAUSE), status(WORK_MODES.READY)]),
    [SCENE_TRIGGER.JOB_ENDED],
  );
});

test('a problem fires once, and again only when it changes', () => {
  const tracker = new MowerEventTracker();
  const events = [
    status(WORK_MODES.WORKING),
    status(WORK_MODES.LOCATION_ERROR),
    status(WORK_MODES.LOCATION_ERROR),
    status(WORK_MODES.WORKING, { online: false }),
  ].flatMap((s) => tracker.observe(DEVICE, 'Luba', s, 'en'));
  assert.deepEqual(
    events.filter((e) => e.key === SCENE_TRIGGER.PROBLEM).map((e) => e.data.problem),
    [PROBLEMS.LOCATION_ERROR, PROBLEMS.OFFLINE],
  );
});

test('an unknown work mode moves nothing', () => {
  assert.deepEqual(
    run([status(WORK_MODES.CHARGING), status(null), status(WORK_MODES.CHARGING)]),
    [],
  );
});

// --- Manifest contract ---------------------------------------------------------

test('widgets, triggers and actions need Gladys >= 5.1.0', () => {
  const [, major, minor] = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)/).map(Number);
  assert.ok(major > 5 || (major === 5 && minor >= 1));
});

test('the declared keys are exactly the ones the code handles', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGER).sort(),
  );
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTION).sort(),
  );
  assert.deepEqual(
    manifest.widgets.map((w) => w.key),
    Object.values(WIDGET),
  );
  for (const key of Object.keys(SCENE_ACTION)) {
    assert.ok(indexSource.includes(`gladys.onSceneAction(SCENE_ACTION.${key}`), key);
  }
  assert.ok(indexSource.includes('gladys.onWidgetGet(WIDGET.MOWER'));
  assert.ok(indexSource.includes('gladys.onWidgetAction(WIDGET.MOWER'));
});

test('every event carries each filter and variable its trigger declares', () => {
  const tracker = new MowerEventTracker();
  const events = [
    status(WORK_MODES.READY, { progressPercent: 0 }),
    status(WORK_MODES.WORKING, { progressPercent: 10 }),
    status(WORK_MODES.RETURNING),
    status(WORK_MODES.CHARGING, { progressPercent: 100 }),
    status(WORK_MODES.LOCK),
  ].flatMap((s) => tracker.observe(DEVICE, 'Luba', s, 'fr'));
  for (const trigger of manifest.scene_triggers) {
    const event = events.find((e) => e.key === trigger.key);
    assert.ok(event, `${trigger.key} is fired`);
    for (const { key } of [...trigger.fields, ...trigger.variables]) {
      assert.ok(key in event.data, `${trigger.key} carries ${key}`);
    }
    // A filter is never a boolean and never carries a default: empty = any.
    for (const field of trigger.fields) {
      assert.notEqual(field.type, 'boolean');
      assert.equal(field.default, undefined);
    }
  }
});

test('the problem filter offers exactly the problems the code reports', () => {
  const filter = manifest.scene_triggers
    .find((t) => t.key === SCENE_TRIGGER.PROBLEM)
    .fields.find((f) => f.key === 'problem');
  assert.deepEqual(filter.options.map((o) => o.value).sort(), Object.values(PROBLEMS).sort());
});

test('get_mower_status returns exactly the declared outputs, null when unknown', () => {
  const declared = manifest.scene_actions
    .find((a) => a.key === SCENE_ACTION.GET_STATUS)
    .outputs.map((o) => o.key)
    .sort();
  const outputs = statusOutputs(
    'Luba',
    status(WORK_MODES.WORKING, { progressPercent: 42, remainingMinutes: 30 }),
  );
  assert.deepEqual(Object.keys(outputs).sort(), declared);
  assert.equal(outputs.progress, 42);
  assert.equal(outputs.mowing, true);
  assert.deepEqual(Object.keys(statusOutputs('Luba', null)).sort(), declared);
  assert.equal(statusOutputs('Luba', null).battery, null);
});

test('the order actions declare the result output index.js returns', () => {
  for (const key of ['START_MOWING', 'PAUSE_MOWING', 'RETURN_TO_DOCK']) {
    const action = manifest.scene_actions.find((a) => a.key === SCENE_ACTION[key]);
    assert.deepEqual(
      action.outputs.map((o) => o.key),
      ['result'],
    );
  }
});

// --- Widget ------------------------------------------------------------------

test('the mower card is rendered by the core exactly as sent, in every state', () => {
  const cases = [
    null,
    status(null, { online: null }),
    status(WORK_MODES.WORKING, { progressPercent: 42, remainingMinutes: 75 }),
    status(WORK_MODES.PAUSE, { progressPercent: 42, remainingMinutes: 20, battery: 12 }),
    status(WORK_MODES.CHARGING, { charging: true }),
    status(WORK_MODES.LOCATION_ERROR),
    status(WORK_MODES.READY, { online: false }),
  ];
  for (const s of cases) {
    const content = buildMowerWidget('Luba 2 AWD 5000 – Jardin de derrière la maison', s);
    assert.deepEqual(validateWidgetContent(content), [], JSON.stringify(s));
  }
  assert.deepEqual(validateWidgetContent(messageContent({ en: 'x', fr: 'x' })), []);
});

test('the card offers the order that makes sense now', () => {
  const buttons = (s) =>
    buildMowerWidget('Luba', s)
      .components.filter((c) => c.type === 'button')
      .map((c) => c.action.key);
  assert.deepEqual(buttons(status(WORK_MODES.WORKING)), [WIDGET_ACTION.PAUSE, WIDGET_ACTION.DOCK]);
  assert.deepEqual(buttons(status(WORK_MODES.PAUSE)), [WIDGET_ACTION.START, WIDGET_ACTION.DOCK]);
  assert.deepEqual(buttons(status(WORK_MODES.CHARGING)), [WIDGET_ACTION.START]);
  assert.deepEqual(buttons(status(WORK_MODES.READY, { online: false })), []);
});

test('the battery shows with its unit', () => {
  const gauge = buildMowerWidget('Luba', status(WORK_MODES.READY)).components.find(
    (c) => c.type === 'gauge',
  );
  assert.equal(gauge.value, 80);
  assert.equal(gauge.unit, '%');
  assert.equal(gauge.device_feature, undefined);
});
