// -----------------------------------------------------------------------------
// Orders: the guard of a job being started, the results of the scene actions
// and widget buttons, and the "Refresh the mowers" action.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEATURE } from '../src/devices/mower.js';
import { JobStarts, orderMessage, orderResult, refreshAll, STARTING } from '../src/orders.js';
import { MowerEventTracker } from '../src/scenes.js';
import { WORK_MODES } from '../src/mammotion/telemetry.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a second start is refused while the route of the first is planned', async () => {
  const starts = new JobStarts({ holdMs: 1000 });
  const planning = deferred();
  let calls = 0;
  const start = () => {
    calls += 1;
    return planning.promise;
  };
  const first = starts.launch('iot-1', start);
  // Same tick: the guard is taken before any await.
  assert.equal(starts.launch('iot-1', start), null);
  assert.equal(starts.isStarting('iot-1'), true);
  // Another mower is not held up.
  assert.notEqual(
    starts.launch('iot-2', async () => {}),
    null,
  );
  planning.resolve();
  assert.equal(await first, true);
  assert.equal(calls, 1);
});

test('the guard is kept a little after a start, then released', async () => {
  let now = 0;
  const starts = new JobStarts({ holdMs: 1000, now: () => now });
  let started = 0;
  await starts.launch('iot-1', async () => {}, { onStarted: () => (started += 1) });
  assert.equal(started, 1);
  now = 999;
  assert.equal(
    starts.launch('iot-1', async () => {}),
    null,
  );
  now = 1000;
  assert.equal(starts.isStarting('iot-1'), false);
  assert.notEqual(
    starts.launch('iot-1', async () => {}),
    null,
  );
});

test('a failed start frees the mower at once and calls onFailed only', async () => {
  const starts = new JobStarts({ holdMs: 60_000 });
  const seen = [];
  const outcome = await starts.launch(
    'iot-1',
    async () => {
      throw new Error('No zone on the mower map');
    },
    { onStarted: () => seen.push('started'), onFailed: (err) => seen.push(err.message) },
  );
  assert.equal(outcome, false);
  assert.deepEqual(seen, ['No zone on the mower map']);
  assert.equal(starts.isStarting('iot-1'), false);
});

test('a failed start fires no scene event: triggers follow the reports only', async () => {
  // The order memory may move on a start, the scene triggers never do: they
  // only see the statuses the mower reports. Ready before, ready after.
  const tracker = new MowerEventTracker();
  const ready = { workMode: WORK_MODES.READY, online: true };
  assert.deepEqual(tracker.observe('dev', 'Luba', ready, 'en'), []);
  const starts = new JobStarts();
  await starts.launch('iot-1', async () => {
    throw new Error('refused');
  });
  assert.deepEqual(tracker.observe('dev', 'Luba', ready, 'en'), []);
});

test('a refused start answers already_starting, with a message', () => {
  assert.equal(orderResult(FEATURE.MOWING, 1, STARTING), 'already_starting');
  assert.equal(orderResult(FEATURE.MOWING, 1, 'startJob'), 'started');
  assert.equal(orderResult(FEATURE.MOWING, 1, null), 'already_mowing');
  assert.equal(orderResult(FEATURE.DOCK, 1, 'dock'), 'returning');
  assert.match(orderMessage('already_starting').en, /already being started/);
  assert.match(orderMessage('already_starting').fr, /déjà en cours de lancement/);
  assert.deepEqual(orderMessage('whatever'), { en: 'Order sent.', fr: 'Ordre envoyé.' });
});

test('the results of the orders are listed in both docs', () => {
  for (const lang of ['en', 'fr']) {
    const doc = readFileSync(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8');
    for (const result of [
      'started',
      'resumed',
      'already_mowing',
      'already_starting',
      'paused',
      'not_mowing',
      'returning',
      'already_docked',
    ]) {
      assert.ok(doc.includes(`\`${result}\``), `${result} missing from docs/${lang}.md`);
    }
  }
});

test('refreshAll reads every mower even when one fails, and names it', async () => {
  const mowers = [{ name: 'Luba' }, { name: 'Yuka' }, { name: 'Mini' }];
  const read = [];
  await assert.rejects(
    refreshAll(mowers, async (mower) => {
      read.push(mower.name);
      if (mower.name === 'Luba') throw new Error('timeout');
    }),
    (err) => {
      assert.match(err.message, /2\/3 mower\(s\) refreshed, failed: Luba \(timeout\)/);
      assert.match(err.message, /2\/3 tondeuse\(s\) rafraîchie\(s\), en échec : Luba/);
      return true;
    },
  );
  assert.deepEqual(read.sort(), ['Luba', 'Mini', 'Yuka']);
});

test('refreshAll answers in both languages when every mower was read', async () => {
  assert.deepEqual(await refreshAll([{ name: 'Luba' }], async () => {}), {
    en: '1 mower(s) refreshed.',
    fr: '1 tondeuse(s) rafraîchie(s).',
  });
});
