// -----------------------------------------------------------------------------
// Entry point of the Mammotion external integration for Gladys.
//
// Role of this file: wire the SDK to the Mammotion cloud client and the mower
// devices. It:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. logs in to the Mammotion cloud and publishes the account's mowers.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { hasCredentials, normalizeConfig } from './src/config.js';
import {
  buildDiscoveredDevices,
  findMowerByDevice,
  findMowerFeature,
  getMowers,
  lastKnownWorkMode,
  rememberWorkMode,
  setMowers,
} from './src/devices/index.js';
import { buildMowerStates, buildSettingStates, commandFor, mowerIds } from './src/devices/mower.js';
import {
  applyConfigChanges,
  knownZones,
  loadMowerSettings,
  mowerSettings,
  rememberZones,
  setSetting,
  settingFeatureKey,
  settingKeyOf,
} from './src/devices/settings.js';
import { canPlanJobs, isAuthError, MammotionClient } from './src/mammotion/client.js';

const gladys = new GladysIntegration();

// Delay before re-reading a mower after a command, so the new state shows up
// without waiting for the next poll.
const REFRESH_AFTER_COMMAND_MS = 10_000;
// A new job takes longer to get going (zones, route, then start).
const REFRESH_AFTER_START_MS = 30_000;
// Delay before retrying a failed cloud initialization.
const INIT_RETRY_MS = 5 * 60_000;
// Margin for the Gladys scheduler jitter when skipping early polls.
const POLL_MARGIN_MS = 5_000;

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();
let client = null;
let initRetryTimer = null;
const refreshTimers = new Set();
// Last poll time of each mower (iotId -> ms), to honor poll_frequency.
const lastPollAt = new Map();

function getClient() {
  if (!client || client.email !== config.email || client.password !== config.password) {
    client?.stop();
    client = new MammotionClient({
      email: config.email,
      password: config.password,
      onMqttUpdate: (iotId) => publishPushedState(iotId).catch(() => {}),
      onZones: (mower, zones) => onZonesRead(mower, zones),
    });
  }
  return client;
}

async function reportDisconnected(err) {
  const reason = err?.message ?? String(err);
  await gladys
    .setConnectionStatus(false, {
      en: `Mammotion cloud unreachable: ${reason}`.slice(0, 200),
      fr: `Cloud Mammotion injoignable : ${reason}`.slice(0, 200),
    })
    .catch(() => {});
}

// --- Cloud -> Gladys ---------------------------------------------------------

async function refreshMowers() {
  const mowers = await getClient().listMowers();
  setMowers(mowers);
  logger.info(`${mowers.length} mower(s) found on the Mammotion account`);
  for (const mower of mowers) {
    loadMowerSettings(mower, config, (key) => storedSetting(mower, key));
  }
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
  await publishSettings(mowers);
  return mowers;
}

// --- Settings of a new job, shown on the device (src/devices/settings.js) ----

/** Value Gladys keeps for a setting list of a created mower, if any. */
function storedSetting(mower, key) {
  const ids = mowerIds(gladys, mower);
  const device = (gladys.devices ?? []).find((d) => d.external_id === ids.device);
  const feature = device?.features?.find(
    (f) => f.external_id === ids.feature(settingFeatureKey(key)),
  );
  return feature?.last_value_string;
}

// Show the selected values in the lists. A mower not created in Gladys yet
// has no feature: its states are refused, nothing to worry about.
async function publishSettings(mowers) {
  for (const mower of mowers) {
    await gladys
      .publishStates(buildSettingStates(gladys, mower, config))
      .catch((err) => logger.debug(`${mower.name}: settings not published: ${err.message}`));
  }
}

// The zones of a map were read: refresh the "Zones to mow" list.
function onZonesRead(mower, zones) {
  const names = zones.map((z) => z.name);
  if (rememberZones(mower, names)) {
    logger.info(`${mower.name}: zones ${names.join(', ')}`);
    gladys
      .publishDiscoveredDevices(buildDiscoveredDevices(gladys, config))
      .catch((err) => logger.warn(`Zone list not published: ${err.message}`));
  }
}

// Read the zones once per mower, in the background, so the list is full
// before the first job.
function readZonesOnce(mowers) {
  for (const mower of mowers.filter((m) => canPlanJobs(m) && !knownZones(m))) {
    getClient()
      .readZones(mower)
      .catch((err) => logger.warn(`${mower.name}: zones not read: ${err.message}`));
  }
}

async function pollMower(mower, { force = false } = {}) {
  lastPollAt.set(mower.iotId, Date.now());
  const status = await getClient().getStatus(mower, { force });
  rememberWorkMode(mower, status.workMode);
  logger.debug(`${mower.name}: ${JSON.stringify(status)}`);
  const states = buildMowerStates(gladys, mower, status, config);
  if (states.length > 0) {
    await gladys.publishStates(states);
  }
}

// Mowers on the Mammotion broker push their state: publish it, at most once
// every PUSH_THROTTLE_MS per mower (a mowing mower posts very often).
const PUSH_THROTTLE_MS = 15_000;
const pushTimers = new Map();
const lastPushAt = new Map();

async function publishPushedState(iotId) {
  const wait = (lastPushAt.get(iotId) ?? 0) + PUSH_THROTTLE_MS - Date.now();
  if (wait > 0) {
    if (!pushTimers.has(iotId)) {
      const timer = setTimeout(() => {
        pushTimers.delete(iotId);
        publishPushedState(iotId).catch(() => {});
      }, wait);
      timer.unref?.();
      pushTimers.set(iotId, timer);
    }
    return;
  }
  lastPushAt.set(iotId, Date.now());
  const mower = getMowers().find((m) => m.iotId === iotId);
  const status = client?.mqtt.getStatus(iotId);
  if (!mower || !status) {
    return;
  }
  rememberWorkMode(mower, status.workMode);
  const states = buildMowerStates(gladys, mower, status, config);
  if (states.length > 0) {
    await gladys.publishStates(states);
  }
}

function scheduleRefresh(mower, delay = REFRESH_AFTER_COMMAND_MS) {
  const timer = setTimeout(async () => {
    refreshTimers.delete(timer);
    try {
      await pollMower(mower, { force: true });
    } catch (err) {
      logger.warn(`Refresh after command failed for ${mower.name}: ${err.message}`);
    }
  }, delay);
  timer.unref?.();
  refreshTimers.add(timer);
}

// (Re)initialize the cloud side: login, list the mowers, first poll.
async function initialize() {
  clearTimeout(initRetryTimer);
  initRetryTimer = null;

  if (!hasCredentials(config)) {
    setMowers([]);
    await gladys.setConnectionStatus(false, {
      en: 'Enter the email and password of your Mammotion app account.',
      fr: 'Renseignez l’email et le mot de passe de votre compte Mammotion.',
    });
    return;
  }

  try {
    const mowers = await refreshMowers();
    await gladys.setConnectionStatus(true);
    for (const mower of mowers) {
      await pollMower(mower).catch((err) =>
        logger.warn(`First poll failed for ${mower.name}: ${err.message}`),
      );
    }
    readZonesOnce(mowers);
  } catch (err) {
    logger.error('Mammotion initialization failed', err);
    await reportDisconnected(err);
    initRetryTimer = setTimeout(() => initialize().catch(() => {}), INIT_RETRY_MS);
    initRetryTimer.unref?.();
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> listing the mowers of the account');
  if (!hasCredentials(config)) {
    await gladys.publishDiscoveredDevices([]);
    return;
  }
  await refreshMowers();
});

// --- Polling: Gladys asks to refresh a mower (every 30 or 60 s) -------------
gladys.onPoll(async (device) => {
  const mower = findMowerByDevice(gladys, device);
  if (!mower) {
    logger.debug(`onPoll ignored (unknown mower) for ${device.external_id}`);
    return;
  }
  // Gladys polls at most every 60 s: skip the calls that come before the
  // interval chosen by the user (up to 3600 s).
  const elapsed = Date.now() - (lastPollAt.get(mower.iotId) ?? 0);
  if (elapsed < config.poll_frequency * 1000 - POLL_MARGIN_MS) {
    return;
  }
  try {
    await pollMower(mower);
  } catch (err) {
    logger.warn(`Poll failed for ${mower.name}: ${err.message}`);
    if (isAuthError(err)) {
      await reportDisconnected(err);
    }
    throw err;
  }
});

// --- Command: the user acts on the Mowing / Return to dock switches ---------
// A refused or useless order sends nothing to the mower: every message to it
// (sync, report request) disturbs the Mammotion app.
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const target = findMowerFeature(gladys, feature.external_id);
  if (!target) {
    // Throw: the SDK sends a success:false acknowledgement to Gladys.
    throw new Error(`Unknown mower feature ${feature.external_id}`);
  }
  const { mower, key } = target;
  const settingKey = settingKeyOf(key);
  if (settingKey) {
    // Kept for the next job; Gladys saves the value itself (no feedback).
    setSetting(mower, settingKey, value);
    logger.info(`${mower.name}: ${settingKey} = ${value} for the next job`);
    return;
  }
  const on = Number(value) === 1 ? 1 : 0;
  let command;
  try {
    command = commandFor(key, value, lastKnownWorkMode(mower));
  } catch (err) {
    logger.warn(`${mower.name}: ${err.message}`);
    // Put the switch back: the order was not sent.
    await gladys.publishState(feature.external_id, on ? 0 : 1).catch(() => {});
    throw err;
  }
  if (!command) {
    logger.info(`${mower.name}: nothing to do for ${key} = ${value}`);
    await gladys.publishState(feature.external_id, on);
    return;
  }
  if (command === 'refresh') {
    // Answer Gladys now: the report comes back on the broker within seconds.
    pollMower(mower, { force: true }).catch((err) =>
      logger.warn(`Refresh failed for ${mower.name}: ${err.message}`),
    );
    return;
  }
  if (command === 'startJob') {
    // Zones + route + start take longer than the 5 s Gladys waits for an answer.
    await gladys.publishState(feature.external_id, 1);
    getClient()
      .startJob(mower, mowerSettings(mower, config))
      .then(() => scheduleRefresh(mower, REFRESH_AFTER_START_MS))
      .catch(async (err) => {
        logger.warn(`${mower.name}: new job not started: ${err.message}`);
        await gladys.publishState(feature.external_id, 0).catch(() => {});
      });
    return;
  }
  if (command === 'stopAndDock') {
    // Two orders with a gap: longer than the 5 s Gladys waits for an answer.
    await gladys.publishState(feature.external_id, 1);
    getClient()
      .sendCommands(mower, ['stop', 'dock'])
      .then(() => scheduleRefresh(mower))
      .catch(async (err) => {
        logger.warn(`${mower.name}: return to dock failed: ${err.message}`);
        await gladys.publishState(feature.external_id, 0).catch(() => {});
      });
    return;
  }
  await getClient().sendCommand(mower, command);
  // The mower accepted the order: reflect it now, the refresh confirms it.
  await gladys.publishState(feature.external_id, on);
  scheduleRefresh(mower);
});

// --- Device created or updated (Discovery screen): fill the setting lists ---
async function onDeviceSaved(device) {
  const mower = findMowerByDevice(gladys, device);
  if (mower) {
    await publishSettings([mower]);
  }
}
gladys.onDeviceCreated(onDeviceSaved);
gladys.onDeviceUpdated(onDeviceSaved);

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  if (!hasCredentials(config)) {
    throw new Error(
      'Enter the email and password first / Renseignez d’abord email et mot de passe',
    );
  }
  const mowers = await refreshMowers();
  await gladys.setConnectionStatus(true);
  const names = mowers.map((m) => m.name).join(', ') || '-';
  return {
    en: `Connected: ${mowers.length} mower(s) found (${names}).`,
    fr: `Connecté : ${mowers.length} tondeuse(s) trouvée(s) (${names}).`,
  };
});

gladys.onAction('refresh', async () => {
  const mowers = getMowers();
  for (const mower of mowers) {
    await pollMower(mower, { force: true });
  }
  return {
    en: `${mowers.length} mower(s) refreshed.`,
    fr: `${mowers.length} tondeuse(s) rafraîchie(s).`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  const previous = config;
  config = normalizeConfig(newConfig);
  // A new value saved in the configuration applies to every mower (the
  // lists are re-published by initialize).
  const changed = applyConfigChanges(previous, config);
  if (changed.length > 0) {
    logger.info(`Settings applied to every mower: ${changed.join(', ')}`);
  }
  // New credentials or a new poll_frequency: re-login and re-publish the
  // devices (publishDiscoveredDevices is idempotent, upsert by external_id).
  await initialize();
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await initialize();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await reportDisconnected(err);
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  clearTimeout(initRetryTimer);
  for (const timer of refreshTimers) {
    clearTimeout(timer);
  }
  refreshTimers.clear();
  for (const timer of pushTimers.values()) {
    clearTimeout(timer);
  }
  client?.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Mammotion integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
