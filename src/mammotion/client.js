// -----------------------------------------------------------------------------
// Mammotion cloud client.
//
// Two back-ends live side by side at Mammotion:
//   - the Mammotion API (id.mammotion.com OAuth + the `iot` domain found in the
//     access token): login, device list, commands for recent firmwares;
//   - the Aliyun IoT gateway (see aliyun.js): properties and commands for most
//     Luba / Yuka mowers.
// Mowers that are not bound on Aliyun ("user device not bind") push their
// state on the Mammotion MQTT broker instead (see mqtt.js).
// This client hides all that: listMowers(), getStatus(mower), sendCommand(...).
// Sessions are opened lazily and renewed on expiry or on an auth error.
// -----------------------------------------------------------------------------

import { createHash, createHmac, randomInt } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { assertAliyunOk, callAliyunApi, createAliyunSession } from './aliyun.js';
import { buildReportRequestContent, buildTaskControlContent } from './commands.js';
import { HttpError, requestJson } from './http.js';
import { MammotionMqtt } from './mqtt.js';
import { parseProperties, toNumber } from './telemetry.js';

const logger = createLogger({ name: 'mammotion' });

const OAUTH_DOMAIN = 'https://id.mammotion.com';
const API_DOMAIN = 'https://domestic.mammotion.com';
const OAUTH_APP_KEY = 'GxebgSt8si6pKqR';
const OAUTH_APP_SECRET = 'JP0508SRJFa0A90ADpzLINDBxMa4Vj';
const TOKEN_PATH = '/oauth2/token';

// RTK base stations share the account with the mowers but are not mowers.
const RTK_PRODUCT_KEYS = new Set(['a1qXkZ5P39W', 'a1Nc68bGZzX', 'a1NfZqdSREf', 'a1ZuQVL7UiN']);

const AUTH_ERROR_HINTS = [
  'token',
  'session',
  'unauthorized',
  'not login',
  'identityid is blank',
  'identity id is blank',
  'auth error',
  'forbidden',
];

export function isAuthError(err) {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    return true;
  }
  if ([401, 460].includes(err?.aliyunCode)) {
    return true;
  }
  const message = String(err?.message ?? '').toLowerCase();
  return AUTH_ERROR_HINTS.some((hint) => message.includes(hint));
}

function decodeJwtClaims(token) {
  const payload = String(token).split('.')[1];
  if (!payload) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function oauthSignature(payload, timestampMs) {
  const toSign = `${OAUTH_APP_KEY}${timestampMs}${TOKEN_PATH}${JSON.stringify(payload)}`;
  const key = createHash('md5').update(OAUTH_APP_SECRET, 'utf8').digest('hex');
  return createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
}

function buildClientId() {
  const suffix = Array.from({ length: 7 }, () => randomInt(0, 10)).join('');
  return `${Date.now()}_${suffix}_1`;
}

/** Aliyun refuses the mowers that live on the Mammotion broker. */
export function isNotBoundError(err) {
  return /not bind|not bound/i.test(String(err?.message ?? ''));
}

const EMPTY_STATUS = {
  battery: null,
  workMode: null,
  online: null,
  bladeHeightMm: null,
  totalWorkHours: null,
  totalDistanceKm: null,
  firmware: null,
};

export function isRtkBaseStation(entry) {
  const name = `${entry.name ?? ''} ${entry.deviceName ?? ''}`.toLowerCase();
  return RTK_PRODUCT_KEYS.has(entry.productKey) || name.startsWith('rtk');
}

export class MammotionClient {
  /**
   * @param {{ email: string, password: string, onMqttUpdate?: (iotId: string) => void }} options
   */
  constructor({ email, password, onMqttUpdate }) {
    this.email = email;
    this.password = password;
    this.session = null;
    this.aliyun = null;
    this.mqtt = new MammotionMqtt(() => this.getMqttCredentials(), onMqttUpdate);
  }

  // --- Mammotion OAuth ------------------------------------------------------

  async login() {
    if (!this.email || !this.password) {
      throw new Error('Email and password are required');
    }
    const clientId = buildClientId();
    const payload = {
      username: this.email,
      password: this.password,
      client_id: OAUTH_APP_KEY,
      grant_type: 'password',
      authType: '0',
    };
    const timestampMs = `${Date.now()}`;
    const response = await requestJson(`${OAUTH_DOMAIN}${TOKEN_PATH}`, {
      method: 'POST',
      query: payload,
      headers: {
        'User-Agent': 'okhttp/4.9.3',
        'App-Version': 'Gladys,1.0.0',
        'Ma-App-Key': OAUTH_APP_KEY,
        'Ma-Signature': oauthSignature(payload, timestampMs),
        'Ma-Timestamp': `${Math.floor(Number(timestampMs) / 1000)}`,
        'Client-Id': clientId,
        'Client-Type': '1',
      },
    });
    if (response?.code !== 0 || !response?.data?.access_token) {
      throw new Error(`Mammotion login failed: ${response?.msg || 'unknown error'}`);
    }
    const data = response.data;
    const claims = decodeJwtClaims(data.access_token);
    const iot = claims.iot ? String(claims.iot) : '';
    this.session = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000,
      iotDomain: iot ? (iot.startsWith('http') ? iot : `https://${iot}`).replace(/\/$/, '') : '',
      userAccount: String(data.userInformation?.userAccount ?? '0'),
      authorizationCode: data.authorization_code || '',
      countryCode: data.userInformation?.domainAbbreviation || claims.areaCode || 'FR',
      clientId,
    };
    // A new OAuth session invalidates the Aliyun one derived from it.
    this.aliyun = null;
    logger.info('Logged in to the Mammotion cloud');
    return this.session;
  }

  async ensureSession(force = false) {
    if (!force && this.session && this.session.expiresAt > Date.now()) {
      return this.session;
    }
    return this.login();
  }

  async ensureAliyun(force = false) {
    if (!force && this.aliyun && this.aliyun.expiresAt > Date.now()) {
      return this.aliyun;
    }
    const session = await this.ensureSession();
    this.aliyun = await createAliyunSession(session);
    return this.aliyun;
  }

  /** Run `fn`, and retry it once with fresh sessions on an auth error. */
  async withRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      if (!isAuthError(err)) {
        throw err;
      }
      logger.warn(`Session rejected (${err.message}), logging in again`);
      await this.login();
      return fn();
    }
  }

  mammotionHeaders(session) {
    return {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'okhttp/4.9.3',
      'Client-Id': session.clientId,
      'Client-Type': '1',
    };
  }

  async mammotionGet(url) {
    const session = await this.ensureSession();
    const response = await requestJson(url, { headers: this.mammotionHeaders(session) });
    if (response?.code !== 0) {
      throw new Error(response?.msg || `Mammotion API error on ${url}`);
    }
    return response.data;
  }

  async mammotionPost(url, body) {
    const session = await this.ensureSession();
    const response = await requestJson(url, {
      method: 'POST',
      headers: this.mammotionHeaders(session),
      body: JSON.stringify(body),
    });
    if (response?.code !== 0) {
      const error = new Error(response?.msg || `Mammotion API error on ${url}`);
      error.mammotionCode = response?.code;
      throw error;
    }
    return response.data;
  }

  async aliyunCall(path, apiVer, params) {
    const aliyun = await this.ensureAliyun();
    const response = await callAliyunApi(aliyun.domain, path, apiVer, params, aliyun.iotToken);
    return assertAliyunOk(response, `Aliyun error on ${path}`);
  }

  // --- Devices ----------------------------------------------------------------

  /**
   * List the mowers of the account (RTK base stations excluded).
   * @returns {Promise<Array<{ iotId: string, name: string, productKey: string,
   *   deviceName: string, series: string, online: boolean|null }>>}
   */
  async listMowers() {
    return this.withRetry(async () => {
      const session = await this.ensureSession();
      const byIotId = new Map();
      const merge = (iotId, patch) => {
        if (!iotId) return;
        const current = byIotId.get(iotId) ?? { iotId };
        for (const [key, value] of Object.entries(patch)) {
          if (value !== undefined && value !== null && value !== '' && !current[key]) {
            current[key] = value;
          }
        }
        byIotId.set(iotId, current);
      };

      // 1) Mammotion device list: friendly names and series.
      try {
        const devices = await this.mammotionGet(`${API_DOMAIN}/device-server/v1/device/list`);
        for (const d of Array.isArray(devices) ? devices : []) {
          merge(d.iotId, {
            name: d.deviceName,
            series: d.productSeries || d.series,
            status: toNumber(d.status),
          });
        }
      } catch (err) {
        logger.debug(`Mammotion device list unavailable: ${err.message}`);
      }

      // 2) Mammotion IoT records: productKey + technical device name.
      if (session.iotDomain) {
        try {
          const page = await this.mammotionPost(`${session.iotDomain}/v1/user/device/page`, {
            iotId: '',
            pageNumber: 1,
            pageSize: 100,
          });
          const records = Array.isArray(page) ? page : (page?.records ?? []);
          for (const r of records) {
            merge(r.iotId, { productKey: r.productKey, deviceName: r.deviceName });
          }
        } catch (err) {
          logger.debug(`Mammotion device records unavailable: ${err.message}`);
        }
      }

      // 3) Aliyun bindings: most Luba / Yuka mowers are only listed here.
      let aliyunListed = false;
      try {
        const bindings = await this.aliyunCall('/uc/listBindingByAccount', '1.0.8', {
          pageSize: 100,
          pageNo: 1,
        });
        for (const b of bindings?.data ?? []) {
          merge(b.iotId, {
            nickName: b.nickName,
            productKey: b.productKey,
            deviceName: b.deviceName,
            status: toNumber(b.status),
            aliyunBound: true,
          });
        }
        aliyunListed = true;
      } catch (err) {
        if (isAuthError(err)) throw err;
        logger.warn(`Aliyun bindings unavailable: ${err.message}`);
      }

      return [...byIotId.values()]
        .map((m) => ({
          iotId: m.iotId,
          // The nickname set in the app wins over the technical name.
          name: m.nickName || m.name || m.deviceName || m.iotId,
          productKey: m.productKey || '',
          deviceName: m.deviceName || '',
          series: m.series || '',
          online: m.status === null || m.status === undefined ? null : m.status === 1,
          // Not bound on Aliyun: the state comes from the Mammotion broker.
          // Unknown ('') when Aliyun did not answer: getStatus() finds out.
          cloud: m.aliyunBound ? 'aliyun' : aliyunListed ? 'mammotion' : '',
        }))
        .filter((m) => !isRtkBaseStation(m));
    });
  }

  /**
   * Current telemetry of one mower (see telemetry.js for the shape).
   * @param {{ iotId: string }} mower
   */
  async getStatus(mower) {
    if (mower.cloud === 'mammotion') {
      return this.getMqttStatus(mower);
    }
    try {
      return await this.getAliyunStatus(mower);
    } catch (err) {
      if (!isNotBoundError(err)) throw err;
      logger.info(`${mower.name} is not on Aliyun, switching to the Mammotion broker`);
      mower.cloud = 'mammotion';
      return this.getMqttStatus(mower);
    }
  }

  /**
   * Mammotion broker: last values pushed by the mower (null fields if none yet).
   * Also asks the mower for a fresh report: on its own it only posts its state
   * now and then (up to an hour apart); the answer arrives on the broker
   * within seconds and is published by the onMqttUpdate callback.
   */
  async getMqttStatus(mower) {
    await this.mqtt.watch(mower);
    await this.requestReport(mower).catch((err) => {
      if (isAuthError(err)) throw err;
      logger.warn(`Report request refused for ${mower.name}: ${err.message}`);
    });
    return this.mqtt.getStatus(mower.iotId) ?? { ...EMPTY_STATUS };
  }

  /** Ask a mower of the Mammotion broker to push its state now. */
  async requestReport(mower) {
    return this.withRetry(async () => {
      const session = await this.ensureSession();
      if (!session.iotDomain) {
        throw new Error('Mammotion API unavailable: no iot domain in the access token');
      }
      await this.mammotionInvoke(session, mower, buildReportRequestContent(session));
    });
  }

  async mammotionInvoke(session, mower, content) {
    await this.mammotionPost(`${session.iotDomain}/v1/mqtt/rpc/thing/service/invoke`, {
      args: { content },
      deviceName: mower.deviceName,
      identifier: 'device_protobuf_sync_service',
      iotId: mower.iotId,
      productKey: mower.productKey,
    });
  }

  /** Credentials of the Mammotion MQTT broker (a fresh JWT on each call). */
  async getMqttCredentials() {
    return this.withRetry(async () => {
      const session = await this.ensureSession();
      if (!session.iotDomain) {
        throw new Error('Mammotion broker unavailable: no iot domain in the access token');
      }
      const data = await this.mammotionPost(`${session.iotDomain}/v1/mqtt/auth/jwt`, {});
      if (!data?.host || !data?.jwt) {
        throw new Error('Mammotion broker credentials missing');
      }
      return data;
    });
  }

  async getAliyunStatus(mower) {
    return this.withRetry(async () => {
      const properties = await this.aliyunCall('/thing/properties/get', '1.0.0', {
        iotId: mower.iotId,
      });
      const status = parseProperties(properties);
      if (status.online === null) {
        // Properties do not always carry the connectivity: ask for it.
        try {
          const thing = await this.aliyunCall('/thing/status/get', '1.0.0', {
            iotId: mower.iotId,
          });
          const value = toNumber(thing?.status, thing?.data?.status);
          status.online = value === null ? null : value === 1;
        } catch (err) {
          logger.debug(`Thing status unavailable for ${mower.name}: ${err.message}`);
        }
      }
      return status;
    });
  }

  /**
   * Send a task control command (start, pause, resume, stop, dock, cancelDock).
   * Tries the Mammotion API first, then the Aliyun gateway.
   */
  async sendCommand(mower, command) {
    return this.withRetry(async () => {
      const session = await this.ensureSession();
      const content = buildTaskControlContent(command, session, mower);
      logger.info(`Sending "${command}" to ${mower.name}`);

      if (session.iotDomain) {
        try {
          await this.mammotionInvoke(session, mower, content);
          return;
        } catch (err) {
          if (isAuthError(err) || mower.cloud === 'mammotion') throw err;
          logger.debug(`Mammotion invoke refused (${err.message}), trying the Aliyun gateway`);
        }
      }

      if (mower.cloud === 'mammotion') {
        throw new Error('Mammotion API unavailable: no iot domain in the access token');
      }
      await this.aliyunCall('/thing/service/invoke', '1.0.5', {
        args: { content },
        identifier: 'device_protobuf_sync_service',
        iotId: mower.iotId,
      });
    });
  }

  stop() {
    this.mqtt.stop();
  }
}
