// -----------------------------------------------------------------------------
// MammotionClient against a fake `fetch`: no network, only the request flow.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MammotionClient, isAuthError, isRtkBaseStation } from '../src/mammotion/client.js';
import { HttpError } from '../src/mammotion/http.js';
import { signHeaders } from '../src/mammotion/aliyun.js';

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
    json({ code: 0, data: [{ iotId: 'iot-1', deviceName: 'Luba-X', productSeries: 'Luba 2' }] }),
  );
  on('api-iot.mammotion.com', '/v1/user/device/page', () =>
    json({ code: 0, data: { records: [] } }),
  );

  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  const mowers = await client.listMowers();
  assert.equal(mowers.length, 1);
  assert.deepEqual(mowers[0], {
    iotId: 'iot-1',
    name: 'Luba',
    productKey: 'a1iMygIwxFC',
    deviceName: 'Luba-X',
    series: 'Luba 2',
    online: true,
  });
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

test('sendCommand uses the Mammotion API when it accepts the command', async () => {
  mockLogin();
  on('api-iot.mammotion.com', '/v1/mqtt/rpc/thing/service/invoke', () =>
    json({ code: 0, data: { result: 'ok' } }),
  );
  const client = new MammotionClient({ email: 'me@example.com', password: 'pw' });
  await client.sendCommand(
    { iotId: 'iot-1', name: 'Luba', productKey: 'pk', deviceName: 'dn' },
    'start',
  );
  assert.equal(calls.filter((c) => c.host.includes('aliyun')).length, 0);
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
