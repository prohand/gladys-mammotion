// -----------------------------------------------------------------------------
// Mammotion MQTT broker, used by the mowers that are NOT bound on the Aliyun
// gateway (recent accounts and firmwares: Aliyun answers "user device not
// bind"). These mowers have no "read properties" HTTP API: they push their
// state on the Mammotion broker, and we keep the last values in memory.
//
// Topics (same as the Mammotion app, see PyMammotion transport/mqtt.py):
//   /sys/{pk}/{dn}/thing/event/+/post        property/post = batterie, état…
//                                            device_protobuf_msg_event = protobuf
//                                            reports asked by requestReport(), and
//                                            answers to the nav requests (waitForNav)
//   /sys/proto/{pk}/{dn}/thing/event/+/post  protobuf reports (ignored)
//   /sys/{pk}/{dn}/app/down/thing/status     { action: "online" | "offline" }
// -----------------------------------------------------------------------------

import mqtt from 'mqtt';
import { createLogger } from '@gladysassistant/integration-sdk';
import { parseNav, parseReport, parseRouteSettings } from './report.js';
import { parseProperties } from './telemetry.js';

const logger = createLogger({ name: 'mammotion-mqtt' });

// Delay before rebuilding the connection with fresh credentials.
const RECONNECT_MS = 60_000;

/** Parse the broker `host` field ("mqtts://host:8883", "host:1883"…). */
export function parseBrokerUrl(host) {
  const url = new URL(String(host).includes('://') ? host : `tcp://${host}`);
  const secure = ['mqtts:', 'ssl:'].includes(url.protocol);
  return {
    protocol: secure ? 'mqtts' : 'mqtt',
    host: url.hostname,
    port: Number(url.port) || (secure ? 8883 : 1883),
  };
}

export function deviceTopics(productKey, deviceName) {
  const pk = productKey || '+';
  return [
    `/sys/${pk}/${deviceName}/thing/event/+/post`,
    `/sys/proto/${pk}/${deviceName}/thing/event/+/post`,
    `/sys/${pk}/${deviceName}/app/down/thing/status`,
  ];
}

// property/post name -> telemetry fields also carried by the protobuf reports.
const REPORT_FIELDS = {
  batteryPercentage: ['battery'],
  deviceState: ['workMode', 'charging', 'progressPercent', 'remainingMinutes'],
  knifeHeight: ['bladeHeightMm'],
  networkInfo: ['totalWorkHours', 'totalDistanceKm'],
};

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Log the settings of a route the mower acknowledges, whoever planned it: a
 * job started from the app shows here which values its choices send (angle
 * type, path mode…), to check the lists of Gladys against the app.
 */
function logRoute(deviceName, content) {
  try {
    const nav = parseNav(content);
    const route = nav ? parseRouteSettings(nav) : null;
    if (route) {
      logger.info(`${deviceName}: route settings seen ${JSON.stringify(route)}`);
    }
  } catch (err) {
    logger.debug(`Unreadable route: ${err.message}`);
  }
}

export class MammotionMqtt {
  /**
   * @param {() => Promise<{ host: string, jwt: string, clientId: string, username: string }>} getCredentials
   * @param {(iotId: string) => void} [onUpdate] called when a mower pushed new values
   */
  constructor(getCredentials, onUpdate = () => {}) {
    this.getCredentials = getCredentials;
    this.onUpdate = onUpdate;
    this.client = null;
    this.connecting = null;
    this.stopped = false;
    this.rebuildTimer = null;
    // deviceName -> { iotId, productKey }
    this.devices = new Map();
    // iotId -> { properties: object, report: object, online: boolean|null,
    //           updatedAt: number, reportAt: number }
    this.cache = new Map();
    // deviceNames that already sent something (logged once, to help support).
    this.heard = new Set();
    // Pending waitForNav() calls.
    this.navWaiters = new Set();
  }

  /**
   * Wait for a navigation answer of a mower. Call it BEFORE sending the
   * request: the answer can come back within a few hundred ms.
   * @template T
   * @param {string} iotId
   * @param {(nav: object) => T | null} match returns the value to resolve with, or null
   * @param {number} timeoutMs
   * @returns {Promise<T | null>} null on timeout
   */
  waitForNav(iotId, match, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { iotId, match, resolve };
      waiter.timer = setTimeout(() => {
        this.navWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      waiter.timer.unref?.();
      this.navWaiters.add(waiter);
    });
  }

  resolveNav(iotId, content) {
    const waiters = [...this.navWaiters].filter((w) => w.iotId === iotId);
    if (waiters.length === 0) {
      return;
    }
    const nav = parseNav(content);
    if (!nav) {
      return;
    }
    for (const waiter of waiters) {
      let value = null;
      try {
        value = waiter.match(nav);
      } catch (err) {
        // A malformed answer must not break the MQTT message loop.
        logger.debug(`Unreadable nav answer: ${err.message}`);
      }
      if (value !== null && value !== undefined) {
        clearTimeout(waiter.timer);
        this.navWaiters.delete(waiter);
        waiter.resolve(value);
      }
    }
  }

  /** Follow a mower: subscribe its topics (now or at the next connection). */
  async watch(mower) {
    if (!mower.deviceName) {
      logger.warn(`${mower.name}: no device name, cannot follow it on the Mammotion broker`);
      return;
    }
    const known = this.devices.has(mower.deviceName);
    this.devices.set(mower.deviceName, { iotId: mower.iotId, productKey: mower.productKey });
    await this.ensureConnected();
    if (!known && this.client?.connected) {
      await this.subscribe(mower.productKey, mower.deviceName);
    }
  }

  async subscribe(productKey, deviceName) {
    try {
      const granted = await this.client.subscribeAsync(deviceTopics(productKey, deviceName), {
        qos: 0,
      });
      // MQTT 3.1.1 answers a refused topic with qos 128 instead of an error.
      const refused = (granted ?? []).filter((g) => g.qos === 128).map((g) => g.topic);
      if (refused.length > 0) {
        logger.warn(`Broker refused ${refused.join(', ')} for ${deviceName}`);
      }
      logger.info(`Following ${deviceName} on the Mammotion broker`);
    } catch (err) {
      logger.warn(`Subscription refused for ${deviceName}: ${err.message}`);
    }
  }

  async ensureConnected() {
    if (this.stopped || this.client) {
      return;
    }
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async connect() {
    const creds = await this.getCredentials();
    const broker = parseBrokerUrl(creds.host);
    const client = mqtt.connect({
      ...broker,
      clientId: creds.clientId,
      username: creds.username,
      password: creds.jwt,
      protocolVersion: 4,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 30_000,
      connectTimeout: 30_000,
      // No certificate check, like the Mammotion app and PyMammotion: nothing
      // shows the broker (host handed out by /v1/mqtt/auth/jwt) presents a
      // certificate a standard check accepts, and a refused handshake would
      // silence every broker mower. It could not be checked from here (the
      // broker port was out of reach). The risk: whoever can intercept the
      // traffic can pose as the broker and read `password`, the account's
      // short-lived JWT. Documented for the users in docs/en.md and fr.md.
      rejectUnauthorized: false,
    });
    this.client = client;

    client.on('connect', async () => {
      logger.info(`Connected to the Mammotion broker ${broker.host}`);
      for (const [deviceName, { productKey }] of this.devices) {
        await this.subscribe(productKey, deviceName);
      }
    });
    client.on('message', (topic, payload) => this.handleMessage(topic, payload));
    client.on('error', (err) => {
      logger.warn(`Mammotion broker error: ${err.message}`);
      // 4/5 (MQTT 3.1.1): bad credentials / not authorized -> the JWT expired.
      if ([4, 5, 134, 135].includes(err.code)) {
        this.rebuild();
      }
    });
    client.on('offline', () => logger.debug('Mammotion broker offline, retrying'));
  }

  /** Drop the connection and open a new one with fresh credentials. */
  rebuild() {
    if (this.rebuildTimer || this.stopped) {
      return;
    }
    this.client?.end(true);
    this.client = null;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.ensureConnected().catch((err) => {
        logger.warn(`Mammotion broker reconnection failed: ${err.message}`);
        this.rebuild();
      });
    }, RECONNECT_MS);
    this.rebuildTimer.unref?.();
  }

  handleMessage(topic, payload) {
    const parts = topic.split('/');
    // ['', 'sys', pk, dn, ...] or ['', 'sys', 'proto', pk, dn, ...]
    if (parts[2] === 'proto') {
      return; // protobuf reports: not decoded (yet)
    }
    const device = this.devices.get(parts[3]);
    if (!device) {
      return;
    }
    const message = parseJson(payload);
    if (!message) {
      return;
    }
    const entry = this.entry(device.iotId);

    if (topic.endsWith('/thing/status')) {
      const action = message.action ?? message.params?.status?.value;
      entry.online = action === 'online' || action === 1;
    } else if (topic.endsWith('/property/post') && message.params) {
      Object.assign(entry.properties, message.params);
      // Newer than the last protobuf report for these fields.
      for (const [property, fields] of Object.entries(REPORT_FIELDS)) {
        if (message.params[property] !== undefined) {
          for (const field of fields) {
            delete entry.report[field];
          }
        }
      }
      const iotState = message.params.iotState;
      if (iotState !== undefined) {
        entry.online = Number(iotState) === 1;
      } else {
        entry.online = true;
      }
    } else if (topic.endsWith('/device_protobuf_msg_event/post')) {
      const content = message.params?.content ?? message.params?.value?.content;
      this.resolveNav(device.iotId, content);
      logRoute(parts[3], content);
      const report = parseReport(content);
      if (!report) {
        return;
      }
      Object.assign(entry.report, report);
      entry.online = true;
      entry.reportAt = Date.now();
    } else {
      return;
    }
    entry.updatedAt = Date.now();
    if (!this.heard.has(parts[3])) {
      this.heard.add(parts[3]);
      logger.info(`First data received from ${parts[3]} (${topic.split('/').at(-2)})`);
    }
    logger.debug(`${parts[3]} <- ${topic.split('/').slice(-2).join('/')}`);
    this.onUpdate(device.iotId);
  }

  entry(iotId) {
    let entry = this.cache.get(iotId);
    if (!entry) {
      entry = { properties: {}, report: {}, online: null, updatedAt: 0, reportAt: 0 };
      this.cache.set(iotId, entry);
    }
    return entry;
  }

  /** Time (ms) of the last protobuf report received from a mower, 0 if none. */
  lastReportAt(iotId) {
    return this.cache.get(iotId)?.reportAt ?? 0;
  }

  /** Last known telemetry (telemetry.js shape), or null if nothing received. */
  getStatus(iotId) {
    const entry = this.cache.get(iotId);
    if (!entry || entry.updatedAt === 0) {
      return null;
    }
    const status = { ...parseProperties(entry.properties), ...entry.report };
    if (entry.online !== null) {
      status.online = entry.online;
    }
    return status;
  }

  stop() {
    this.stopped = true;
    for (const waiter of this.navWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.navWaiters.clear();
    clearTimeout(this.rebuildTimer);
    this.client?.end(true);
    this.client = null;
  }
}
