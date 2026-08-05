export type QueueErrorCode = 'QUEUE_VALIDATION_ERROR' | 'QUEUE_DATABASE_ERROR';

export class QueueError extends Error {
  public readonly retryable: boolean;
  public readonly code: QueueErrorCode;
  public readonly cause?: any;

  constructor(message: string, code: QueueErrorCode, retryable: boolean, cause?: any) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class QueueValidationError extends QueueError {
  constructor(message: string) {
    super(message, 'QUEUE_VALIDATION_ERROR', false);
    this.name = 'QueueValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class QueueDatabaseError extends QueueError {
  constructor(message: string, retryable: boolean, cause?: any) {
    super(message, 'QUEUE_DATABASE_ERROR', retryable, cause);
    this.name = 'QueueDatabaseError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function translateDatabaseError(error: any): QueueError {
  if (error instanceof QueueError) {
    return error;
  }
  const pgCode = error?.code;

  // Class 08 (Connection Exception) or specific retryable codes
  const isRetryable =
    typeof pgCode === 'string' &&
    (pgCode.startsWith('08') || // Connection exceptions
     pgCode === '40001' ||      // Serialization failure
     pgCode === '40P01' ||      // Deadlock detected
     pgCode === '57P01' ||      // Admin shutdown
     pgCode === '57P02' ||      // Crash shutdown
     pgCode === '57P03');       // Cannot connect now

  // Construct a safe message without leaking raw SQL or credentials
  let safeMessage = 'Database error occurred during queue operation';
  if (isRetryable) {
    safeMessage = 'Transient database error occurred during queue operation';
  } else {
    if (pgCode === '42501') {
      safeMessage = 'Unauthorized queue operation';
    } else if (pgCode === '42P01') {
      safeMessage = 'Queue relation does not exist';
    }
  }

  return new QueueDatabaseError(safeMessage, isRetryable, error);
}
