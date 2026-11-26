const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 1600;
const MAX_ATTEMPTS = 7;
const RATE_LIMIT_EXTRA_MS = 750;
const NEVER_RETRIED = new Set([400, 401, 404, 409, 422, 501]);

// Returns the delay in ms before retry number `retry` (0 is the first retry),
// or null if no retry is made for this status code.
export function retryDelay(status, retry) {
  if (NEVER_RETRIED.has(status)) {
    return null;
  }
  // The first request counts as an attempt, so retries 0 .. MAX_ATTEMPTS - 2 exist.
  if (retry >= MAX_ATTEMPTS - 1) {
    return null;
  }
  const delay = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** retry, MAX_DELAY_MS);
  // The rate-limit extra is added after the cap, so 429 can exceed MAX_DELAY_MS.
  return status === 429 ? delay + RATE_LIMIT_EXTRA_MS : delay;
}
