// Retry policy for the HTTP client. Values are set by the platform team.

const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 1600;
const MAX_ATTEMPTS = 7; // includes the first request
const RATE_LIMIT_EXTRA_MS = 750; // added for status 429, after the cut to MAX_DELAY_MS

const NEVER_RETRIED = new Set([400, 401, 404, 409, 422, 501]);

/**
 * Returns the delay in milliseconds before retry number `retry` (0-based),
 * or null if the request must not be retried.
 */
export function retryDelay(status, retry) {
  if (NEVER_RETRIED.has(status)) {
    return null;
  }

  // Retries 0 to (MAX_ATTEMPTS - 2) exist; the first request is attempt 1.
  if (retry < 0 || retry > MAX_ATTEMPTS - 2) {
    return null;
  }

  const delay = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** retry, MAX_DELAY_MS);

  if (status === 429) {
    return delay + RATE_LIMIT_EXTRA_MS;
  }

  return delay;
}
