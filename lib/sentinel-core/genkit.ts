import { PolicyEngine } from "./runtime/policy-engine";

export interface GenkitMiddlewareOptions {
  failSecure?: "ALLOW" | "FLAG" | "BLOCK";
  tierDebateThreshold?: number;
  scanTools?: boolean;
}

/**
 * SentinelCore Genkit Middleware Gating implementation.
 * Encapsulates standard pre-generation flow interceptors and execution guards.
 */
export class SentinelGenkitMiddleware {
  private options: GenkitMiddlewareOptions;

  constructor(options: GenkitMiddlewareOptions = {}) {
    this.options = {
      failSecure: "BLOCK",
      tierDebateThreshold: 7,
      scanTools: false,
      ...options
    };
  }

  /**
   * Genkit model-request middleware.
   * Intercepts model generation input parameters at the request boundary prior to LLM dispatch.
   * Matches Genkit's standard action-level middleware signature.
   */
  public promptMiddleware() {
    return async (input: { prompt?: string; [key: string]: any }, next: (input: any) => Promise<any>) => {
      const promptText = input.prompt || "";
      if (!promptText) {
        return next(input);
      }

      // Check fast deterministic local edge gating rules before executing LLM query
      const policyResult = PolicyEngine.evaluate(promptText);

      // If policy evaluation mandates a BLOCK, short-circuit execution to protect context and save costs
      if (policyResult.verdict === "BLOCK" && this.options.failSecure !== "ALLOW") {
        throw new Error(
          `[SentinelCore Gating BLOCK] Security policy violated: ${policyResult.reasoning}`
        );
      }

      // Proceed gracefully through upstream model dispatcher
      const output = await next(input);
      return output;
    };
  }

  /**
   * Safe Tool Interceptor wrapper.
   * Decorates Genkit's tool definitions with deterministic parameter scans and sensitivity checks.
   * Prevents privilege escalations or destructive payloads on tools like DB queries and e-mailing.
   */
  public wrapTool<I = any, O = any>(
    toolName: string,
    toolAction: (input: I) => Promise<O>,
    options: { sensitivity?: "NONE" | "LOW" | "MEDIUM" | "HIGH" } = {}
  ): (input: I) => Promise<O> {
    const sensitivity = options.sensitivity || "MEDIUM";

    return async (input: I): Promise<O> => {
      const serializedInput = typeof input === "string" ? input : JSON.stringify(input);

      // Evaluate parameters using the context-aware deterministic security policy
      const policyResult = PolicyEngine.evaluate(
        `Executing tool [${toolName}]`,
        toolName,
        serializedInput,
        sensitivity
      );

      if (policyResult.verdict === "BLOCK") {
        throw new Error(
          `[SentinelCore Tool BLOCK] Security policy violation matched on tool '${toolName}'. Gated parameter execution was rejected: ${policyResult.reasoning}`
        );
      }

      // Proceed safely with tool execution
      return toolAction(input);
    };
  }
}

/**
 * Genkit Plugin registration standard.
 * Hooks SentinelCore directly into standard Genkit instance configurations.
 */
export function sentinelCorePlugin(options: GenkitMiddlewareOptions = {}) {
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
}
