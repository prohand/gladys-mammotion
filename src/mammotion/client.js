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
// This client hides all that: listMowers(), getStatus(mower), sendCommand(...),
// startJob(mower).
// Sessions are opened lazily and renewed on expiry or on an auth error.
// -----------------------------------------------------------------------------

import { createHash, createHmac, randomInt } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { assertAliyunOk, callAliyunApi, createAliyunSession } from './aliyun.js';
import {
  buildHashListRequestContent,
  buildMapElementRequestContent,
  buildReportRequestContent,
  buildRouteContent,
  buildRouteQueryContent,
  buildSyncContent,
  buildTaskControlContent,
  buildZoneListRequestContent,
  receiverFor,
} from './commands.js';
import { HttpError, requestJson } from './http.js';
import { MammotionMqtt } from './mqtt.js';
import { mowingZoneNames } from '../config.js';
import {
  MAP_ELEMENT_ZONE,
  parseHashList,
  parseMapElement,
  parseRouteAnswer,
  parseZoneList,
} from './report.js';
import { parseProperties, toNumber } from './telemetry.js';

const logger = createLogger({ name: 'mammotion' });

const OAUTH_DOMAIN = 'https://id.mammotion.com';
const API_DOMAIN = 'https://domestic.mammotion.com';
const OAUTH_APP_KEY = 'GxebgSt8si6pKqR';
const OAUTH_APP_SECRET = 'JP0508SRJFa0A90ADpzLINDBxMa4Vj';
const TOKEN_PATH = '/oauth2/token';

// The mower stays listening ~10 s after a sync: re-sync past 7 s (PyMammotion).
const SYNC_INTERVAL_MS = 7_000;
// Automatic report requests, at most this often per mower. Each one counts in
// the cloud quota (about 600 messages / 12 h), and replaces the report
// subscription of the Mammotion app, which then shows the mower disconnected.
const REPORT_REQUEST_INTERVAL_MS = 5 * 60_000;
// A report this recent means the mower is already streaming (app open, job
// running): no need to ask, and asking would cut the app's stream.
const REPORT_FRESH_MS = 15_000;
// Wait for the answer to a zone list or route request.
const NAV_ANSWER_TIMEOUT_MS = 15_000;
// Gap between two commands sent in a row (sendCommands).
const COMMAND_GAP_MS = 2_000;
// A map element list in more frames than this is not believed.
const MAX_HASH_FRAMES = 50;
// DEV_NAVIGATION: the mowers that list their zones (all but the Luba 1).
const NAVIGATION_BOARD = 17;

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
    // iotId -> time (ms) of the last sync / report request sent.
    this.lastSyncAt = new Map();
    this.lastReportRequestAt = new Map();
    this.navTimeoutMs = NAV_ANSWER_TIMEOUT_MS;
    // iotId -> Map(hash -> { type, name }): map elements already read.
    this.mapElements = new Map();
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
   * @param {{ force?: boolean }} [options] force: ask a broker mower for a
   *   report even if one was asked less than REPORT_REQUEST_INTERVAL_MS ago
   */
  async getStatus(mower, { force = false } = {}) {
    if (mower.cloud === 'mammotion') {
      return this.getMqttStatus(mower, force);
    }
    try {
      return await this.getAliyunStatus(mower);
    } catch (err) {
      if (!isNotBoundError(err)) throw err;
      logger.info(`${mower.name} is not on Aliyun, switching to the Mammotion broker`);
      mower.cloud = 'mammotion';
      return this.getMqttStatus(mower, force);
    }
  }

  /**
   * Mammotion broker: last values pushed by the mower (null fields if none yet).
   * Also asks the mower for a fresh report when needed: on its own it only
   * posts its state now and then (up to an hour apart); the answer arrives on
   * the broker within seconds and is published by the onMqttUpdate callback.
   */
  async getMqttStatus(mower, force = false) {
    await this.mqtt.watch(mower);
    if (this.shouldRequestReport(mower, force)) {
      await this.requestReport(mower).catch((err) => {
        if (isAuthError(err)) throw err;
        logger.warn(`Report request refused for ${mower.name}: ${err.message}`);
      });
    }
    return this.mqtt.getStatus(mower.iotId) ?? { ...EMPTY_STATUS };
  }

  shouldRequestReport(mower, force) {
    const now = Date.now();
    if (now - this.mqtt.lastReportAt(mower.iotId) < REPORT_FRESH_MS) {
      return false;
    }
    const lastRequest = this.lastReportRequestAt.get(mower.iotId) ?? 0;
    return force || now - lastRequest >= REPORT_REQUEST_INTERVAL_MS;
  }

  /** Ask a mower of the Mammotion broker to push its state now. */
  async requestReport(mower) {
    this.lastReportRequestAt.set(mower.iotId, Date.now());
    return this.withRetry(async () => {
      const session = await this.ensureSession();
      if (!session.iotDomain) {
        throw new Error('Mammotion API unavailable: no iot domain in the access token');
      }
      await this.sync(session, mower);
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
   * Send a task control command (start, pause, resume, stop, dock, cancelDock),
   * after a sync so that the mower listens.
   */
  async sendCommand(mower, command) {
    return this.withRetry(async () => {
      const session = await this.ensureSession();
      const content = buildTaskControlContent(command, session, mower);
      logger.info(`Sending "${command}" to ${mower.name}`);
      await this.sync(session, mower);
      await this.invoke(session, mower, content);
    });
  }

  /**
   * Send several task control commands in a row, with a short gap so the
   * mower handles each one (e.g. "stop" then "dock" on a paused job).
   */
  async sendCommands(mower, commands, gapMs = COMMAND_GAP_MS) {
    for (const [i, command] of commands.entries()) {
      if (i > 0 && gapMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
      await this.sendCommand(mower, command);
    }
  }

  /**
   * Start a new mowing job, as the app and Home Assistant do: a bare "start"
   * without a route upsets the mower. A job stopped halfway is carried on
   * (its route is read back); otherwise a route is planned over the zones of
   * the map (all of them, or those named in the configuration) with the mowing
   * settings of the configuration, then the job starts.
   * The answers come on the Mammotion broker: only its mowers can do it.
   * @param {{ iotId: string, name: string, cloud?: string, productKey?: string, deviceName?: string }} mower
   * @param {object} settings normalized configuration (see config.js)
   */
  async startJob(mower, settings) {
    if (mower.cloud !== 'mammotion' || receiverFor(mower) !== NAVIGATION_BOARD) {
      throw new Error('This mower cannot start a new job from Gladys: use the Mammotion app');
    }
    await this.mqtt.watch(mower);
    const status = this.mqtt.getStatus(mower.iotId) ?? {};
    return this.withRetry(async () => {
      const session = await this.ensureSession();
      if (status.interruptedJob) {
        logger.info(`${mower.name}: carrying on the interrupted job`);
        await this.navRequest(session, mower, buildRouteQueryContent(session, mower), (nav) =>
          parseRouteAnswer(nav, 2),
        );
      } else {
        const zones = selectZones(await this.listZones(session, mower), settings);
        logger.info(
          `${mower.name}: planning a route over ${zones.length} zone(s) ` +
            `(${zones.map((z) => z.name).join(', ')}), blade at ${settings.blade_height} mm, ` +
            `${settings.mowing_speed} m/s, ${settings.line_spacing} cm, ${settings.mowing_angle}°, ` +
            `${settings.mowing_pattern}, ${settings.border_laps} border lap(s), ` +
            `obstacle detection ${settings.obstacle_detection}`,
        );
        const content = buildRouteContent(session, mower, {
          zones: zones.map((z) => z.hash),
          settings,
        });
        const answer = await this.navRequest(session, mower, content, (nav) =>
          parseRouteAnswer(nav, 0),
        );
        // The mower often takes the route without answering (Mammotion-HA #848).
        logger.info(
          answer
            ? `${mower.name}: route planned (result ${answer.result})`
            : `${mower.name}: no answer to the route, starting anyway`,
        );
      }
      logger.info(`Sending "start" to ${mower.name}`);
      await this.sync(session, mower);
      await this.invoke(session, mower, buildTaskControlContent('start', session, mower));
    });
  }

  /**
   * Every mowing zone of the map, named or not. The zone name list of the
   * mower only holds the zones named in the app: the full list comes from the
   * hashes of the map elements, whose type is read once (zones, no-go zones,
   * paths…). Falls back on the named zones if the mower does not send its hashes.
   * @returns {Promise<Array<{ hash: bigint, name: string }>>}
   */
  async listZones(session, mower) {
    const named = await this.navRequest(
      session,
      mower,
      buildZoneListRequestContent(session, mower),
      parseZoneList,
    );
    const hashes = await this.readMapHashes(session, mower);
    if (!hashes) {
      logger.warn(`${mower.name}: no map element list, only the named zones are mowed`);
      if (!named || named.length === 0) {
        throw new Error(
          named ? 'No zone on the mower map' : 'The mower did not send its zones, try again',
        );
      }
      return named.map((z, i) => ({ hash: z.hash, name: z.name || `zone ${i + 1}` }));
    }
    const names = new Map((named ?? []).map((z) => [z.hash, z.name]));
    const known = this.mapElements.get(mower.iotId) ?? new Map();
    this.mapElements.set(mower.iotId, known);
    const zones = [];
    let answering = true;
    for (const hash of hashes) {
      // The name list only holds zones: no need to ask for their type.
      if (!names.has(hash) && !known.has(hash) && answering) {
        const element = await this.navRequest(
          session,
          mower,
          buildMapElementRequestContent(session, mower, hash),
          (nav) => parseMapElement(nav, hash),
        );
        if (element) {
          known.set(hash, element);
        } else {
          logger.warn(`${mower.name}: map element ${hash} not received, the others are skipped`);
          answering = false;
        }
      }
      if (names.has(hash) || known.get(hash)?.type === MAP_ELEMENT_ZONE) {
        zones.push({ hash, name: names.get(hash) || known.get(hash)?.name || '' });
      }
    }
    zones.forEach((zone, i) => {
      zone.name ||= `zone ${i + 1}`;
    });
    if (zones.length === 0) {
      throw new Error('No zone on the mower map');
    }
    return zones;
  }

  /**
   * Hashes of every element of the map, read frame by frame, or null when the
   * mower does not send them all.
   * @returns {Promise<bigint[] | null>}
   */
  async readMapHashes(session, mower) {
    const frames = new Map();
    let ack = await this.navRequest(
      session,
      mower,
      buildHashListRequestContent(session, mower),
      parseHashList,
    );
    while (ack) {
      frames.set(ack.currentFrame, ack.hashes);
      const total = Math.min(ack.totalFrame, MAX_HASH_FRAMES);
      let missing = null;
      for (let frame = 1; frame <= total; frame++) {
        if (!frames.has(frame)) {
          missing = frame;
          break;
        }
      }
      if (missing === null) {
        return [...new Set([...frames.values()].flat())];
      }
      ack = await this.navRequest(
        session,
        mower,
        buildHashListRequestContent(session, mower, {
          totalFrame: ack.totalFrame,
          currentFrame: missing - 1,
        }),
        (nav) => {
          const next = parseHashList(nav);
          return next?.currentFrame === missing ? next : null;
        },
      );
    }
    return null;
  }

  /** Send a nav request and wait for its answer on the broker (null on timeout). */
  async navRequest(session, mower, content, match) {
    const answer = this.mqtt.waitForNav(mower.iotId, match, this.navTimeoutMs);
    await this.sync(session, mower);
    await this.invoke(session, mower, content);
    return answer;
  }

  /**
   * Wake the cloud link of the mower (see buildSyncContent), unless done less
   * than SYNC_INTERVAL_MS ago. A refused sync is not fatal: the order follows.
   */
  async sync(session, mower) {
    if (Date.now() - (this.lastSyncAt.get(mower.iotId) ?? 0) < SYNC_INTERVAL_MS) {
      return;
    }
    try {
      await this.invoke(session, mower, buildSyncContent(session));
      this.lastSyncAt.set(mower.iotId, Date.now());
    } catch (err) {
      if (isAuthError(err)) throw err;
      logger.debug(`Sync refused by ${mower.name}: ${err.message}`);
    }
  }

  /** Send a protobuf `content` to a mower: Mammotion API first, then Aliyun. */
  async invoke(session, mower, content) {
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
  }

  stop() {
    this.mqtt.stop();
  }
}

/**
 * Zones to mow: those named in the configuration (case does not matter), or
 * all of them.
 */
export function selectZones(zones, settings) {
  const wanted = mowingZoneNames(settings);
  if (wanted.length === 0) {
    return zones;
  }
  const selected = zones.filter((z) => wanted.includes(z.name.toLowerCase()));
  if (selected.length === 0) {
    throw new Error(
      `None of the zones "${settings.mowing_zones}" is on the map ` +
        `(${zones.map((z) => z.name).join(', ')})`,
    );
  }
  return selected;
}
