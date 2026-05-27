// Main module exports for SentinelCore SDK package

export { PolicyEngine } from "./runtime/policy-engine";
export type { PolicyRule, PolicyEngineResult } from "./runtime/policy-engine";

export { PolicyStateEngine } from "./runtime/state-engine";
export type { ScanRecord, AppRiskProfile, SessionHistory, ToolFingerprint } from "./runtime/state-engine";

export { LLMProvider } from "./runtime/provider";
export { withExponentialRetry } from "./runtime/retry";
export { CircuitBreaker } from "./runtime/circuit-breaker";
export { CostEstimator } from "./runtime/cost";

export { ValidationGuard } from "./validation/guard";
export { SentinelVerdictSchema, VerdictTypeSchema, RiskLevelSchema, ComplianceReportSchema } from "./validation/schema";
export type { SentinelVerdictData } from "./validation/schema";

export { SentinelGenkitMiddleware, sentinelCorePlugin } from "./genkit";
export type { GenkitMiddlewareOptions } from "./genkit";

export { sentinelCoreExpressMiddleware } from "./express";
export type { SentinelExpressMiddlewareOptions } from "./express";

import { SentinelGenkitMiddleware } from "./genkit";
import { sentinelCoreExpressMiddleware } from "./express";
import type { GenkitMiddlewareOptions } from "./genkit";
import type { SentinelExpressMiddlewareOptions } from "./express";

class SentinelCoreInstance {
  private options: GenkitMiddlewareOptions;

  constructor(options: GenkitMiddlewareOptions = {}) {
    this.options = options;
  }

  get name() {
    return "sentinel-core-gating";
  }

  initialize() {
    const middleware = new SentinelGenkitMiddleware(this.options);
    return {
      middlewares: [
        middleware.promptMiddleware()
      ]
    };
  }

  promptMiddleware() {
    const middleware = new SentinelGenkitMiddleware(this.options);
    return middleware.promptMiddleware();
  }

  wrapTool<I = any, O = any>(
    toolName: string,
    toolAction: (input: I) => Promise<O>,
    options: { sensitivity?: "NONE" | "LOW" | "MEDIUM" | "HIGH" } = {}
  ): (input: I) => Promise<O> {
    const middleware = new SentinelGenkitMiddleware(this.options);
    return middleware.wrapTool(toolName, toolAction, options);
  }

  express(expressOptions: SentinelExpressMiddlewareOptions = {}) {
    return sentinelCoreExpressMiddleware({
      ...this.options,
      ...expressOptions
    });
  }
}

/**
 * Unified factory function for SentinelCore integration stories.
 */
export function sentinelCore(options: GenkitMiddlewareOptions = {}) {
  return new SentinelCoreInstance(options);
}

// Attach static shortcuts for absolute naming convenience
sentinelCore.express = (options: SentinelExpressMiddlewareOptions = {}) => {
  return sentinelCoreExpressMiddleware(options);
};

sentinelCore.plugin = (options: GenkitMiddlewareOptions = {}) => {
  const middleware = new SentinelGenkitMiddleware(options);
  return {
    name: "sentinel-core-gating",
    initialize: () => {
      return {
        middlewares: [
          middleware.promptMiddleware()
        ]
      };
    }
  };
};

