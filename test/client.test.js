// -----------------------------------------------------------------------------
// MammotionClient against a fake `fetch`: no network, only the request flow.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MammotionClient, isAuthError, isRtkBaseStation } from '../src/mammotion/client.js';
import { HttpError } from '../src/mammotion/http.js';
import { signHeaders } from '../src/mammotion/aliyun.js';
import { decodeMessage } from '../src/mammotion/protobuf.js';

// Top-level fields of a base64 LubaMsg (varints as bigints).
const luba = (content) =>
  Object.fromEntries(
    Object.entries(decodeMessage(Buffer.from(content, 'base64'))).map(([k, v]) => [k, v[0]]),
  );

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

test('isAuthError recognizes the usual auth failures', () => {
  assert.ok(isAuthError(new HttpError('nope', 401)));
  assert.ok(isAuthError(Object.assign(new Error('x'), { aliyunCode: 460 })));
  assert.ok(isAuthError(new Error('Token expired')));
  assert.ok(!isAuthError(new Error('Invalid device')));
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
