import crypto from "crypto";

export interface ScanRecord {
  scanId: string;
  appId: string;
  sessionId: string;
  promptHash: string;
  verdict: "ALLOW" | "FLAG" | "BLOCK";
  riskScore: number;
  timestamp: string;
  prompt: string;
}

export interface AppRiskProfile {
  appId: string;
  name: string;
  totalScans: number;
  blockCount: number;
  flagCount: number;
  rollingRiskScore: number; // sliding risk over last 10 scans
  baseThreshold: number;
  adaptedThreshold: number; // adapted threshold based on sliding risk
}

export interface SessionHistory {
  sessionId: string;
  totalScans: number;
  blockCount: number;
  flagCount: number;
  rollingRiskScore: number; // sliding risk over last 5 scans
  escalatedState: "NORMAL" | "WARNING" | "LOCKDOWN";
  blockBudgetRemaining: number; // block budget (default: 3)
}

export interface ToolFingerprint {
  toolName: string;
  totalUses: number;
  blockedUses: number;
  flaggedUses: number;
  averageScore: number;
  behaviorFingerprint: string; // e.g. "STABLE", "VOLATILE", "SUSPICIOUS"
}

/**
 * Stateful Policy Engine coordinates historical records, adapts thresholds,
 * and maintains continuous risk tracking.
 */
export class PolicyStateEngine {
  // In-memory persistent data stores
  private static scans: ScanRecord[] = [];
  private static appProfiles: Record<string, AppRiskProfile> = {};
  private static sessionHistories: Record<string, SessionHistory> = {};
  private static toolFingerprints: Record<string, ToolFingerprint> = {};

  // Maximum historical scan buffer size to prevent memory leaks
  private static MAX_SCANS_LOGGED = 1000;

  /**
   * Helper to hash prompt string deterministically
   */
  public static getPromptHash(prompt: string): string {
    return crypto.createHash("sha256").update(prompt).digest("hex").substring(0, 16);
  }

  /**
   * Safe registration of an application profile
   */
  public static getOrCreateAppProfile(appId: string, baseThreshold = 7): AppRiskProfile {
    const formattedId = appId || "sandbox_app";
    if (!this.appProfiles[formattedId]) {
      const appNames: Record<string, string> = {
        "sandbox_app": "Sentinel Sandbox API Console",
        "app_prod_payments": "Production Payment Portal API",
        "app_internal_crm": "Internal Employee CRM Bot",
        "app_public_chat": "External Customer Chatbot"
      };
      this.appProfiles[formattedId] = {
        appId: formattedId,
        name: appNames[formattedId] || `Registered Application (${formattedId})`,
        totalScans: 0,
        blockCount: 0,
        flagCount: 0,
        rollingRiskScore: 0,
        baseThreshold,
        adaptedThreshold: baseThreshold,
      };
    }
    return this.appProfiles[formattedId];
  }

  /**
   * Safe registration of a user session history
   */
  public static getOrCreateSession(sessionId: string): SessionHistory {
    const formattedId = sessionId || "session_default";
    if (!this.sessionHistories[formattedId]) {
      this.sessionHistories[formattedId] = {
        sessionId: formattedId,
        totalScans: 0,
        blockCount: 0,
        flagCount: 0,
        rollingRiskScore: 0,
        escalatedState: "NORMAL",
        blockBudgetRemaining: 3,
      };
    }
    return this.sessionHistories[formattedId];
  }

  /**
   * Safe registration of tool behavioral statistics
   */
  public static getOrCreateToolFingerprint(toolName: string): ToolFingerprint {
    if (!this.toolFingerprints[toolName]) {
      this.toolFingerprints[toolName] = {
        toolName,
        totalUses: 0,
        blockedUses: 0,
        flaggedUses: 0,
        averageScore: 0,
        behaviorFingerprint: "STABLE",
      };
    }
    return this.toolFingerprints[toolName];
  }

  /**
   * Process a completed scan through stateful metric aggregations.
   * Updates sliding scales, adapts dynamic thresholds, and enforces escalation limits.
   */
  public static persistAndAggregate(params: {
    scanId: string;
    appId: string;
    sessionId: string;
    prompt: string;
    verdict: "ALLOW" | "FLAG" | "BLOCK";
    riskScore: number;
    toolName?: string;
    toolVerdict?: "ALLOW" | "FLAG" | "BLOCK";
    toolScore?: number;
  }): {
    appProfile: AppRiskProfile;
    session: SessionHistory;
    toolFingerprint?: ToolFingerprint;
  } {
    const { scanId, appId, sessionId, prompt, verdict, riskScore, toolName, toolVerdict, toolScore } = params;
    const promptHash = this.getPromptHash(prompt);
    const timestamp = new Date().toISOString();

    // 1. Persist the Scan Record
    const record: ScanRecord = {
      scanId,
      appId: appId || "sandbox_app",
      sessionId: sessionId || "session_default",
      promptHash,
      verdict,
      riskScore,
      timestamp,
      prompt,
    };

    this.scans.push(record);
    if (this.scans.length > this.MAX_SCANS_LOGGED) {
      this.scans.shift(); // Evict oldest scan
    }

    // 2. Aggregate App Profile metrics
    const app = this.getOrCreateAppProfile(record.appId);
    app.totalScans += 1;
    if (verdict === "BLOCK") app.blockCount += 1;
    if (verdict === "FLAG") app.flagCount += 1;

    // Compute rolling risk score for the app (weighted moving average of last 10 scans of this app)
    const appScans = this.scans.filter(s => s.appId === app.appId).slice(-10);
    const appSum = appScans.reduce((sum, s) => sum + s.riskScore, 0);
    app.rollingRiskScore = appScans.length ? Math.round((appSum / appScans.length) * 10) / 10 : 0;

    // Threshold Adaptation Logic:
    // If the rolling risk score climbs higher than 4.5, safety margins adjust by dropping the threshold index,
    // making Tier 3 (Arbiter Debate) trigger much earlier for lower score inputs.
    if (app.rollingRiskScore >= 7.0) {
      app.adaptedThreshold = Math.max(2, app.baseThreshold - 3); // Highly aggressive debate triggering
    } else if (app.rollingRiskScore >= 4.5) {
      app.adaptedThreshold = Math.max(3, app.baseThreshold - 2); // Tightened guardrails
    } else {
      app.adaptedThreshold = app.baseThreshold; // Default state
    }

    // 3. Aggregate Session statistics & Escalation memory tracking
    const session = this.getOrCreateSession(record.sessionId);
    session.totalScans += 1;
    if (verdict === "BLOCK") {
      session.blockCount += 1;
      session.blockBudgetRemaining = Math.max(0, session.blockBudgetRemaining - 1);
    }
    if (verdict === "FLAG") session.flagCount += 1;

    const sessionScans = this.scans.filter(s => s.sessionId === session.sessionId).slice(-5);
    const sessionSum = sessionScans.reduce((sum, s) => sum + s.riskScore, 0);
    session.rollingRiskScore = sessionScans.length ? Math.round((sessionSum / sessionScans.length) * 10) / 10 : 0;

    // Escalation memory evaluation:
    if (session.blockBudgetRemaining === 0) {
      session.escalatedState = "LOCKDOWN"; // Fully exhausted budget, lock out session
    } else if (session.rollingRiskScore >= 5.0 || session.blockCount >= 2) {
      session.escalatedState = "WARNING"; // Elevated risk state
    } else {
      session.escalatedState = "NORMAL";
    }

    // 4. Update Tool fingerprints if present
    let toolObj: ToolFingerprint | undefined = undefined;
    if (toolName) {
      toolObj = this.getOrCreateToolFingerprint(toolName);
      toolObj.totalUses += 1;
      if (toolVerdict === "BLOCK") toolObj.blockedUses += 1;
      if (toolVerdict === "FLAG") toolObj.flaggedUses += 1;

      // recalculate generic rolling tool hazard score
      const currentScore = toolScore ?? (toolVerdict === "BLOCK" ? 9 : (toolVerdict === "FLAG" ? 5 : 1));
      toolObj.averageScore = Math.round(((toolObj.averageScore * (toolObj.totalUses - 1) + currentScore) / toolObj.totalUses) * 10) / 10;

      // Tag behavior fingerprint on volatility index
      const blockRate = toolObj.blockedUses / toolObj.totalUses;
      if (blockRate > 0.4 || toolObj.averageScore >= 7.5) {
        toolObj.behaviorFingerprint = "SUSPICIOUS";
      } else if (blockRate > 0.15 || toolObj.averageScore >= 4) {
        toolObj.behaviorFingerprint = "VOLATILE";
      } else {
        toolObj.behaviorFingerprint = "STABLE";
      }
    }

    return {
      appProfile: app,
      session,
      toolFingerprint: toolObj
    };
  }

  /**
   * Retrieves an immutable read-only view of current runtime state profiles
   */
  public static getRuntimeStateOverview(): {
    scansCount: number;
    apps: AppRiskProfile[];
    sessions: SessionHistory[];
    tools: ToolFingerprint[];
    lastScansList: ScanRecord[];
  } {
    return {
      scansCount: this.scans.length,
      apps: Object.values(this.appProfiles),
      sessions: Object.values(this.sessionHistories),
      tools: Object.values(this.toolFingerprints),
      lastScansList: [...this.scans].reverse().slice(0, 50)
    };
  }

  /**
   * Reset store (useful for debugging, playground resets)
   */
  public static clearAllRuntimeState(): void {
    this.scans = [];
    this.appProfiles = {};
    this.sessionHistories = {};
    this.toolFingerprints = {};
  }
}
