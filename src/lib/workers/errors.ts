/** Thrown by a worker's `process` callback to request a delayed redelivery instead of an immediate retry or archive. */
export class RetryableWorkError extends Error {
  constructor(readonly delayMs: number, message = 'Work is retryable') {
    super(message);
    this.name = 'RetryableWorkError';
  }
}
