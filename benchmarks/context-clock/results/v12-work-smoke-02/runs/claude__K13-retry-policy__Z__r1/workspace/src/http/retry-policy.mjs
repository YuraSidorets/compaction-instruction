// Retry policy for the HTTP client. Rules are described in ./README.md.

const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 1600;
const MAX_ATTEMPTS = 7; // includes the first request
const RATE_LIMIT_EXTRA_DELAY_MS = 750;
const NEVER_RETRIED_STATUSES = new Set([400, 401, 404, 409, 422, 501]);

/**
 * Returns the delay in milliseconds before retry number `retry` (0 is the
 * first retry), or null if no such retry is made.
 *
 * @param {number} status HTTP status code of the failed request.
 * @param {number} retry Retry number, an integer starting at 0.
 * @returns {number | null}
 */
export function retryDelay(status, retry) {
  if (NEVER_RETRIED_STATUSES.has(status)) {
    return null;
  }
  // Retries 0 to (MAX_ATTEMPTS - 2) exist; the first request is attempt 1.
  if (!Number.isInteger(retry) || retry < 0 || retry > MAX_ATTEMPTS - 2) {
    return null;
  }

  const exponential = BASE_DELAY_MS * BACKOFF_FACTOR ** retry;
  let delay = Math.min(exponential, MAX_DELAY_MS);

  if (status === 429) {
    // Rate-limit extra delay is added after the cut, so it may exceed MAX_DELAY_MS.
    delay += RATE_LIMIT_EXTRA_DELAY_MS;
  }

  return delay;
}
