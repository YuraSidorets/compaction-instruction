const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 1600;
const MAX_ATTEMPTS = 7; // includes the first request
const RATE_LIMIT_EXTRA_MS = 750;
const NEVER_RETRY_STATUSES = new Set([400, 401, 404, 409, 422, 501]);

export function retryDelay(status, retry) {
  if (NEVER_RETRY_STATUSES.has(status)) {
    return null;
  }

  // Retries 0 .. MAX_ATTEMPTS - 2 exist.
  if (retry > MAX_ATTEMPTS - 2) {
    return null;
  }

  const exponential = BASE_DELAY_MS * BACKOFF_FACTOR ** retry;
  let delay = Math.min(exponential, MAX_DELAY_MS);

  // The rate-limit extra is added after the cap, so it can exceed MAX_DELAY_MS.
  if (status === 429) {
    delay += RATE_LIMIT_EXTRA_MS;
  }

  return Math.trunc(delay);
}
