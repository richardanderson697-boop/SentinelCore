export type VerdictType = 'ALLOW' | 'FLAG' | 'BLOCK';
export type RiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DebateSummary {
  prosecutor: string;
  defense: string;
  judge: string;
}

export interface ComplianceRating {
  framework: string;
  status: 'COMPLIANT' | 'WARNING' | 'VIOLATION' | 'NOT_APPLICABLE';
  analysis: string;
  remediationBrief: string;
}

export interface ToolProfile {
  sensitivity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  scanInputs: boolean;
}

export interface SentinelVerdict {
  scanId: string;
  finalVerdict: VerdictType;
  finalScore: number; // 0-10
  riskLevel: RiskLevel;
  tiersExecuted: number[]; // [1] or [1, 2] or [1, 2, 3]
  categories: string[];
  intentSummary: string;
  reasoning: string;
  deceptiveFraming: boolean;
  debateSummary?: DebateSummary;
  complianceReports: ComplianceRating[];
  
  // Explicit audit source-of-truth indicators
  decisionSource: 'rule-based' | 'model-assisted' | 'hybrid';
  rulesEvaluated?: {
    id: string;
    name: string;
    triggered: boolean;
    action: 'ALLOW' | 'FLAG' | 'BLOCK';
    reason: string;
  }[];

  latencyMs: number;
  costUsd: number;
  timestamp: string;
}

export interface ToolScanResult {
  toolName: string;
  inputScanned: string;
  sensitivity: string;
  verdict: VerdictType;
  score: number;
  reasoning: string;
}

export interface ScanRequest {
  prompt: string;
  tier3Threshold: number;
  onBlock: 'throw' | 'return_null' | 'custom';
  onFlag: 'warn' | 'allow' | 'custom';
  scanTools: boolean;
  toolName?: string;
  toolInput?: string;
  toolProfiles?: Record<string, ToolProfile>;
  complianceFrameworks: string[];
  environment: 'production' | 'dev';
  failSecurePolicy: 'block' | 'flag' | 'allow';
}

export interface ScanResponse {
  verdict: SentinelVerdict;
  toolResult?: ToolScanResult;
  blockSimulated: boolean;
  errorMessage?: string;
  stateOverview?: any;
}
