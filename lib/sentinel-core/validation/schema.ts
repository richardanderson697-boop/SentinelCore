import { z } from "zod";

export const VerdictTypeSchema = z.enum(["ALLOW", "FLAG", "BLOCK"]);
export const RiskLevelSchema = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const ComplianceReportSchema = z.object({
  framework: z.string(),
  status: z.enum(["COMPLIANT", "WARNING", "VIOLATION", "NOT_APPLICABLE"]),
  analysis: z.string(),
  remediationBrief: z.string(),
});

export const DebateSummarySchema = z.object({
  prosecutor: z.string(),
  defense: z.string(),
  judge: z.string(),
});

/**
 * Standard Zod Schema for strict upstream runtime safety evaluation validation
 */
export const SentinelVerdictSchema = z.object({
  finalVerdict: VerdictTypeSchema,
  finalScore: z.number().min(0).max(10),
  riskLevel: RiskLevelSchema,
  tiersExecuted: z.array(z.number()),
  categories: z.array(z.string()),
  intentSummary: z.string(),
  reasoning: z.string(),
  deceptiveFraming: z.boolean(),
  debateProsecutor: z.string().optional(),
  debateDefense: z.string().optional(),
  debateJudge: z.string().optional(),
  complianceReports: z.array(ComplianceReportSchema).default([]),
  
  // Explicit audit source-of-truth indicators
  decisionSource: z.enum(["rule-based", "model-assisted", "hybrid"]).default("model-assisted"),
  rulesEvaluated: z.array(z.object({
    id: z.string(),
    name: z.string(),
    triggered: z.boolean(),
    action: z.enum(["ALLOW", "FLAG", "BLOCK"]),
    reason: z.string()
  })).optional(),

  // Optional parameters injected by tools or context scans
  toolVerdict: VerdictTypeSchema.optional(),
  toolScore: z.number().min(0).max(10).optional(),
  toolReasoning: z.string().optional(),
});

export type SentinelVerdictData = z.infer<typeof SentinelVerdictSchema>;
