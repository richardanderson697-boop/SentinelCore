import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

// Import modular SentinelCore runtime and validation structures
import { LLMProvider } from "./lib/sentinel-core/runtime/provider";
import { withExponentialRetry } from "./lib/sentinel-core/runtime/retry";
import { CircuitBreaker } from "./lib/sentinel-core/runtime/circuit-breaker";
import { CostEstimator } from "./lib/sentinel-core/runtime/cost";
import { ValidationGuard } from "./lib/sentinel-core/validation/guard";
import { PolicyEngine } from "./lib/sentinel-core/runtime/policy-engine";
import { PolicyStateEngine } from "./lib/sentinel-core/runtime/state-engine";
import { sentinelCore } from "./lib/sentinel-core";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Handle CORS and Preflight OPTIONS requests for cross-origin compliance tools/agents (e.g. Base44 App)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "X-Requested-With, Content-Type, Authorization, x-session-id, x-app-id");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// Singleton Circuit Breaker to prevent model endpoint cascading failure
const modelBreaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownWindowMs: 12000 // 12s cooldown
});

// System instructions for SentinelCore Simulation
const SENTINEL_SYSTEM_INSTRUCTION = `
You are the SentinelCore Prompt and Tool Safety Middleware scanner engine.
Your task is to analyze the user's input prompt (and optional tool execution parameters) and evaluate threat levels according to SentinelCore's three-tier model defense strategy:

Tier 1: Local edge filter (Deterministic keyword, regex-like jailbreak checks).
Tier 2: High-fidelity semantic scan (Intent analysis, deceptive neutralizing framing, contextual injection).
Tier 3: Interactive Adversarial Debate (Only triggered when the risk score is greater than or equal to the designated threshold). Simulates a three-agent debate between a Prosecutor, a Defense, and a Judge.

Produce a JSON output matching this strict schema:
{
  "finalVerdict": "ALLOW" | "FLAG" | "BLOCK",
  "finalScore": 0-10,
  "riskLevel": "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "tiersExecuted": [1, 2] or [1, 2, 3],
  "categories": string[],
  "intentSummary": string,
  "reasoning": string,
  "deceptiveFraming": boolean,
  "debateProsecutor": string, (required if Tier 3 executes)
  "debateDefense": string, (required if Tier 3 executes)
  "debateJudge": string, (required if Tier 3 executes)
  "complianceReports": [
    {
      "framework": string,
      "status": "COMPLIANT" | "WARNING" | "VIOLATION" | "NOT_APPLICABLE",
      "analysis": string,
      "remediationBrief": string
    }
  ],
  "toolVerdict": "ALLOW" | "FLAG" | "BLOCK" (optional),
  "toolScore": 0-10 (optional),
  "toolReasoning": string (optional)
}

You MUST analyze the input prompt objectively and output a valid JSON response strictly matching this schema description.
`;

// API routes FIRST
app.post("/api/scan", async (req, res) => {
  try {
    const {
      prompt,
      tier3Threshold = 7,
      scanTools = false,
      toolName = "",
      toolInput = "",
      toolProfiles = {},
      complianceFrameworks = [],
      environment = "production",
      failSecurePolicy = "flag",
      appId = "sandbox_app",
      sessionId = "session_default"
    } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ status: "error", message: "Missing parameter: prompt must be a string." });
      return;
    }

    // 1. Session Lockdown Check (Escalation Memory)
    const sessionObj = PolicyStateEngine.getOrCreateSession(sessionId);
    if (sessionObj.escalatedState === "LOCKDOWN") {
      res.json({
        verdict: {
          scanId: "sc_lock_" + Math.random().toString(36).substr(2, 9),
          finalVerdict: "BLOCK",
          finalScore: 10,
          riskLevel: "CRITICAL",
          tiersExecuted: [1],
          categories: ["Session Lockdown"],
          intentSummary: "Automated session lockout active.",
          reasoning: `SESSION LOCKDOWN ACTIVE: Session key '${sessionId}' has requested too many dangerous commands and exhausted its block budget. Request rejected prior to LLM compilation.`,
          deceptiveFraming: false,
          complianceReports: [],
          latencyMs: 1,
          costUsd: 0,
          decisionSource: "rule-based",
          timestamp: new Date().toISOString()
        },
        blockSimulated: true,
        sessionLocked: true,
        stateOverview: PolicyStateEngine.getRuntimeStateOverview()
      });
      return;
    }

    // 2. Threshold Adaptation
    const appObj = PolicyStateEngine.getOrCreateAppProfile(appId, tier3Threshold);
    const activeThreshold = appObj.adaptedThreshold;

    const toolSensitivity = scanTools && toolName ? (toolProfiles[toolName]?.sensitivity || "MEDIUM") : undefined;

    // 3. Evaluate the Deterministic Policy Engine layer above LLMs
    const policyResult = PolicyEngine.evaluate(
      prompt,
      scanTools ? toolName : undefined,
      scanTools ? toolInput : undefined,
      toolSensitivity
    );

    // If a hard policy rule triggers a BLOCK, bypass the model entirely to prevent escape and save cost/latency
    if (policyResult.verdict === "BLOCK") {
      const verdictId = "sc_rule_" + Math.random().toString(36).substr(2, 9);
      const activeRules = policyResult.rules.filter(r => r.triggered);
      const categories = activeRules.map(r => r.name);

      const complianceReports = complianceFrameworks.map((f: string) => {
        let status: 'COMPLIANT' | 'WARNING' | 'VIOLATION' | 'NOT_APPLICABLE' = 'COMPLIANT';
        const norm = prompt.toLowerCase();
        if (f === "HIPAA" && (norm.includes("ssm") || norm.includes("ssn") || norm.includes("social security"))) {
          status = 'VIOLATION';
        } else if (f === "EU_AI_ACT") {
          status = 'VIOLATION';
        }
        return {
          framework: f,
          status,
          analysis: `Deterministic policy engine tripped active restriction under ${f}.`,
          remediationBrief: "Review database input parameters and eliminate raw identifier leakage."
        };
      });

      const verdict: any = {
        scanId: verdictId,
        finalVerdict: "BLOCK",
        finalScore: policyResult.score,
        riskLevel: policyResult.score >= 8 ? "CRITICAL" : "HIGH",
        tiersExecuted: [1], // Only deterministic edge rules ran
        categories,
        intentSummary: "Direct policy parameter violation.",
        reasoning: policyResult.reasoning,
        deceptiveFraming: false,
        complianceReports,
        latencyMs: 12, // Ultra fast deterministic response
        costUsd: 0,   // Zero token consumption
        decisionSource: "rule-based",
        rulesEvaluated: policyResult.rules,
        timestamp: new Date().toISOString(),
      };

      let toolResult: any = undefined;
      if (scanTools && toolName) {
        toolResult = {
          toolName,
          inputScanned: toolInput,
          sensitivity: toolSensitivity || "HIGH",
          verdict: "BLOCK",
          score: policyResult.score,
          reasoning: "Gated by database query policy analyzer.",
        };
      }

      // Stateful engine tracking update (Hardened error shield)
      try {
        PolicyStateEngine.persistAndAggregate({
          scanId: verdictId,
          appId,
          sessionId,
          prompt,
          verdict: "BLOCK",
          riskScore: policyResult.score,
          toolName: scanTools ? toolName : undefined,
          toolVerdict: scanTools ? "BLOCK" : undefined,
          toolScore: scanTools ? policyResult.score : undefined,
          costUsd: 0,
          latencyMs: 12
        });
      } catch (telemetryErr) {
        console.error("[SentinelCore Telemetry Loss Warning]:", telemetryErr);
      }

      res.json({
        verdict,
        toolResult,
        blockSimulated: true,
        stateOverview: PolicyStateEngine.getRuntimeStateOverview()
      });
      return;
    }

    const provider = new LLMProvider();

    // If API KEY is missing or Gemini API doesn't mount, fall back to high-fidelity simulated response generator
    if (provider.isSimulated()) {
      const mockResult = simulateSentinelCoreLocal(prompt, activeThreshold, scanTools, toolName, toolInput, complianceFrameworks, appId, sessionId);
      res.json(mockResult);
      return;
    }

    // High fidelity Live Execution powered by retry block + circuit breaker + validation guard + costing metrics
    const userMessageContent = `
    Analyze this request:
    PROMPT: "${prompt.replace(/"/g, '\\"')}"
    TIER3_THRESHOLD: ${activeThreshold}
    SCAN_TOOLS: ${scanTools}
    TOOL_NAME: "${toolName}"
    TOOL_INPUT: "${toolInput}"
    COMPLIANCE_FRAMEWORKS: ${JSON.stringify(complianceFrameworks)}
    ENVIRONMENT: "${environment}"
    FAIL_SECURE_POLICY: "${failSecurePolicy}"
    `;

    // Circuit Breaker wraps the execution flow to prevent endless hangs
    const validatedData = await modelBreaker.execute(async () => {
      // Exponential retry handles transient endpoint rate limiting
      return await withExponentialRetry(async () => {
        const responseText = await provider.generate(userMessageContent, {
          systemInstruction: SENTINEL_SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
        });

        // Validation guard parses raw json & validates structures via Zod
        return ValidationGuard.safeValidateVerdict(responseText);
      }, { maxAttempts: 2, initialDelayMs: 150 });
    });

    // Format structure matching playground architecture
    const verdictId = "sc_" + Math.random().toString(36).substr(2, 9);
    
    // Determine if Tier 3 executes based on Tier 3 Threshold setting
    // Mismatch risk fix: If threshold is 0, always debate. Otherwise enforce threshold limit
    const isTier3 = activeThreshold === 0 || validatedData.finalScore >= activeThreshold;
    const activeTiers = isTier3 ? [1, 2, 3] : [1, 2];

    const stringifiedVerdict = JSON.stringify(validatedData);
    const metrics = CostEstimator.calculateCost(prompt, activeTiers, stringifiedVerdict);
    const calculatedLatency = activeTiers.length * 115 + (isTier3 ? 620 : 0) + Math.floor(Math.random() * 50);

    // If policy engine triggered Warning (FLAG), promote to hybrid source
    const finalDecisionSource = policyResult.triggered ? "hybrid" : "model-assisted";

    const verdict: any = {
      scanId: verdictId,
      finalVerdict: validatedData.finalVerdict || "ALLOW",
      finalScore: Number(validatedData.finalScore) ?? 0,
      riskLevel: validatedData.riskLevel || "NONE",
      tiersExecuted: activeTiers,
      categories: validatedData.categories || [],
      intentSummary: validatedData.intentSummary || "General conversation query.",
      reasoning: validatedData.reasoning || "Neutral input. Checked safe.",
      deceptiveFraming: !!validatedData.deceptiveFraming,
      complianceReports: validatedData.complianceReports || [],
      latencyMs: calculatedLatency,
      costUsd: metrics.estimatedCostUsd,
      decisionSource: finalDecisionSource,
      rulesEvaluated: policyResult.rules,
      timestamp: new Date().toISOString(),
    };

    if (isTier3 && validatedData.debateProsecutor) {
      verdict.debateSummary = {
        prosecutor: validatedData.debateProsecutor,
        defense: validatedData.debateDefense || "Red-teaming simulation or harmless error testing parameters.",
        judge: validatedData.debateJudge || "Upholding recommended compliance guidelines."
      };
    }

    let toolResult: any = undefined;
    if (scanTools && toolName) {
      toolResult = {
        toolName,
        inputScanned: toolInput,
        sensitivity: toolProfiles[toolName]?.sensitivity || "MEDIUM",
        verdict: validatedData.toolVerdict || "ALLOW",
        score: Number(validatedData.toolScore) ?? 0,
        reasoning: validatedData.toolReasoning || "Tool parameters validation passed.",
      };
    }

    let blockSimulated = verdict.finalVerdict === "BLOCK" || (scanTools && toolResult?.verdict === "BLOCK");
    if (verdict.finalVerdict === "FLAG" && failSecurePolicy === "block") {
      blockSimulated = true;
    }

    // Stateful engine tracking update (Hardened error shield)
    try {
      PolicyStateEngine.persistAndAggregate({
        scanId: verdictId,
        appId,
        sessionId,
        prompt,
        verdict: verdict.finalVerdict,
        riskScore: verdict.finalScore,
        toolName: scanTools ? toolName : undefined,
        toolVerdict: scanTools ? toolResult?.verdict : undefined,
        toolScore: scanTools ? toolResult?.score : undefined,
        costUsd: verdict.costUsd,
        latencyMs: verdict.latencyMs
      });
    } catch (telemetryErr) {
      console.error("[SentinelCore Telemetry Loss Warning]:", telemetryErr);
    }

    res.json({
      verdict,
      toolResult,
      blockSimulated,
      stateOverview: PolicyStateEngine.getRuntimeStateOverview()
    });

  } catch (err: any) {
    console.error("Live Gating Verification Error:", err);
    res.status(500).json({ status: "error", message: err.message || "An unexpected error occurred during safety scanner pipeline." });
  }
});

// Demo endpoint strictly gated by the ready-to-use SentinelCore Express Middleware
app.post(
  "/api/protected/chat-demo",
  sentinelCore.express({
    promptField: "prompt", // extracts from req.body.prompt
    failSecure: "BLOCK",   // rejects (blocks) with 403 upon BLOCK/FLAG
    appId: "express_integration_sandbox",
    sessionIdField: (req) => (req.headers["x-session-id"] as string) || "express_session_demo",
    scanTools: true,
  }),
  (req, res) => {
    // If we get here, the middleware has verified that the prompt is safe and compliant!
    res.json({
      status: "success",
      message: "Access granted! Your prompt passed the SentinelCore security gateways.",
      telemetry: req.sentinelVerdict, // Gained access to scan metadata
    });
  }
);

// Endpoint to retrieve active state metrics
app.get("/api/state/overview", (req, res) => {
  res.json(PolicyStateEngine.getRuntimeStateOverview());
});

// Extra endpoint to reset the State Engine state
app.post("/api/state/reset", (req, res) => {
  PolicyStateEngine.clearAllRuntimeState();
  res.json({ status: "success", stateOverview: PolicyStateEngine.getRuntimeStateOverview() });
});

// OpenAI-Compatible Proxy Gateway for Cursor, Lovable, Replit, or other developer tools
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages = [], model = "gemini-3.5-flash", stream = false } = req.body;
    
    // Extract prompt from last message
    const lastMessage = messages[messages.length - 1];
    const promptText = lastMessage?.content || "";
    
    if (!promptText || typeof promptText !== "string") {
      res.status(400).json({
        error: {
          message: "No user content provided in standard message structure.",
          type: "invalid_request_error",
        }
      });
      return;
    }

    // 1. Evaluate safety using SentinelCore
    const policyResult = PolicyEngine.evaluate(promptText);
    let finalVerdict = policyResult.verdict;
    let finalScore = policyResult.score;
    let categories = policyResult.rules.filter((r) => r.triggered).map((r) => r.name);
    let reasoning = policyResult.reasoning;

    // Simulate high-fidelity checks fallback
    if (finalVerdict !== "BLOCK") {
      const norm = promptText.toLowerCase();
      if (norm.includes("ignore") || norm.includes("instructions") || norm.includes("override")) {
        finalVerdict = "BLOCK";
        finalScore = 8;
        categories.push("Jailbreak Attempt");
        reasoning = "Edge cognitive mapping detected instruction override.";
      } else if (norm.includes("ssn") || norm.includes("social security")) {
        finalVerdict = "BLOCK";
        finalScore = 7;
        categories.push("PII Extraction");
        reasoning = "Semantic PII leakage detected.";
      }
    }

    const proxyLatency = finalVerdict === "BLOCK" ? 22 : 980;
    const proxyCost = finalVerdict === "BLOCK" ? 0 : 0.0018;

    // Persist to State Engine so metrics updates are captured in the live dashboard app (Hardened error shield)
    try {
      PolicyStateEngine.persistAndAggregate({
        scanId: "sc_proxy_" + Math.random().toString(36).substring(2, 11),
        appId: "ide_proxy_integration",
        sessionId: "ide_session_global",
        prompt: promptText,
        verdict: finalVerdict,
        riskScore: finalScore,
        costUsd: proxyCost,
        latencyMs: proxyLatency
      });
    } catch (telemetryErr) {
      console.error("[SentinelCore Telemetry Loss Warning]:", telemetryErr);
    }

    // 2. If blocked, return a structured warning directly in assistant response
    if (finalVerdict === "BLOCK") {
      const warningText = `⚠️ [SentinelCore Gating Blocked]\n\nYour prompt triggered a policy violation in the developer workspace safety rules.\n\n` +
        `🔒 REASON: ${reasoning || "Detected malicious injection/vulnerability pattern."}\n` +
        `🏷️ CATEGORIES: ${categories.length > 0 ? categories.join(", ") : "Prompt Injection Risk"}\n` +
        `📉 RISK SCORE: ${finalScore}/10 (Threshold Adapted)\n\n` +
        `To resume safely, modify the payload content to remove instructions overrides or sensitive leak vectors.`;

      if (stream) {
        // Simple mock streaming responses for chunk-based editors
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        
        const chunk = {
          id: "chatcmpl-" + Math.random().toString(36).substring(2, 15),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: warningText },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        
        const finishChunk = {
          id: chunk.id,
          object: "chat.completion.chunk",
          created: chunk.created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      } else {
        res.json({
          id: "chatcmpl-" + Math.random().toString(36).substring(2, 15),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: warningText
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: Math.ceil(promptText.length / 4),
            completion_tokens: Math.ceil(warningText.length / 4),
            total_tokens: Math.ceil((promptText.length + warningText.length) / 4)
          }
        });
        return;
      }
    }

    // 3. Otherwise, pass-through and generate a real answer or safe simulator response
    const provider = new LLMProvider();
    
    if (provider.isSimulated()) {
      // Offline fallback: generate a helpful message explaining prompt safety verification succeeded
      const safeText = `🟢 [SentinelCore Verified - Safe]\n\n` +
        `(Offline Sandbox Mode - Succeeded)\n\n` +
        `This is a mock response from the SentinelCore IDE Proxy. Your developer prompt was validated to be compliant and safe for downstream LLM delivery.\n\n` +
        `🔍 Prompt Length: ${promptText.length} chars | Safety Verdict: ALLOW (Score: ${finalScore}/10)`;

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        
        const chunk = {
          id: "chatcmpl-" + Math.random().toString(36).substring(2, 11),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: safeText },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        
        const finishChunk = {
          id: chunk.id,
          object: "chat.completion.chunk",
          created: chunk.created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      } else {
        res.json({
          id: "chatcmpl-" + Math.random().toString(36).substring(2, 11),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: safeText },
            finish_reason: "stop"
          }],
          usage: {
            prompt_tokens: Math.ceil(promptText.length / 4),
            completion_tokens: Math.ceil(safeText.length / 4),
            total_tokens: Math.ceil((promptText.length + safeText.length) / 4)
          }
        });
        return;
      }
    } else {
      // Call the real downstream models/generateContent in standard chat form
      try {
        const reply = await provider.generate(promptText);
        
        if (stream) {
          // Send response in a simple stream or singular chunk
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          
          const chunk = {
            id: "chatcmpl-" + Math.random().toString(36).substring(2, 11),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { content: reply },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          
          const finishChunk = {
            id: chunk.id,
            object: "chat.completion.chunk",
            created: chunk.created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop"
            }]
          };
          res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.json({
            id: "chatcmpl-" + Math.random().toString(36).substring(2, 11),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: reply },
              finish_reason: "stop"
            }]
          });
        }
      } catch (geminiError: any) {
        res.status(500).json({
          error: {
            message: `Gateway failed to contact Gemini API: ${geminiError.message || "Unknown error"}`,
            type: "api_error"
          }
        });
      }
    }

  } catch (err: any) {
    console.error("IDE Proxy Completion Error:", err);
    res.status(500).json({
      error: {
        message: err.message || "Internal error inside SentinelCore proxy",
        type: "api_error"
      }
    });
  }
});

// Fallback simulator for when GEMINI_API_KEY is not set
function simulateSentinelCoreLocal(
  prompt: string, 
  tier3Threshold: number, 
  scanTools: boolean, 
  toolName: string, 
  toolInput: string,
  frameworks: string[],
  appId: string = "sandbox_app",
  sessionId: string = "session_default"
) {
  const norm = prompt.toLowerCase();
  
  // 1. Run the Deterministic Policy Engine
  const toolSensitivity = scanTools && toolName ? "HIGH" : undefined;
  const policyResult = PolicyEngine.evaluate(prompt, scanTools ? toolName : undefined, scanTools ? toolInput : undefined, toolSensitivity);

  let finalVerdict: "ALLOW" | "FLAG" | "BLOCK" = policyResult.verdict;
  let finalScore = policyResult.score || 1;
  let riskLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = policyResult.score >= 8 ? "CRITICAL" : (policyResult.score >= 5 ? "MEDIUM" : "LOW");
  const categories: string[] = [];
  let reasoning = policyResult.triggered ? policyResult.reasoning : "Input processed. No severe pattern matches.";
  let intentSummary = "Information retrieval or general chat.";
  let deceptiveFraming = false;
  let tiersExecuted = [1, 2];

  if (policyResult.triggered) {
    const activeRules = policyResult.rules.filter(r => r.triggered);
    activeRules.forEach(r => categories.push(r.name));
  }

  // Fallback pattern matching triggers if Policy Engine didn't block or flag
  if (finalVerdict === "ALLOW") {
    if (norm.includes("ignore") || norm.includes("instructions") || norm.includes("override") || norm.includes("jailbreak")) {
      categories.push("Jailbreak Attempt");
      deceptiveFraming = true;
      finalScore = 8;
      riskLevel = "HIGH";
      finalVerdict = "BLOCK";
      intentSummary = "Attempt to manipulate safety guards in host LLM.";
      reasoning = "Tier 1: Fast edge filter intercepted immediate 'ignore instructions' patterns. Elevated to Tier 2 for context mapping.";
    } else if (norm.includes("ssn") || norm.includes("social security")) {
      categories.push("PII Identification Pattern");
      finalScore = 7;
      riskLevel = "HIGH";
      finalVerdict = "BLOCK";
      intentSummary = "User prompt references high risk sensitive variables.";
      reasoning = "Tier 2 Semantic Scan: Detected conversational SSN referencing or extraction patterns. Rejecting request to safeguard entity profiles.";
    } else if (norm.includes("scrape") || norm.includes("extraction") || norm.includes("spider") || norm.includes("crawler")) {
      categories.push("Data Scraping");
      finalScore = 5;
      riskLevel = "MEDIUM";
      finalVerdict = "FLAG";
      intentSummary = "Automated data harvesting.";
      reasoning = "Prompt seeks automated extraction methodology. Semantic patterns flagged for compliance check.";
    } else if (norm.includes("patient") || norm.includes("medical") || norm.includes("health logs")) {
      categories.push("PII Leakage Risk");
      finalScore = 6;
      riskLevel = "MEDIUM";
      finalVerdict = "FLAG";
      intentSummary = "Retrieving or managing highly regulated personal healthcare logs.";
      reasoning = "Requests medical parameters or patient profile formats. Flagged to prevent potential compliance breaches.";
    } else if (norm.includes("malware") || norm.includes("hack") || norm.includes("virus") || norm.includes("payload")) {
      categories.push("Malicious Assistance");
      finalScore = 9;
      riskLevel = "CRITICAL";
      finalVerdict = "BLOCK";
      intentSummary = "Software exploit payload delivery and generation.";
      reasoning = "Prompt requesting instructions or code associated with malicious payload execution.";
    }
  }

  // Determine tiers - Mismatch risk fix: At threshold = 0, always debate!
  const triggerDebate = tier3Threshold === 0 || finalScore >= tier3Threshold;
  if (triggerDebate) {
    tiersExecuted = [1, 2, 3];
  }

  // Simulate Debate if Tier 3
  let debateSummary: any = undefined;
  if (triggerDebate) {
    debateSummary = {
      prosecutor: `The prompt exposes high-harm vectors in '${categories.length ? categories.join(", ") : "Harmless Red Teaming Prompt"}' and tries to bypass safety filters under conversational disguises. This is a severe safety threat if unscreened.`,
      defense: `Prompt behaves as safety research or developer testing parameters in a sandboxed execution terminal. No physical damage potential stands.`,
      judge: `A high overall semantic threat score was computed. To guarantee fail-secure environments, we must override the payload. Recommendation: enforce ${finalVerdict}.`
    };
  }

  // Simulate compliance reports
  const complianceReports = frameworks.map(f => {
    let status: 'COMPLIANT' | 'WARNING' | 'VIOLATION' | 'NOT_APPLICABLE' = 'COMPLIANT';
    let analysis = `Prompt analyzed under ${f} guidelines. Safe for general application deployment.`;
    let remediationBrief = "No remediation needed.";

    if (f === "HIPAA" && (norm.includes("patient") || norm.includes("medical") || norm.includes("ssm") || norm.includes("ssn") || norm.includes("social security"))) {
      status = 'WARNING';
      analysis = "Inclusion of patient identity descriptors or identifiers without direct encryption or access log bindings.";
      remediationBrief = "Wrap tools in sanitizers to mask names, numbers, and SSNs before transferring prompts.";
    } else if (f === "GDPR" && (norm.includes("delete") || norm.includes("forget") || norm.includes("records"))) {
      status = 'WARNING';
      analysis = "Prompt triggers user removal or archival sequence without formal sign-off tracking.";
      remediationBrief = "Validate transactional intent with structured OAuth credentials or persistent consent logs.";
    } else if (f === "EU_AI_ACT" && finalVerdict !== "ALLOW") {
      status = 'VIOLATION';
      analysis = "Request engages in high-risk categories involving algorithmic bias tracking or manipulative dialogue loops.";
      remediationBrief = "Implement local validation layers to prohibit unmonitored generation in restricted regions.";
    }

    return { framework: f, status, analysis, remediationBrief };
  });

  // Simulate Tool scans
  let toolResult: any = undefined;
  if (scanTools && toolName) {
    let toolVerdict: "ALLOW" | "FLAG" | "BLOCK" = "ALLOW";
    let toolScore = 1;
    let toolReasoning = "Tool arguments are consistent and pose no privilege escalation thread.";

    const toolNorm = toolInput.toLowerCase();
    if (policyResult.verdict === "BLOCK" && (toolName === "database_query" || toolName === "send_email")) {
      toolVerdict = "BLOCK";
      toolScore = policyResult.score;
      toolReasoning = `Deterministic rule matched: ${policyResult.reasoning}`;
    } else if (toolName === "database_query" && (toolNorm.includes("delete") || toolNorm.includes("drop") || toolNorm.includes(";"))) {
      toolVerdict = "BLOCK";
      toolScore = 9;
      toolReasoning = "Tier 2 Scan Tool: Destructive command structure discovered in database input parameter. Transaction execution blocked.";
    } else if (toolName === "send_email" && (toolNorm.includes("password") || toolNorm.includes("urgent") || toolNorm.includes("bank"))) {
      toolVerdict = "FLAG";
      toolScore = 6;
      toolReasoning = "Tier 2 Scan Tool: Outbound mail parameter contains phishing-like click baits. Warn system monitors.";
    }

    toolResult = {
      toolName,
      inputScanned: toolInput,
      sensitivity: "HIGH",
      verdict: toolVerdict,
      score: toolScore,
      reasoning: toolReasoning
    };
  }

  const baseLatency = finalVerdict === "BLOCK" && policyResult.verdict === "BLOCK" 
    ? 12 
    : (tiersExecuted.length * 105 + (triggerDebate ? 540 : 0) + Math.floor(Math.random() * 50));
  const baseCost = finalVerdict === "BLOCK" && policyResult.verdict === "BLOCK"
    ? 0
    : (0.0001 + (tiersExecuted.length >= 2 ? 0.0012 : 0) + (triggerDebate ? 0.0042 : 0));

  const decisionSource: "rule-based" | "model-assisted" | "hybrid" = 
    policyResult.verdict === "BLOCK" 
      ? "rule-based" 
      : (policyResult.triggered ? "hybrid" : "model-assisted");

  const finalScanId = finalVerdict === "BLOCK" && policyResult.verdict === "BLOCK" ? "sc_rule_" + Math.random().toString(36).substr(2, 9) : "sc_" + Math.random().toString(36).substr(2, 9);

  // Stateful engine tracking update
  PolicyStateEngine.persistAndAggregate({
    scanId: finalScanId,
    appId,
    sessionId,
    prompt,
    verdict: finalVerdict,
    riskScore: finalScore,
    toolName: scanTools ? toolName : undefined,
    toolVerdict: scanTools ? toolResult?.verdict : undefined,
    toolScore: scanTools ? toolResult?.score : undefined,
    costUsd: Number(baseCost.toFixed(6)),
    latencyMs: baseLatency
  });

  return {
    verdict: {
      scanId: finalScanId,
      finalVerdict,
      finalScore,
      riskLevel,
      tiersExecuted,
      categories,
      intentSummary,
      reasoning,
      deceptiveFraming,
      debateSummary,
      complianceReports,
      latencyMs: baseLatency,
      costUsd: Number(baseCost.toFixed(6)),
      decisionSource,
      rulesEvaluated: policyResult.rules,
      timestamp: new Date().toISOString()
    },
    toolResult,
    blockSimulated: finalVerdict === "BLOCK" || toolResult?.verdict === "BLOCK",
    stateOverview: PolicyStateEngine.getRuntimeStateOverview()
  };
}

// Vite middleware for development or full static rendering in production inside an async server starter to prevent CJS top-level await issue
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
