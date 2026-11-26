# Retry policy

`src/http/retry-policy.mjs` exports `retryDelay(status, retry)`.

`status` is the HTTP status code of a failed request, as an integer. `retry` is the number of the retry, as an integer: 0 is the first retry.

The function returns the delay in milliseconds before that retry, as an integer, or null if the client does not make that retry:

- If the status code is on the list of status codes that are never retried, the result is null.
- The client makes at most the maximum number of attempts, the first request included. Thus the retries 0 to (maximum number of attempts - 2) exist, and a higher retry number gives null.
- The delay before retry number i is the base delay times the backoff factor to the power i. A delay above the maximum delay is cut to the maximum delay.
- For status 429, the extra delay for rate limits is added after the cut. Thus a delay for status 429 can be above the maximum delay.

The platform team sets the values of these requirements.
