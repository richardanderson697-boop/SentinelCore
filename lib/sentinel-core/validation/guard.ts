import { SentinelVerdictSchema, SentinelVerdictData } from "./schema";

export class ValidationGuard {
  
  /**
   * Parse and validate model json strings safely.
   * If parsing or schema compliance fails, gracefully creates a secure fail-safe fallback response.
   */
  public static safeValidateVerdict(
    rawResponse: string,
    fallbackReason = "Encountered compliance parsing anomaly."
  ): SentinelVerdictData {
    try {
      const parsed = JSON.parse(rawResponse);
      const result = SentinelVerdictSchema.safeParse(parsed);

      if (result.success) {
        return result.data;
      }

      console.error("[SentinelCore ValidationGuard] Upstream model Schema validation failed:", result.error.format());
      return this.createFailSecureFallback(
        `Structural drift: ${result.error.issues.map(e => `${e.path.join('.') || 'root'}: ${e.message}`).join(', ')}`
      );
    } catch (parseError: any) {
      console.error("[SentinelCore ValidationGuard] Failed to parse target JSON format:", parseError);
      return this.createFailSecureFallback(`Garbled response: ${parseError.message || parseError}`);
    }
  }

  /**
   * Formulates a secure, policy-compliant fallback state
   */
  private static createFailSecureFallback(reasonText: string): SentinelVerdictData {
    return {
      finalVerdict: "FLAG",
      finalScore: 5,
      riskLevel: "MEDIUM",
      tiersExecuted: [1, 2],
      categories: ["Validation Guard Handover"],
      intentSummary: "Validation check bypassed due to unparseable upstream data blocks.",
      reasoning: `Middleware active guardrails engaged: ${reasonText}. Gated input automatically to prevent safety-bypass escapes.`,
      deceptiveFraming: false,
      complianceReports: [],
      decisionSource: "model-assisted"
    };
  }
}
