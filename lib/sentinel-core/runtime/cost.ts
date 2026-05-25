export interface CostMetrics {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/**
 * High-fidelity costing model using real-world Gemini 3.5 Flash metrics
 * ($0.075 / 1M input tokens, $0.30 / 1M output tokens as standard baselines + baseline costs for Tiers 2 and 3)
 */
export class CostEstimator {
  private static readonly INPUT_PRICE_PER_M = 0.075;
  private static readonly OUTPUT_PRICE_PER_M = 0.30;

  // Local/deterministic scans have fixed nominal processing charges
  private static readonly TIER1_FIXED_USD = 0.0;
  private static readonly TIER2_BASE_USD = 0.0015;
  private static readonly TIER3_BASE_USD = 0.0045;

  /**
   * Approximate token count based on typical character-token ratio (approx 4 chars/token)
   */
  public static estimateTokenCount(text: string): number {
    if (!text) return 0;
    // Fast, lightweight approximation helper
    return Math.ceil(text.trim().length / 4);
  }

  /**
   * Compiles total processing cost across three pipeline architectures
   */
  public static calculateCost(
    prompt: string,
    tiersExecuted: number[],
    responseJsonString?: string
  ): CostMetrics {
    const promptTokens = this.estimateTokenCount(prompt);
    
    // Fallback response tokens if none received yet
    let responseTokens = 120; // Default estimate for standard safety payload
    if (responseJsonString) {
      responseTokens = this.estimateTokenCount(responseJsonString);
    }

    // Standard variable pricing based on tokens
    let variableCost = 
      ((promptTokens / 1_000_000) * this.INPUT_PRICE_PER_M) +
      ((responseTokens / 1_000_000) * this.OUTPUT_PRICE_PER_M);

    // Cumulative tier-specific indexing costs
    let fixedCost = 0;
    if (tiersExecuted.includes(1)) fixedCost += this.TIER1_FIXED_USD;
    if (tiersExecuted.includes(2)) fixedCost += this.TIER2_BASE_USD;
    if (tiersExecuted.includes(3)) fixedCost += this.TIER3_BASE_USD;

    const totalCost = fixedCost + variableCost;

    return {
      inputTokens: promptTokens,
      outputTokens: responseTokens,
      estimatedCostUsd: Number(totalCost.toFixed(6))
    };
  }
}
