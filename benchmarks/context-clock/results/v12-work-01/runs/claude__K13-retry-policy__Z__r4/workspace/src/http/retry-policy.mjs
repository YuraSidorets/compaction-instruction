const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 1600;
const MAX_ATTEMPTS = 7;
const RATE_LIMIT_EXTRA_MS = 750;
const NEVER_RETRIED = new Set([400, 401, 404, 409, 422, 501]);

export function retryDelay(status, retry) {
  if (NEVER_RETRIED.has(status)) {
    return null;
  }
  // Attempts include the first request, so retries 0 to MAX_ATTEMPTS - 2 exist.
  if (retry < 0 || retry > MAX_ATTEMPTS - 2) {
    return null;
  }
  let delay = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** retry, MAX_DELAY_MS);
  if (status === 429) {
    // The rate-limit extra is added after the cut, so it may exceed MAX_DELAY_MS.
    delay += RATE_LIMIT_EXTRA_MS;
  }
  return delay;
}
