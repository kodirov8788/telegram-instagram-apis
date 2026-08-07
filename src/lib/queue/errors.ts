export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueValidationError';
  }
}
