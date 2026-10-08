// -----------------------------------------------------------------------------
// MammotionClient against a fake `fetch`: no network, only the request flow.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MammotionAuthError,
  MammotionClient,
  isAuthError,
  isRtkBaseStation,
  selectZones,
} from '../src/mammotion/client.js';
import { normalizeConfig } from '../src/config.js';
import { HttpError } from '../src/mammotion/http.js';
import { signHeaders } from '../src/mammotion/aliyun.js';
import { parseHashList, parseZoneList } from '../src/mammotion/report.js';
import {
  bytesField,
  decodeMessage,
  encodeVarint,
  floatField,
  message,
  varintField,
} from '../src/mammotion/protobuf.js';

// Top-level fields of a base64 LubaMsg (varints as bigints).
const luba = (content) =>
  Object.fromEntries(
    Object.entries(decodeMessage(Buffer.from(content, 'base64'))).map(([k, v]) => [k, v[0]]),
  );

// NavTaskCtrl.action of a base64 task control command.
const taskAction = (content) => {
  const nav = decodeMessage(Buffer.from(content, 'base64'))[11][0];
  return decodeMessage(decodeMessage(nav)[37][0])[2][0];
};

const realFetch = globalThis.fetch;
let calls;
let routes;

function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  routes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body && !String(init.body).startsWith('loginByOauth') ? init.body : null;
    const call = { host: u.host, path: u.pathname, query: u.searchParams, init, body };
    calls.push(call);
    const route = routes.find((r) => r.match(call));
    if (!route) throw new Error(`unexpected request ${u.host}${u.pathname}`);
    return route.reply(call);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function on(host, path, reply) {
  routes.push({ match: (c) => c.host === host && c.path === path, reply });
}

function mockLogin() {
  on('id.mammotion.com', '/oauth2/token', () =>
    json({
      code: 0,
      data: {
        access_token: jwt({ iot: 'api-iot.mammotion.com', areaCode: 'FR' }),
        expires_in: 3600,
        authorization_code: 'auth-code',
        userInformation: { userAccount: '4242', domainAbbreviation: 'FR' },
      },
    }),
  );
}

function mockAliyun({ properties } = {}) {
  on('api.link.aliyun.com', '/living/account/region/get', () =>
    json({
      code: 200,
      data: {
        apiGatewayEndpoint: 'eu-central-1.api-iot.aliyuncs.com',
        oaApiGatewayEndpoint: 'oa.example',
      },
    }),
  );
  on('sdk.openaccount.aliyun.com', '/api/prd/connect.json', () =>
    json({ data: { vid: 'vid-1', data: { device: { data: { deviceId: 'dev-1' } } } } }),
  );
  on('oa.example', '/api/prd/loginbyoauth.json', () =>
    json({ data: { data: { loginSuccessResult: { sid: 'sid-1' } } } }),
  );
  on('eu-central-1.api-iot.aliyuncs.com', '/account/createSessionByAuthCode', () =>
    json({ code: 200, data: { iotToken: 'iot-token', iotTokenExpire: 7200 } }),
  );
  on('eu-central-1.api-iot.aliyuncs.com', '/uc/listBindingByAccount', () =>
    json({
      code: 200,
      data: {
        data: [
          {
            iotId: 'iot-1',
            nickName: 'Luba',
            productKey: 'a1iMygIwxFC',
            deviceName: 'Luba-X',
            status: 1,
          },
          { iotId: 'iot-rtk', deviceName: 'RTK-1', productKey: 'a1qXkZ5P39W', status: 1 },
        ],
      },
    }),
  );
  on('eu-central-1.api-iot.aliyuncs.com', '/thing/properties/get', () =>
    json({
      code: 200,
      data: properties ?? { batteryPercentage: { value: 64 }, deviceState: { value: 15 } },
    }),
  );
  on('eu-central-1.api-iot.aliyuncs.com', '/thing/status/get', () =>
    json({ code: 200, data: { status: 1 } }),
  );
  on('eu-central-1.api-iot.aliyuncs.com', '/thing/service/invoke', () =>
    json({ code: 200, data: { messageId: 'm1' } }),
  );
}

test('login signs the OAuth request and reads the iot domain from the token', async () => {
  mockLogin();
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const session = await client.login();
  assert.equal(session.iotDomain, 'https://api-iot.mammotion.com');
  assert.equal(session.userAccount, '4242');
  const call = calls[0];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.query.get('username'), 'me@example.com');
  assert.match(call.init.headers['Ma-Signature'], /^[0-9a-f]{64}$/);
});

test('login fails with a clear message on bad credentials', async () => {
  on('id.mammotion.com', '/oauth2/token', () => json({ code: 1, msg: 'wrong password' }));
  const client = new MammotionClient({ email: 'me@example.com', password: 'bad' });
  await assert.rejects(client.login(), /wrong password/);
});

test('listMowers merges the sources and drops RTK base stations', async () => {
  mockLogin();
  mockAliyun();
  on('domestic.mammotion.com', '/device-server/v1/device/list', () =>
    json({
      code: 0,
      data: [
        { iotId: 'iot-1', deviceName: 'Luba-X', productSeries: 'Luba 2' },
        { iotId: 'iot-2', deviceName: 'Luba-VPMBS8RA', productSeries: 'Luba' },
      ],
    }),
  );
  on('api-iot.mammotion.com', '/v1/user/device/page', () =>
    json({
      code: 0,
      data: { records: [{ iotId: 'iot-2', productKey: 'pk2', deviceName: 'Luba-VPMBS8RA' }] },
    }),
  );

  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const mowers = await client.listMowers();
  assert.equal(mowers.length, 2);
  assert.deepEqual(mowers[0], {
    iotId: 'iot-1',
    name: 'Luba',
    productKey: 'a1iMygIwxFC',
    deviceName: 'Luba-X',
    series: 'Luba 2',
    online: true,
    cloud: 'aliyun',
  });
  // Not bound on Aliyun: followed on the Mammotion broker.
  assert.equal(mowers[1].cloud, 'mammotion');
  assert.equal(mowers[1].productKey, 'pk2');
});

test('getStatus switches to the Mammotion broker when Aliyun says "not bind"', async () => {
  mockLogin();
  mockAliyun();
  routes.unshift({
    match: (c) => c.path === '/thing/properties/get',
    reply: () => json({ code: 2064, message: 'user device not bind' }),
  });
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const watched = [];
  client.mqtt = {
    watch: async (m) => watched.push(m.iotId),
    getStatus: () => ({ battery: 80, workMode: 15, online: true }),
    lastReportAt: () => 0,
  };
  const mower = { iotId: 'iot-2', name: 'Luba', deviceName: 'dn' };
  on('api-iot.mammotion.com', '/v1/mqtt/rpc/thing/service/invoke', () =>
    json({ code: 0, data: {} }),
  );
  const status = await client.getStatus(mower);
  assert.equal(status.battery, 80);
  assert.equal(mower.cloud, 'mammotion');
  assert.deepEqual(watched, ['iot-2']);
  // The mower is woken up (sync), then asked to push a fresh report.
  const invokes = calls.filter((c) => c.path === '/v1/mqtt/rpc/thing/service/invoke');
  assert.equal(invokes.length, 2);
  const contents = invokes.map((c) => JSON.parse(c.init.body));
  assert.equal(contents[1].deviceName, 'dn');
  assert.equal(luba(contents[0].args.content)[1], 248n); // MSG_CMD_TYPE_ESP (sync)
  assert.equal(luba(contents[1].args.content)[1], 244n); // EMBED_SYS (report request)
});

test('report requests are spaced out and skipped while the mower streams', async () => {
  mockLogin();
  on('api-iot.mammotion.com', '/v1/mqtt/rpc/thing/service/invoke', () =>
    json({ code: 0, data: {} }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  let reportAt = 0;
  client.mqtt = {
    watch: async () => {},
    getStatus: () => null,
    lastReportAt: () => reportAt,
  };
  const mower = { iotId: 'iot-2', name: 'Luba', deviceName: 'dn', cloud: 'mammotion' };
  const reportRequests = () =>
    calls.filter(
      (c) =>
        c.path === '/v1/mqtt/rpc/thing/service/invoke' &&
        luba(JSON.parse(c.init.body).args.content)[1] === 244n,
    ).length;

  const status = await client.getStatus(mower);
  assert.equal(status.battery, null);
  assert.equal(reportRequests(), 1);
  // Next poll a minute later: no new request (the cloud quota is limited).
  await client.getStatus(mower);
  assert.equal(reportRequests(), 1);
  // After a command, a refresh is forced.
  await client.getStatus(mower, { force: true });
  assert.equal(reportRequests(), 2);
  // The mower is streaming (app open): never ask, it would cut the stream.
  reportAt = Date.now();
  await client.getStatus(mower, { force: true });
  assert.equal(reportRequests(), 2);
});

test('getMqttCredentials reads the broker JWT from the iot domain', async () => {
  mockLogin();
  on('api-iot.mammotion.com', '/v1/mqtt/auth/jwt', () =>
    json({
      code: 0,
      data: { host: 'mqtts://b.example:8883', jwt: 'j', clientId: 'c', username: 'u' },
    }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const creds = await client.getMqttCredentials();
  assert.equal(creds.jwt, 'j');
  assert.equal(calls.at(-1).init.headers.Authorization.startsWith('Bearer '), true);
});

test('getStatus parses the properties and asks for the connectivity', async () => {
  mockLogin();
  mockAliyun();
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const status = await client.getStatus({ iotId: 'iot-1', name: 'Luba' });
  assert.equal(status.battery, 64);
  assert.equal(status.workMode, 15);
  assert.equal(status.online, true);
  const props = calls.find((c) => c.path === '/thing/properties/get');
  const body = JSON.parse(props.init.body);
  assert.equal(body.request.iotToken, 'iot-token');
  assert.equal(body.params.iotId, 'iot-1');
  assert.ok(props.init.headers['x-ca-signature']);
});

test('sendCommand falls back to the Aliyun gateway when Mammotion refuses', async () => {
  mockLogin();
  mockAliyun();
  on('api-iot.mammotion.com', '/v1/mqtt/rpc/thing/service/invoke', () =>
    json({ code: 50100, msg: 'Invalid device' }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  await client.sendCommand(
    { iotId: 'iot-1', name: 'Luba', productKey: 'pk', deviceName: 'dn' },
    'dock',
  );
  const invoke = calls.find((c) => c.path === '/thing/service/invoke');
  const body = JSON.parse(invoke.init.body);
  assert.equal(body.params.identifier, 'device_protobuf_sync_service');
  assert.ok(body.params.args.content.length > 10);
});

test('sendCommand syncs the mower then uses the Mammotion API', async () => {
  mockLogin();
  on('api-iot.mammotion.com', '/v1/mqtt/rpc/thing/service/invoke', () =>
    json({ code: 0, data: { result: 'ok' } }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const mower = { iotId: 'iot-1', name: 'Luba', productKey: 'pk', deviceName: 'dn' };
  await client.sendCommand(mower, 'resume');
  assert.equal(calls.filter((c) => c.host.includes('aliyun')).length, 0);
  const types = () =>
    calls
      .filter((c) => c.path === '/v1/mqtt/rpc/thing/service/invoke')
      .map((c) => luba(JSON.parse(c.init.body).args.content)[1]);
  assert.deepEqual(types(), [248n, 240n]); // sync, then the NAV command
  // A second command right after: the mower is still synced.
  await client.sendCommand(mower, 'pause');
  assert.deepEqual(types(), [248n, 240n, 240n]);
});

test('sendCommands sends stop then dock, in that order', async () => {
  mockLogin();
  on('api-iot.mammotion.com', '/v1/mqtt/rpc/thing/service/invoke', () =>
    json({ code: 0, data: {} }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const mower = { iotId: 'iot-1', name: 'Luba', productKey: 'pk', deviceName: 'dn' };
  await client.sendCommands(mower, ['stop', 'dock'], 0);
  const navs = calls
    .filter((c) => c.path === '/v1/mqtt/rpc/thing/service/invoke')
    .map((c) => JSON.parse(c.init.body).args.content)
    .filter((content) => luba(content)[1] === 240n);
  assert.equal(navs.length, 2);
  const actions = navs.map((content) => taskAction(content));
  assert.deepEqual(actions, [4n, 5n]);
});

test('a refused sync does not block the command', async () => {
  mockLogin();
  on('api-iot.mammotion.com', '/v1/mqtt/rpc/thing/service/invoke', (c) =>
    luba(JSON.parse(c.body).args.content)[1] === 248n
      ? json({ code: 20056, msg: 'Device not responding' })
      : json({ code: 0, data: {} }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  await client.sendCommand(
    { iotId: 'iot-1', name: 'Luba', deviceName: 'dn', cloud: 'mammotion' },
    'dock',
  );
  assert.equal(calls.filter((c) => c.path === '/v1/mqtt/rpc/thing/service/invoke').length, 2);
});

test('an expired session triggers one new login', async () => {
  mockLogin();
  mockAliyun();
  let first = true;
  routes.unshift({
    match: (c) => c.path === '/thing/properties/get' && first,
    reply: () => {
      first = false;
      return json({ code: 460, message: 'identityId is blank' });
    },
  });
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const status = await client.getStatus({ iotId: 'iot-1', name: 'Luba' });
  assert.equal(status.battery, 64);
  assert.equal(calls.filter((c) => c.path === '/oauth2/token').length, 2);
});

test('isAuthError goes by the type of the error, not by its wording', () => {
  assert.ok(isAuthError(new HttpError('nope', 401)));
  assert.ok(isAuthError(new HttpError('nope', 403)));
  assert.ok(isAuthError(new MammotionAuthError('identityId is blank', { code: 29003 })));
  assert.ok(!isAuthError(new HttpError('down', 502)));
  assert.ok(!isAuthError(new Error('Invalid device')));
  // Our own errors, whatever words they hold.
  assert.ok(
    !isAuthError(new Error('Mammotion API unavailable: no iot domain in the access token')),
  );
  assert.ok(!isAuthError(new Error('Aliyun session creation failed')));
});

test('the cloud answers that refuse the session are auth errors', async () => {
  mockLogin();
  mockAliyun();
  routes.unshift({
    match: (c) => c.path === '/thing/status/get',
    reply: () => json({ code: 29003, message: 'identityId is blank' }),
  });
  on('api-iot.mammotion.com', '/v1/mqtt/auth/jwt', () => json({ code: 401, msg: 'expired' }));
  on('domestic.mammotion.com', '/device-server/v1/device/list', () =>
    json({ code: 500, msg: 'Token expired' }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  await assert.rejects(client.aliyunCall('/thing/status/get', '1.0.0', {}), (err) =>
    isAuthError(err),
  );
  await assert.rejects(
    client.mammotionPost('https://api-iot.mammotion.com/v1/mqtt/auth/jwt', {}),
    (err) => isAuthError(err),
  );
  await assert.rejects(
    client.mammotionGet('https://domestic.mammotion.com/device-server/v1/device/list'),
    (err) => isAuthError(err),
  );
});

test('an internal error is not taken for an expired session', async () => {
  // An access token without the `iot` claim: the broker cannot be reached.
  on('id.mammotion.com', '/oauth2/token', () =>
    json({ code: 0, data: { access_token: jwt({ areaCode: 'FR' }), expires_in: 3600 } }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  await assert.rejects(client.getMqttCredentials(), (err) => {
    assert.match(err.message, /no iot domain/);
    assert.ok(!isAuthError(err));
    return true;
  });
  await assert.rejects(client.requestReport({ iotId: 'iot-1', name: 'Luba' }), /no iot domain/);
  // One login for both: no new login for an error a login cannot cure.
  assert.equal(calls.filter((c) => c.path === '/oauth2/token').length, 1);
});

test('simultaneous calls share one login and one Aliyun session', async () => {
  mockLogin();
  mockAliyun();
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const mower = { iotId: 'iot-1', name: 'Luba' };
  const statuses = await Promise.all([
    client.getStatus(mower),
    client.getStatus(mower),
    client.getStatus(mower),
  ]);
  assert.deepEqual(
    statuses.map((s) => s.battery),
    [64, 64, 64],
  );
  assert.equal(calls.filter((c) => c.path === '/oauth2/token').length, 1);
  assert.equal(calls.filter((c) => c.path === '/account/createSessionByAuthCode').length, 1);
});

test('a failed login is not kept: the next call tries again', async () => {
  let fail = true;
  on('id.mammotion.com', '/oauth2/token', () =>
    fail
      ? json({ code: 1, msg: 'wrong password' })
      : json({ code: 0, data: { access_token: jwt({ iot: 'x' }), expires_in: 3600 } }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  await assert.rejects(Promise.all([client.ensureSession(), client.ensureSession()]));
  assert.equal(calls.length, 1);
  fail = false;
  await client.ensureSession();
  assert.equal(calls.length, 2);
});

test('isRtkBaseStation', () => {
  assert.ok(isRtkBaseStation({ productKey: 'a1qXkZ5P39W' }));
  assert.ok(isRtkBaseStation({ name: 'RTK-abc' }));
  assert.ok(!isRtkBaseStation({ name: 'Luba-abc', productKey: 'a1iMygIwxFC' }));
});

test('signHeaders only lists the non-positional headers', () => {
  const headers = signHeaders('POST', '/x', {
    date: 'Mon, 01 Jan 2024 00:00:00 GMT',
    accept: 'application/json',
    'content-type': 'application/octet-stream',
    'x-ca-key': 'k',
    'x-ca-nonce': 'n',
  });
  assert.equal(headers['x-ca-signature-headers'], 'x-ca-key,x-ca-nonce');
  assert.match(headers['x-ca-signature'], /^[A-Za-z0-9+/]+=*$/);
});

// A broker mower that answers the nav requests the way a Luba 2 does. Its map:
// two named zones, one zone without a name (its outline in two frames) and
// one no-go zone, whose hashes come in two frames.
const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
const MAP = [
  { hash: 11n, type: 0, named: 'Avant', frames: [SQUARE] },
  { hash: 2n ** 63n + 5n, type: 0, named: 'Arrière', frames: [SQUARE] },
  { hash: 21n, type: 0, frames: [SQUARE.slice(0, 2), SQUARE.slice(2)] },
  { hash: 31n, type: 1, frames: [SQUARE] },
];

function startJobFixture({ status = {}, answerZones = true, answerHashes = true } = {}) {
  mockLogin();
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const mqtt = client.mqtt;
  // Only the requests this fake mower ignores time out quickly: an answered
  // one must never expire, even on a slow CI runner (the first test of the
  // file once lost the zone names to a 20 ms timeout).
  const waitForNav = mqtt.waitForNav.bind(mqtt);
  mqtt.waitForNav = (iotId, match) => {
    const ignored =
      (match === parseZoneList && !answerZones) || (match === parseHashList && !answerHashes);
    return waitForNav(iotId, match, ignored ? 20 : 2_000);
  };
  mqtt.watch = async () => {};
  mqtt.devices.set('Luba-VPMBS8RA', { iotId: 'iot-2', productKey: 'pk' });
  mqtt.getStatus = () => status;
  const answer = (nav) =>
    mqtt.handleMessage(
      '/sys/pk/Luba-VPMBS8RA/thing/event/device_protobuf_msg_event/post',
      Buffer.from(
        JSON.stringify({
          params: { content: message(varintField(1, 240), bytesField(11, nav)).toString('base64') },
        }),
      ),
    );
  const hashFrame = (frame, hashes) =>
    bytesField(
      31,
      message(
        varintField(3, 2),
        varintField(4, frame),
        bytesField(13, Buffer.concat(hashes.map((h) => encodeVarint(h)))),
      ),
    );
  const sent = [];
  on('api-iot.mammotion.com', '/v1/mqtt/rpc/thing/service/invoke', (c) => {
    const msg = decodeMessage(Buffer.from(JSON.parse(c.body).args.content, 'base64'));
    const nav = msg[11] ? decodeMessage(msg[11][0]) : null;
    sent.push(nav ? Number(Object.keys(nav)[0]) : `type ${msg[1][0]}`);
    if (nav?.[58] && answerZones) {
      const zone = (hash, name) =>
        bytesField(2, message(fixed64(1, hash), bytesField(2, Buffer.from(name))));
      const named = MAP.filter((e) => e.named).map((e) => zone(e.hash, e.named));
      setImmediate(() => answer(bytesField(61, message(...named))));
    }
    if (nav?.[30] && answerHashes) {
      const frame = decodeMessage(nav[30][0])[4]?.[0] ?? 0n;
      const hashes = MAP.map((e) => e.hash);
      setImmediate(() =>
        answer(frame === 0n ? hashFrame(1, hashes.slice(0, 2)) : hashFrame(2, hashes.slice(2))),
      );
    }
    if (nav?.[32]) {
      const request = decodeMessage(nav[32][0]);
      const hash = request[5][0];
      // subCmd 1: first frame; subCmd 2: the frame after currentFrame.
      const frame = request[2][0] === 2n ? Number(request[9][0]) + 1 : 1;
      const element = MAP.find((e) => e.hash === hash);
      const couples = element.frames[frame - 1].map(([x, y]) =>
        bytesField(13, message(floatField(1, x), floatField(2, y))),
      );
      setImmediate(() =>
        answer(
          bytesField(
            33,
            message(
              varintField(4, 8),
              varintField(5, element.type),
              fixed64(6, hash),
              varintField(9, element.frames.length),
              varintField(10, frame),
              ...couples,
            ),
          ),
        ),
      );
    }
    if (nav?.[34]) {
      const route = decodeMessage(nav[34][0]);
      const subCmd = route[5]?.[0] ?? 0n;
      setImmediate(() => answer(bytesField(34, message(varintField(5, subCmd)))));
    }
    return json({ code: 0, data: {} });
  });
  const mower = {
    iotId: 'iot-2',
    name: 'Luba',
    productKey: 'pk',
    deviceName: 'Luba-VPMBS8RA',
    cloud: 'mammotion',
  };
  return { client, mower, sent };
}

// A fixed64 field, for the fake answers.
function fixed64(field, value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return Buffer.concat([Buffer.from([(field << 3) | 1]), buf]);
}

function sentRoute() {
  const routeCall = calls
    .filter((c) => c.path === '/v1/mqtt/rpc/thing/service/invoke')
    .map((c) => decodeMessage(Buffer.from(JSON.parse(c.body).args.content, 'base64')))
    .find((m) => m[11] && decodeMessage(m[11][0])[34]);
  return decodeMessage(decodeMessage(routeCall[11][0])[34][0]);
}

const zoneHashes = (route) => {
  const zones = route[13][0];
  return Array.from({ length: zones.length / 8 }, (_, i) => zones.readBigUInt64LE(i * 8));
};

test('startJob plans a route over every zone of the map, named or not, then starts', async () => {
  const { client, mower, sent } = startJobFixture({ status: { bladeHeightMm: 50 } });
  await client.startJob(mower, normalizeConfig());
  // sync, zone names (58), 2 frames of hashes (30), the 4 map elements (32) and the
  // second frame of the outline of zone 21 (32), route (34), start (37)
  assert.deepEqual(sent, ['type 248', 58, 30, 30, 32, 32, 32, 32, 32, 34, 37]);
  const route = sentRoute();
  assert.equal(route[7][0], 60n); // blade height of the configuration
  assert.deepEqual(zoneHashes(route), [11n, 2n ** 63n + 5n, 21n]);
});

test('readZones reads the zones of the map and reports them', async () => {
  const { client, mower, sent } = startJobFixture();
  const reported = [];
  client.onZones = (m, zones) => reported.push([m.iotId, zones.map((z) => z.name)]);
  const zones = await client.readZones(mower);
  assert.equal(zones.length, 3);
  assert.deepEqual(reported, [['iot-2', zones.map((z) => z.name)]]);
  // Only zone requests: no route, no start.
  assert.ok(!sent.includes(34) && !sent.includes(37));
  await assert.rejects(client.readZones({ ...mower, cloud: 'aliyun' }), /does not list/);
});

test('the map keeps the outline of the zones and no-go zones', async () => {
  const { client, mower } = startJobFixture();
  assert.equal(client.getMap(mower), null);
  await client.readZones(mower);
  const map = client.getMap(mower);
  assert.deepEqual(
    map.zones.map((z) => [z.name, z.points.length]),
    [
      ['Avant', 4],
      ['Arrière', 4],
      // Unnamed: numbered from 0, as the app does.
      ['Zone 2', 4],
    ],
  );
  assert.deepEqual(map.zones[2].points[2], { x: 10, y: 10 });
  assert.equal(map.obstacles.length, 1);
});

test('startJob reads a map element only once', async () => {
  const { client, mower, sent } = startJobFixture();
  await client.startJob(mower, normalizeConfig());
  sent.length = 0;
  await client.startJob(mower, normalizeConfig());
  assert.ok(!sent.includes(32));
});

test('startJob mows only the zones named in the configuration', async () => {
  const { client, mower } = startJobFixture();
  await client.startJob(mower, normalizeConfig({ mowing_zones: 'arrière, Zone 2' }));
  assert.deepEqual(zoneHashes(sentRoute()), [2n ** 63n + 5n, 21n]);
});

// The nav answer timers do not hold the event loop: keep it alive meanwhile.
async function withTimeouts(promise) {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

test('startJob falls back on the named zones without the map element list', async () => {
  const { client, mower } = startJobFixture({ answerHashes: false });
  await withTimeouts(client.startJob(mower, normalizeConfig()));
  assert.deepEqual(zoneHashes(sentRoute()), [11n, 2n ** 63n + 5n]);
});

test('startJob carries on an interrupted job instead of planning a new one', async () => {
  const { client, mower, sent } = startJobFixture({ status: { interruptedJob: true } });
  await client.startJob(mower, normalizeConfig());
  assert.deepEqual(sent, ['type 248', 34, 37]);
});

test('startJob does not start without the zones of the map', async () => {
  const { client, mower, sent } = startJobFixture({ answerZones: false, answerHashes: false });
  await assert.rejects(
    withTimeouts(client.startJob(mower, normalizeConfig())),
    /did not send its zones/,
  );
  assert.ok(!sent.includes(37));
});

test('selectZones refuses names that are not on the map', () => {
  const zones = [{ hash: 1n, name: 'Avant' }];
  assert.deepEqual(selectZones(zones, normalizeConfig()), zones);
  // Zone switch keys and names match whatever the case and the accents.
  const sud = [{ hash: 2n, name: 'Côté Sud' }, ...zones];
  assert.deepEqual(selectZones(sud, normalizeConfig({ mowing_zones: 'cote-sud' })), [sud[0]]);
  assert.deepEqual(selectZones(sud, normalizeConfig({ mowing_zones: 'COTE SUD' })), [sud[0]]);
  assert.throws(() => selectZones(zones, normalizeConfig({ mowing_zones: 'Potager' })), /Avant/);
});

test('selectZones keeps the order in which the zones were chosen', () => {
  const zones = [
    { hash: 1n, name: 'Derrière' },
    { hash: 2n, name: 'Bas' },
    { hash: 3n, name: 'Devant' },
  ];
  const picked = selectZones(zones, normalizeConfig({ mowing_zones: 'devant,derriere,devant' }));
  assert.deepEqual(
    picked.map((z) => z.name),
    ['Devant', 'Derrière'],
  );
});

test('startJob is refused for the mowers of the Aliyun gateway', async () => {
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  await assert.rejects(
    client.startJob({ iotId: 'iot-1', name: 'Luba', deviceName: 'Luba-VS1', cloud: 'aliyun' }),
    /Mammotion app/,
  );
});
