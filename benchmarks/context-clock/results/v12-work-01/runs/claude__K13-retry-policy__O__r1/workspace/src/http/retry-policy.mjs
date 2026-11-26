// Retry policy for HTTP requests.

const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 1600;
const MAX_ATTEMPTS = 7; // includes the first request
const RATE_LIMIT_EXTRA_MS = 750; // added for status 429, after the cap
const NEVER_RETRIED = new Set([400, 401, 404, 409, 422, 501]);

/**
 * Returns the delay in integer milliseconds before retry number `retry`
 * (0 is the first retry), or null if no such retry is made.
 *
 * @param {number} status HTTP status code of the failed request.
 * @param {number} retry Retry number, 0-based.
 * @returns {number|null}
 */
export function retryDelay(status, retry) {
  if (NEVER_RETRIED.has(status)) {
    return null;
  }
  if (!Number.isInteger(retry) || retry < 0) {
    return null;
  }
  // Retries 0 .. MAX_ATTEMPTS - 2 exist (the first request is attempt 1).
  if (retry > MAX_ATTEMPTS - 2) {
    return null;
  }

  const delay = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** retry, MAX_DELAY_MS);
  const extra = status === 429 ? RATE_LIMIT_EXTRA_MS : 0;
  return Math.round(delay + extra);
}
