const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 1600;
const MAX_ATTEMPTS = 7;
const RATE_LIMIT_EXTRA_MS = 750;
const RATE_LIMIT_STATUS = 429;
const NEVER_RETRIED = new Set([400, 401, 404, 409, 422, 501]);

export function retryDelay(status, retry) {
  if (NEVER_RETRIED.has(status)) {
    return null;
  }
  if (retry < 0 || retry > MAX_ATTEMPTS - 2) {
    return null;
  }

  const exponential = BASE_DELAY_MS * BACKOFF_FACTOR ** retry;
  let delay = Math.min(exponential, MAX_DELAY_MS);

  if (status === RATE_LIMIT_STATUS) {
    delay += RATE_LIMIT_EXTRA_MS;
  }

  return Math.round(delay);
}
