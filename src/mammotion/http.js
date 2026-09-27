// -----------------------------------------------------------------------------
// Tiny HTTP helper on top of the global `fetch` (Node 20+): timeout, JSON
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
