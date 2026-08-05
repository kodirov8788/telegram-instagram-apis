export class RetryableWorkError extends Error {
  constructor(readonly delayMs: number, message = 'Work is retryable') {
    super(message);
    this.name = 'RetryableWorkError';
  }
}
