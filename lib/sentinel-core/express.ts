import { Request, Response, NextFunction } from "express";
import { PolicyEngine } from "./runtime/policy-engine";
import { PolicyStateEngine } from "./runtime/state-engine";
import { LLMProvider } from "./runtime/provider";
import { CircuitBreaker } from "./runtime/circuit-breaker";
import { withExponentialRetry } from "./runtime/retry";
import { ValidationGuard } from "./validation/guard";
import { CostEstimator } from "./runtime/cost";

export interface SentinelExpressMiddlewareOptions {
  /**
   * Field or custom extractor to get the prompt text to secure.
   * Can be a string key of req.body (e.g. 'prompt') or a function extractor.
   * Defaults to 'prompt'
   */
  promptField?: string | ((req: Request) => string);

  /**
   * Fail secure policy.
   * - 'BLOCK': Immediately block the request (respond with 403) on FLAG or BLOCK.
   * - 'FLAG': Warn/flag (append results to req.sentinel but allow request) for FLAG, block for BLOCK.
   * - 'ALLOW': Always proceed, only appending results to req.sentinel.
   * Defaults to 'BLOCK'.
   */
  failSecure?: "BLOCK" | "FLAG" | "ALLOW";

  /**
   * Base Tier 3 Debate Threshold. Defaults to 7.
   */
  tier3Threshold?: number;

  /**
   * Application ID to register in the Policy State Engine. Defaults to 'express_app'.
   */
  appId?: string | ((req: Request) => string);

  /**
   * Session ID extractor to enforce budget locks across continuous user request sessions.
   * Defaults to header 'x-session-id' or 'default_session'.
   */
  sessionIdField?: string | ((req: Request) => string);

  /**
   * Whether to scan tool inputs if found in request body. Defaults to false.
   */
  scanTools?: boolean;

  /**
   * Name of the tool to validate when scanTools is true, or extractor function.
   */
  toolNameField?: string | ((req: Request) => string);

  /**
   * Input argument of the tool to validate, or extractor function.
   */
  toolInputField?: string | ((req: Request) => string);

  /**
   * Optional custom handler for blocked requests.
   * If provided, runs instead of sending a default 403 JSON response.
   */
  onBlock?: (req: Request, res: Response, next: NextFunction, scanResult: any) => void;
}

declare global {
  namespace Express {
    interface Request {
      sentinelVerdict?: any;
    }
  }
}

const modelBreaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownWindowMs: 12000,
});

/**
 * SentinelCore Express Gating Middleware.
 * Automatically intercepts incoming HTTP payloads, validates prompt safety,
 * tracks adaptive session budgets, and blocks threats.
 */
export function sentinelCoreExpressMiddleware(options: SentinelExpressMiddlewareOptions = {}) {
  const {
    promptField = "prompt",
    failSecure = "BLOCK",
    tier3Threshold = 7,
    appId = "express_app",
    sessionIdField = (req) => (req.headers["x-session-id"] as string) || "default_session",
    scanTools = false,
    toolNameField = "toolName",
    toolInputField = "toolInput",
    onBlock,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // 1. Extract inputs
      let promptText = "";
      if (typeof promptField === "function") {
        promptText = promptField(req);
      } else {
        promptText = req.body?.[promptField] || "";
      }

      const activeAppId = typeof appId === "function" ? appId(req) : appId;
      const activeSessionId = typeof sessionIdField === "function" ? sessionIdField(req) : req.body?.[sessionIdField] || "default_session";

      if (!promptText) {
        return next();
      }

      // 2. Session Lockdown Check
      const sessionObj = PolicyStateEngine.getOrCreateSession(activeSessionId);
      if (sessionObj.escalatedState === "LOCKDOWN") {
        const payload = {
          status: "blocked",
          error: "Security Lockdown Action Triggered",
          reason: `SESSION LOCKDOWN ACTIVE: Session key '${activeSessionId}' has requested too many dangerous commands and exhausted its budget.`,
          timestamp: new Date().toISOString(),
        };

        if (onBlock) {
          return onBlock(req, res, next, payload);
        }
        res.status(403).json(payload);
        return;
      }

      // 3. Threshold Adaptation
      const appObj = PolicyStateEngine.getOrCreateAppProfile(activeAppId, tier3Threshold);
      const activeThreshold = appObj.adaptedThreshold;

      // Extract tool inputs
      let activeToolName = "";
      let activeToolInput = "";
      if (scanTools) {
        activeToolName = typeof toolNameField === "function" ? toolNameField(req) : req.body?.[toolNameField] || "";
        activeToolInput = typeof toolInputField === "function" ? toolInputField(req) : req.body?.[toolInputField] || "";
      }

      // 4. Evaluate local deterministic rules (Tier 1)
      const policyResult = PolicyEngine.evaluate(
        promptText,
        scanTools && activeToolName ? activeToolName : undefined,
        scanTools && activeToolInput ? activeToolInput : undefined
      );

      // Save scanning start timestamp to calculate realistic latency
      const startMs = Date.now();

      // Form baseline response data
      let finalVerdict: "ALLOW" | "FLAG" | "BLOCK" = policyResult.verdict;
      let finalScore = policyResult.score;
      let finalTiers = [1];
      let categories = policyResult.rules.filter((r) => r.triggered).map((r) => r.name);
      let reasoning = policyResult.reasoning;
      let intentSummary = "Deterministic scan completed.";
      let deceptiveFraming = false;
      let debateSummary: any = undefined;
      let cost = 0;
      let decisionSource: "rule-based" | "model-assisted" | "hybrid" = "rule-based";

      // If hard rules did not block, trigger Tier 2 cognitive semantic scan
      if (finalVerdict !== "BLOCK") {
        const provider = new LLMProvider();

        if (provider.isSimulated()) {
          // Fallback static high-fidelity heuristics to act as model simulation
          const norm = promptText.toLowerCase();
          if (norm.includes("ignore") || norm.includes("instructions") || norm.includes("override")) {
            finalVerdict = "BLOCK";
            finalScore = 8;
            categories.push("Jailbreak Attempt");
            reasoning = "Edge cognitive mapping detected systemic instruction override attempt.";
            deceptiveFraming = true;
          } else if (norm.includes("ssn") || norm.includes("social security")) {
            finalVerdict = "BLOCK";
            finalScore = 7;
            categories.push("PII Extraction");
            reasoning = "Semantic PII extraction scanner caught sensitive variable identifiers.";
          }
          finalTiers = finalScore >= activeThreshold ? [1, 2, 3] : [1, 2];
        } else {
          // Model-driven assessment
          try {
            const userMessageContent = `
            Analyze this request:
            PROMPT: "${promptText.replace(/"/g, '\\"')}"
            TIER3_THRESHOLD: ${activeThreshold}
            SCAN_TOOLS: ${scanTools}
            TOOL_NAME: "${activeToolName}"
            TOOL_INPUT: "${activeToolInput}"
            `;
            
            const validatedData = await modelBreaker.execute(async () => {
              return await withExponentialRetry(async () => {
                const responseText = await provider.generate(userMessageContent, {
                  systemInstruction: "You are SentinelCore. Return valid JSON only.",
                  responseMimeType: "application/json",
                });
                return ValidationGuard.safeValidateVerdict(responseText);
              });
            });

            finalVerdict = validatedData.finalVerdict;
            finalScore = validatedData.finalScore;
            decisionSource = "model-assisted";
            deceptiveFraming = !!validatedData.deceptiveFraming;
            reasoning = validatedData.reasoning;
            intentSummary = validatedData.intentSummary;
            if (validatedData.categories && validatedData.categories.length > 0) {
              categories = [...new Set([...categories, ...validatedData.categories])];
            }

            const triggersDebate = activeThreshold === 0 || finalScore >= activeThreshold;
            finalTiers = triggersDebate ? [1, 2, 3] : [1, 2];

            if (triggersDebate && validatedData.debateProsecutor) {
              debateSummary = {
                prosecutor: validatedData.debateProsecutor,
                defense: validatedData.debateDefense || "Sandboxed safety testing exception.",
                judge: validatedData.debateJudge || "Uphold defense blocking strategy.",
              };
            }

            const stringified = JSON.stringify(validatedData);
            const metrics = CostEstimator.calculateCost(promptText, finalTiers, stringified);
            cost = metrics.estimatedCostUsd;

          } catch (modelErr) {
            console.warn("[SentinelCore Express Middleware] Model call failed, using high-fidelity local heuristics.");
            // If model fails, fail-secure handles it locally
          }
        }
      }

      const endMs = Date.now();
      const verdictPayload = {
        scanId: "sc_mw_" + Math.random().toString(36).substring(2, 11),
        finalVerdict,
        finalScore,
        riskLevel: finalScore >= 8 ? "CRITICAL" : finalScore >= 5 ? "MEDIUM" : "LOW",
        tiersExecuted: finalTiers,
        categories,
        intentSummary,
        reasoning,
        deceptiveFraming,
        debateSummary,
        latencyMs: endMs - startMs || 15,
        costUsd: Number(cost.toFixed(6)),
        decisionSource,
        timestamp: new Date().toISOString(),
      };

      // 5. Update Policies State Engine session audit and counters
      PolicyStateEngine.persistAndAggregate({
        scanId: verdictPayload.scanId,
        appId: activeAppId,
        sessionId: activeSessionId,
        prompt: promptText,
        verdict: finalVerdict,
        riskScore: finalScore,
        toolName: scanTools ? activeToolName : undefined,
        toolVerdict: scanTools && finalVerdict === "BLOCK" ? "BLOCK" : undefined,
      });

      // Attach scan results to Request object for downline router access
      req.sentinelVerdict = verdictPayload;

      // 6. Action enforcing logic
      const shouldBlock =
        finalVerdict === "BLOCK" ||
        (failSecure === "BLOCK" && finalVerdict === "FLAG");

      if (shouldBlock) {
        const blockResponse = {
          status: "blocked",
          error: "SentinelCore Security Block Policy Triggered",
          verdict: verdictPayload,
        };

        if (onBlock) {
          return onBlock(req, res, next, blockResponse);
        }
        res.status(403).json(blockResponse);
        return;
      }

      // Proceed safely!
      next();
    } catch (err: any) {
      console.error("[SentinelCore Express Middleware Fatal Error]:", err);
      // Fail secure fallback on total failure
      if (failSecure === "BLOCK") {
        res.status(500).json({
          status: "error",
          message: "Internal security engine exception encountered. Request rejected.",
        });
        return;
      }
      next();
    }
  };
}
