// -----------------------------------------------------------------------------
// Mammotion MQTT broker, used by the mowers that are NOT bound on the Aliyun
// gateway (recent accounts and firmwares: Aliyun answers "user device not
// bind"). These mowers have no "read properties" HTTP API: they push their
// state on the Mammotion broker, and we keep the last values in memory.
//
// Topics (same as the Mammotion app, see PyMammotion transport/mqtt.py):
//   /sys/{pk}/{dn}/thing/event/+/post        property/post = batterie, état…
//   /sys/proto/{pk}/{dn}/thing/event/+/post  protobuf reports (ignored)
//   /sys/{pk}/{dn}/app/down/thing/status     { action: "online" | "offline" }
// -----------------------------------------------------------------------------

import mqtt from 'mqtt';
import { createLogger } from '@gladysassistant/integration-sdk';
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

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
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
    // iotId -> { properties: object, online: boolean|null, updatedAt: number }
    this.cache = new Map();
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
      await this.client.subscribeAsync(deviceTopics(productKey, deviceName), { qos: 0 });
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
      // Same as the Mammotion app / PyMammotion: no certificate check.
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
      const iotState = message.params.iotState;
      if (iotState !== undefined) {
        entry.online = Number(iotState) === 1;
      } else {
        entry.online = true;
      }
    } else {
      return;
    }
    entry.updatedAt = Date.now();
    logger.debug(`${parts[3]} <- ${topic.split('/').slice(-2).join('/')}`);
    this.onUpdate(device.iotId);
  }

  entry(iotId) {
    let entry = this.cache.get(iotId);
    if (!entry) {
      entry = { properties: {}, online: null, updatedAt: 0 };
      this.cache.set(iotId, entry);
    }
    return entry;
  }

  /** Last known telemetry (telemetry.js shape), or null if nothing received. */
  getStatus(iotId) {
    const entry = this.cache.get(iotId);
    if (!entry || entry.updatedAt === 0) {
      return null;
    }
    const status = parseProperties(entry.properties);
    if (entry.online !== null) {
      status.online = entry.online;
    }
    return status;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.rebuildTimer);
    this.client?.end(true);
    this.client = null;
  }
}
