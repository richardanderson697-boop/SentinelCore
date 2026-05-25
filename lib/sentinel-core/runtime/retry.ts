export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  backoffFactor: number;
  retryableErrors?: (error: any) => boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 250,
  backoffFactor: 2,
};

/**
 * Execute a task with progressive exponential backoff logic.
 * Ensures the system recovers from transient remote rate-limiting and connection dropouts elegantly.
 */
export async function withExponentialRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const mergedConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: any;
  let currentDelay = mergedConfig.initialDelayMs;

  for (let attempt = 1; attempt <= mergedConfig.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      
      const isLastAttempt = attempt === mergedConfig.maxAttempts;
      const isRetryable = mergedConfig.retryableErrors 
        ? mergedConfig.retryableErrors(err) 
        : true; // Default to retry all failed calls if custom checker is not provided

      if (isLastAttempt || !isRetryable) {
        break;
      }

      console.warn(
        `[SentinelCore Retry] Action failed (Attempt ${attempt}/${mergedConfig.maxAttempts}). Retrying in ${currentDelay}ms... Error: ${err.message || err}`
      );

      await new Promise(resolve => setTimeout(resolve, currentDelay));
      currentDelay *= mergedConfig.backoffFactor;
    }
  }

  throw lastError;
}
