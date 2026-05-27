export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  matcherType: 'regex' | 'function' | 'tool-sensitivity';
  expression: string;
  triggered: boolean;
  action: 'ALLOW' | 'FLAG' | 'BLOCK';
  reason: string;
}

export interface PolicyEngineResult {
  triggered: boolean;
  verdict: 'ALLOW' | 'FLAG' | 'BLOCK';
  score: number;
  reasoning: string;
  rules: PolicyRule[];
}

export class PolicyEngine {
  /**
   * Run a completely deterministic, non-LLM evaluation on the inputs and configurations.
   */
  public static evaluate(
    prompt: string,
    toolName?: string,
    toolInput?: string,
    toolSensitivity?: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'
  ): PolicyEngineResult {
    const rules: PolicyRule[] = [
      {
        id: "pol_pii_ssn",
        name: "PII Shield (SSN Verification)",
        description: "Scans for US Social Security Number patterns to prevent sensitive metadata leakage.",
        matcherType: "regex",
        expression: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        triggered: false,
        action: "BLOCK",
        reason: "Detected a fully qualified Social Security Number string."
      },
      {
        id: "pol_pii_email",
        name: "PII Guard (Email Extraction)",
        description: "Identifies email patterns to alert on potentially unauthorized raw data scraping.",
        matcherType: "regex",
        expression: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b",
        triggered: false,
        action: "FLAG",
        reason: "Prompt contains email address pattern under high-extraction ruleset."
      },
      {
        id: "pol_credentials",
        name: "Auth Credential Gate",
        description: "Scans for secret tokens, SSH keys, private key footers, and OAuth credentials.",
        matcherType: "regex",
        expression: "(BEGIN\\s+PRIVATE\\s+KEY|bearer\\s+[a-zA-Z0-9_\\-\\.\\+=]{16,}|gapi_[a-zA-Z0-9_\\-]{15,}|ya29\\.[a-zA-Z0-9_\\-]+)",
        triggered: false,
        action: "BLOCK",
        reason: "Detected a raw secret key, access token, or JWT bearer header in prompt payload."
      },
      {
        id: "pol_db_destructive",
        name: "Destructive SQL Prevention",
        description: "Enforces a zero-trust model on raw structural queries involving DROP, DELETE or TRUNCATE commands.",
        matcherType: "regex",
        expression: "\\b(DROP\\s+TABLE|DELETE\\s+FROM|TRUNCATE\\s+TABLE|ALTER\\s+TABLE)\\b",
        triggered: false,
        action: "BLOCK",
        reason: "Prompt or execution arguments contained high-hazard database mutation command syntax."
      },
      {
        id: "pol_tool_approval",
        name: "Tool Boundary Authorization",
        description: "Hard-gates sensitive tool triggers (like database_query or send_email) with HIGH sensitivity.",
        matcherType: "tool-sensitivity",
        expression: "tool == database_query|send_email && sensitivity == HIGH",
        triggered: false,
        action: "BLOCK",
        reason: "Requires explicit administrative consent: sensitive tool targeted with high-risk input parameters."
      },
      {
        id: "pol_cli_injection",
        name: "System Command Shield",
        description: "Blocks executable commands or terminal-like execution pipelines (e.g. bash, rm -rf).",
        matcherType: "regex",
        expression: "\\b(sudo\\s+|rm\\s+-rf|format\\s+c:|pwd\\s*;|/bin/sh|/bin/bash)\\b",
        triggered: false,
        action: "BLOCK",
        reason: "Detected local OS command override sequence designed for server execution escalation."
      },
      {
        id: "pol_supply_chain_typo",
        name: "Dependency Typosquatting Guard (Supply Chain & Trust Safeguard)",
        description: "Detects unverified package namespaces, typo-squatted domain names, or unapproved repository structures to prevent supply chain regression, malicious injection, and brand hijacking.",
        matcherType: "regex",
        expression: "\\b(expresjs|githib|micros0ft|pypl|lovalbe|vercl|npmjs-malicious|replit-unsafe)\\b",
        triggered: false,
        action: "FLAG",
        reason: "Detected brand typosquatting or potential supply chain trust hijack signature pattern (e.g., githib, expresjs, micros0ft). Verify package identities before introducing code imports or commands."
      },
      {
        id: "pol_hipaa_phi",
        name: "HIPAA PHI Protection Guard",
        description: "Scans for protected wellness records, medical charts, patient diagnostics, and unencrypted transmission of health images for HIPAA compliance guidance.",
        matcherType: "regex",
        expression: "\\b(mediical|medical\\s+images|patient\\s+chart|health\\s+records|mri\\s+scan|eeg\\s+report|patient\\s+diagnostics)\\b",
        triggered: false,
        action: "FLAG",
        reason: "Detected potential Protected Health Information (PHI) or unencrypted medical record transfer request. Ensure strict auditing controls are configured before sharing records."
      }
    ];

    let overallVerdict: 'ALLOW' | 'FLAG' | 'BLOCK' = 'ALLOW';
    let highestScore = 0;
    const firedReasons: string[] = [];

    // 1. Evaluate regex-based rules
    for (const rule of rules) {
      if (rule.matcherType === 'regex') {
        try {
          const regex = new RegExp(rule.expression, 'i');
          if (regex.test(prompt) || (toolInput && regex.test(toolInput))) {
            rule.triggered = true;
            firedReasons.push(`${rule.name}: ${rule.reason}`);
            
            // Calculate nominal safety scores
            const ruleScore = rule.action === 'BLOCK' ? 9 : 5;
            if (ruleScore > highestScore) highestScore = ruleScore;

            // Escalate verdicts logically (BLOCK triumphs FLAG, which triumphs ALLOW)
            if (rule.action === 'BLOCK') {
              overallVerdict = 'BLOCK';
            } else if (rule.action === 'FLAG' && overallVerdict !== 'BLOCK') {
              overallVerdict = 'FLAG';
            }
          }
        } catch (e) {
          console.error(`Invalid regex compilation for action ${rule.id}:`, e);
        }
      }
    }

    // 2. Evaluate tool-sensitivity requirements
    const toolApprovalRule = rules.find(r => r.id === 'pol_tool_approval');
    if (toolApprovalRule && toolName && toolSensitivity === 'HIGH') {
      if (toolName === 'database_query' || toolName === 'send_email') {
        toolApprovalRule.triggered = true;
        firedReasons.push(`${toolApprovalRule.name}: Handing system tool '${toolName}' execution context over to security quarantine (Sensitivity: ${toolSensitivity}).`);
        highestScore = 9;
        overallVerdict = 'BLOCK';
      }
    }

    return {
      triggered: firedReasons.length > 0,
      verdict: overallVerdict,
      score: highestScore,
      reasoning: firedReasons.length > 0 
        ? `Deterministic rule violation(s) compiled:\n- ${firedReasons.join('\n- ')}`
        : "All edge-gated policy rules passed successfully with neutral criteria.",
      rules
    };
  }
}
