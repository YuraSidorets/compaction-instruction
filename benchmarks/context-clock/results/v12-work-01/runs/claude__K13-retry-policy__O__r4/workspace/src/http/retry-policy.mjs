// Retry policy for the HTTP client. Rules are in src/http/README.md.

const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 1600;
const MAX_ATTEMPTS = 7; // includes the first request
const RATE_LIMIT_EXTRA_MS = 750; // added to status 429 after the cap

const NEVER_RETRIED = new Set([400, 401, 404, 409, 422, 501]);

/**
 * Returns the delay in ms before retry number `retry` (0 is the first retry),
 * or null if the client does not make that retry.
 * @param {number} status HTTP status code of the failed request
 * @param {number} retry retry number, starting at 0
 * @returns {number | null}
 */
export function retryDelay(status, retry) {
  if (NEVER_RETRIED.has(status)) {
    return null;
  }
  // Retries 0 .. MAX_ATTEMPTS - 2 exist.
  if (retry < 0 || retry > MAX_ATTEMPTS - 2) {
    return null;
  }
  const delay = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** retry, MAX_DELAY_MS);
  if (status === 429) {
    return delay + RATE_LIMIT_EXTRA_MS;
  }
  return delay;
}
