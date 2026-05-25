export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number; // Number of sequential failures before tripping breaker
  cooldownWindowMs: number; // Duration to remain OPEN before trying HALF_OPEN
}

/**
 * High-reliability Circuit Breaker to prevent cascading failures 
 * and excessive timeouts under model outage scenarios.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastStateTransition: number = Date.now();
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: 3,
      cooldownWindowMs: 15000, // Default 15s cooldown
      ...config
    };
  }

  public getState(): CircuitState {
    this.updateState();
    return this.state;
  }

  /**
   * Evaluates and updates the state machine according to time window progression
   */
  private updateState(): void {
    if (this.state === 'OPEN') {
      const timeSinceTrip = Date.now() - this.lastStateTransition;
      if (timeSinceTrip >= this.config.cooldownWindowMs) {
        this.transitionTo('HALF_OPEN');
        console.info("[SentinelCore CircuitBreaker] COOLDOWN expired. Transitioning to HALF_OPEN state.");
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    this.state = newState;
    this.lastStateTransition = Date.now();
  }

  /**
   * Wraps a remote model execution pipeline inside circuit guardrails
   */
  public async execute<T>(action: () => Promise<T>): Promise<T> {
    this.updateState();

    if (this.state === 'OPEN') {
      throw new Error(`CircuitBreakerError: Downstream model channel is currently tripped (OPEN state). Please try again in ${Math.ceil((this.config.cooldownWindowMs - (Date.now() - this.lastStateTransition)) / 1000)}s.`);
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.transitionTo('CLOSED');
      console.info("[SentinelCore CircuitBreaker] Half-open validation execution completed safely. Re-closing circuit.");
    }
  }

  private onFailure(): void {
    this.failureCount++;
    console.warn(`[SentinelCore CircuitBreaker] Failure registered. Sequential Faults: ${this.failureCount}/${this.config.failureThreshold}`);

    if (this.state === 'CLOSED' && this.failureCount >= this.config.failureThreshold) {
      this.transitionTo('OPEN');
      console.warn(`[SentinelCore CircuitBreaker] Sequential failure threshold exceeded. Breaking upstream requests (OPEN state).`);
    } else if (this.state === 'HALF_OPEN') {
      // Re-trip immediately on any failure during validation test
      this.transitionTo('OPEN');
      console.warn(`[SentinelCore CircuitBreaker] Validation test failed in HALF_OPEN. Tripping breaker back to OPEN.`);
    }
  }

  /**
   * Hard reset circuit breaker states
   */
  public reset(): void {
    this.failureCount = 0;
    this.transitionTo('CLOSED');
  }
}
