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
import { buildMowerStates, commandFor } from './src/devices/mower.js';
import { isAuthError, MammotionClient } from './src/mammotion/client.js';

const gladys = new GladysIntegration();

// Delay before re-reading a mower after a command, so the new state shows up
// without waiting for the next poll.
const REFRESH_AFTER_COMMAND_MS = 10_000;
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
    client = new MammotionClient({ email: config.email, password: config.password });
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
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
  return mowers;
}

async function pollMower(mower) {
  lastPollAt.set(mower.iotId, Date.now());
  const status = await getClient().getStatus(mower);
  rememberWorkMode(mower, status.workMode);
  logger.debug(`${mower.name}: ${JSON.stringify(status)}`);
  const states = buildMowerStates(gladys, mower, status, config);
  if (states.length > 0) {
    await gladys.publishStates(states);
  }
}

function scheduleRefresh(mower) {
  const timer = setTimeout(async () => {
    refreshTimers.delete(timer);
    try {
      await pollMower(mower);
    } catch (err) {
      logger.warn(`Refresh after command failed for ${mower.name}: ${err.message}`);
    }
  }, REFRESH_AFTER_COMMAND_MS);
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
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const target = findMowerFeature(gladys, feature.external_id);
  if (!target) {
    // Throw: the SDK sends a success:false acknowledgement to Gladys.
    throw new Error(`Unknown mower feature ${feature.external_id}`);
  }
  const { mower, key } = target;
  const command = commandFor(key, value, lastKnownWorkMode(mower));
  await getClient().sendCommand(mower, command);
  // The mower accepted the order: reflect it now, the refresh confirms it.
  await gladys.publishState(feature.external_id, Number(value) === 1 ? 1 : 0);
  scheduleRefresh(mower);
});

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
    await pollMower(mower);
  }
  return {
    en: `${mowers.length} mower(s) refreshed.`,
    fr: `${mowers.length} tondeuse(s) rafraîchie(s).`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
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
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Mammotion integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
