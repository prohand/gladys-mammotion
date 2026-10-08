// -----------------------------------------------------------------------------
// Tiny HTTP helper on top of the global `fetch` (Node 22+): timeout, JSON
// parsing and an error that carries the HTTP status.
// -----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Words the clouds use when they refuse a session or a token. Only ever matched
// against a message WRITTEN BY THE CLOUD (see authErrorFromResponse): matched
// against our own errors, "no iot domain in the access token" read as an
// expired session, and every poll logged in again for nothing.
const AUTH_MESSAGE_HINTS = [
  'token',
  'session',
  'unauthorized',
  'not login',
  'identityid is blank',
  'identity id is blank',
  'auth error',
  'forbidden',
];

/**
 * The cloud refused our credentials or our session: logging in again may fix
 * it. Thrown only where an answer of the cloud says so, so that withRetry and
 * the connection status never mistake an internal error for an expired session.
 */
export class MammotionAuthError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'MammotionAuthError';
    this.code = code;
  }
}

/**
 * An auth error when the cloud answer says the session or token was refused
 * (one of `authCodes`, or a cloud message in those words), else null.
 * @param {string|undefined} cloudMessage the message of the answer, as sent
 * @param {number|undefined} code the code of the answer
 * @param {number[]} authCodes the codes that mean "log in again" for that API
 * @param {string} fallback message when the cloud gave none
 */
export function authErrorFromResponse(cloudMessage, code, authCodes, fallback) {
  const text = String(cloudMessage ?? '').toLowerCase();
  if (authCodes.includes(code) || AUTH_MESSAGE_HINTS.some((hint) => text.includes(hint))) {
    return new MammotionAuthError(cloudMessage || fallback, { code });
  }
  return null;
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, query?: Record<string, string>,
 *   body?: string, timeoutMs?: number }} [options]
 * @returns {Promise<any>} the parsed JSON body
 */
export async function requestJson(url, options = {}) {
  const { method = 'GET', headers = {}, query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const target = new URL(url);
  for (const [key, value] of Object.entries(query ?? {})) {
    target.searchParams.set(key, value);
  }

  const response = await fetch(target, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep null, the status tells the story.
  }
  if (!response.ok) {
    const reason = json?.msg || json?.message || json?.error_description || response.statusText;
    throw new HttpError(
      `HTTP ${response.status} on ${target.pathname}: ${reason}`,
      response.status,
    );
  }
  return json;
}
