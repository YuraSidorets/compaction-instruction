// Reference solution of K13-retry-policy: the requirements after stage 8.
const REQUIREMENTS = {"baseDelay":500,"factor":2,"maxDelay":1600,"maxAttempts":7,"extra429":750,"nonRetryable":["400","401","404","409","422","501"]};

export function retryDelay(status, retry) {
  const P = REQUIREMENTS;
  if (P.nonRetryable.includes(String(status))) return null;
  if (retry > P.maxAttempts - 2) return null;
  const extra = status === 429 ? P.extra429 : 0;
  return Math.min(P.maxDelay, P.baseDelay * P.factor ** retry) + extra;
}
