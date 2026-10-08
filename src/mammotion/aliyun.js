// -----------------------------------------------------------------------------
// Aliyun IoT gateway ("living" API), still used by most Luba / Yuka mowers for
// their properties and commands.
//
// Flow, starting from the Mammotion OAuth login (see client.js):
//   1. region lookup with the Mammotion `authorization_code`;
//   2. open-account "connect" -> vid + deviceId;
//   3. login by OAuth -> sid;
//   4. create an IoT session -> iotToken, used by every later call.
// Every request is signed (HMAC-SHA256) with the Mammotion app key.
// -----------------------------------------------------------------------------

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { authErrorFromResponse, requestJson } from './http.js';

const ALIYUN_DOMAIN = 'api.link.aliyun.com';
const OPEN_ACCOUNT_DOMAIN = 'sdk.openaccount.aliyun.com';
const APP_KEY = '34231230';
const APP_SECRET = '1ba85698bb10e19c6437413b61ba3445';
const APP_VERSION = '1.11.130';
// Answers of the gateway that mean "open a new session": 401 (request auth
// error), 460 (iotToken invalid or expired), 29003 (identityId is blank).
const AUTH_CODES = [401, 460, 29003];

// Headers that are part of the string to sign "by position" and therefore
// excluded from the `x-ca-signature-headers` block.
const POSITIONAL_HEADERS = new Set([
  'x-ca-signature',
  'x-ca-signature-headers',
  'accept',
  'content-md5',
  'content-type',
  'date',
  'host',
  'token',
  'user-agent',
]);

// A stable-per-process pseudo device identifier, as the Android app sends.
const UTDID = randomBytes(16).toString('hex');

function hmacBase64(value) {
  return createHmac('sha256', APP_SECRET).update(value, 'utf8').digest('base64');
}

function baseHeaders(contentType) {
  return {
    date: new Date().toUTCString(),
    'x-ca-nonce': randomUUID(),
    'x-ca-key': APP_KEY,
    'x-ca-signaturemethod': 'HmacSHA256',
    accept: 'application/json',
    'content-type': contentType,
    'user-agent': 'okhttp/4.9.3',
  };
}

/** Sign `headers` in place for the given path (query already appended). */
export function signHeaders(method, pathWithQuery, headers) {
  const signed = Object.keys(headers)
    .filter((key) => !POSITIONAL_HEADERS.has(key.toLowerCase()))
    .sort();
  const headerBlock = signed.map((key) => `${key}:${headers[key] ?? ''}`).join('\n');
  headers['x-ca-signature-headers'] = signed.join(',');
  const toSign = [
    method,
    headers.accept ?? '',
    headers['content-md5'] ?? '',
    headers['content-type'] ?? '',
    headers.date ?? '',
    headerBlock,
    pathWithQuery,
  ].join('\n');
  headers['x-ca-signature'] = hmacBase64(toSign);
  return headers;
}

/**
 * Call an Aliyun IoT API (`/thing/properties/get`, `/uc/listBindingByAccount`…).
 * @returns {Promise<{ code: number, data?: any, message?: string, msg?: string }>}
 */
export async function callAliyunApi(domain, path, apiVer, params, iotToken) {
  const body = JSON.stringify({
    id: randomUUID(),
    params,
    request: { apiVer, language: 'en-US', ...(iotToken ? { iotToken } : {}) },
    version: '1.0',
  });
  const headers = baseHeaders('application/octet-stream');
  headers['content-md5'] = createHash('md5').update(body, 'utf8').digest('base64');
  signHeaders('POST', path, headers);
  return requestJson(`https://${domain}${path}`, { method: 'POST', headers, body });
}

function apiMessage(response, fallback) {
  return response?.message || response?.msg || fallback;
}

async function openAccountConnect() {
  const request = JSON.stringify({
    context: {
      sdkVersion: '3.4.2',
      platformName: 'android',
      netType: 'wifi',
      appKey: APP_KEY,
      yunOSId: '',
      appVersion: APP_VERSION,
      utDid: UTDID,
      appAuthToken: UTDID,
      securityToken: UTDID,
    },
    config: { version: 0, lastModify: 0 },
    device: { model: 'sdk_gphone_x86_arm', brand: 'goldfish_x86', platformVersion: '30' },
  });
  const headers = signHeaders(
    'POST',
    `/api/prd/connect.json?request=${request}`,
    baseHeaders('application/x-www-form-urlencoded'),
  );
  const response = await requestJson(`https://${OPEN_ACCOUNT_DOMAIN}/api/prd/connect.json`, {
    method: 'POST',
    headers,
    query: { request },
  });
  const vid = response?.data?.vid || response?.vid;
  const deviceId = response?.data?.data?.device?.data?.deviceId;
  if (!vid || !deviceId) {
    throw new Error('Aliyun connect failed: vid/deviceId missing');
  }
  return { vid, deviceId };
}

async function loginByOauth(oaDomain, authCode, countryCode, { vid, deviceId }) {
  const request = JSON.stringify({
    country: countryCode,
    authCode,
    oauthPlateform: 23,
    oauthAppKey: APP_KEY,
    riskControlInfo: {
      appID: 'com.agilexrobotics',
      appAuthToken: '',
      signType: 'RSA',
      sdkVersion: '3.4.2',
      utdid: UTDID,
      umidToken: UTDID,
      deviceId,
      USE_OA_PWD_ENCRYPT: 'true',
      USE_H5_NC: 'true',
    },
  });
  const headers = baseHeaders('application/x-www-form-urlencoded; charset=utf-8');
  headers.vid = vid;
  signHeaders('POST', `/api/prd/loginbyoauth.json?loginByOauthRequest=${request}`, headers);
  const form = new URLSearchParams({ loginByOauthRequest: request });
  const response = await requestJson(`https://${oaDomain}/api/prd/loginbyoauth.json`, {
    method: 'POST',
    headers,
    body: form.toString(),
  });
  const sid = response?.data?.data?.loginSuccessResult?.sid;
  if (!sid) {
    throw new Error('Aliyun login failed: sid missing');
  }
  return sid;
}

/**
 * Open an Aliyun IoT session from the Mammotion OAuth authorization code.
 * @param {{ authorizationCode: string, countryCode: string }} mammotionSession
 */
export async function createAliyunSession({ authorizationCode, countryCode }) {
  if (!authorizationCode) {
    throw new Error('Aliyun login impossible: authorization_code missing');
  }
  const region = await callAliyunApi(ALIYUN_DOMAIN, '/living/account/region/get', '1.0.2', {
    authCode: authorizationCode,
    type: 'THIRD_AUTHCODE',
    countryCode,
  });
  const { apiGatewayEndpoint, oaApiGatewayEndpoint } = region?.data ?? {};
  if (region?.code !== 200 || !apiGatewayEndpoint || !oaApiGatewayEndpoint) {
    throw new Error(apiMessage(region, 'Aliyun region lookup failed'));
  }

  const connect = await openAccountConnect();
  const sid = await loginByOauth(oaApiGatewayEndpoint, authorizationCode, countryCode, connect);

  const session = await callAliyunApi(
    apiGatewayEndpoint,
    '/account/createSessionByAuthCode',
    '1.0.4',
    { request: { authCode: sid, accountType: 'OA_SESSION', appKey: APP_KEY } },
  );
  if (session?.code !== 200 || !session?.data?.iotToken) {
    throw new Error(apiMessage(session, 'Aliyun session creation failed'));
  }
  const ttlSeconds = Number(session.data.iotTokenExpire) || 3600;
  return {
    domain: apiGatewayEndpoint,
    iotToken: session.data.iotToken,
    // Renew 5 minutes before the real expiry.
    expiresAt: Date.now() + ttlSeconds * 1000 - 5 * 60_000,
  };
}

/** Throw a readable error when an Aliyun response is not a success. */
export function assertAliyunOk(response, fallback) {
  if (response?.code !== 200) {
    const authError = authErrorFromResponse(
      response?.message || response?.msg,
      response?.code,
      AUTH_CODES,
      fallback,
    );
    if (authError) {
      authError.aliyunCode = response?.code;
      throw authError;
    }
    const error = new Error(apiMessage(response, fallback));
    error.aliyunCode = response?.code;
    throw error;
  }
  return response.data;
}
