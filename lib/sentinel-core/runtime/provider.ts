import { GoogleGenAI } from "@google/genai";

export interface LLMRequestOptions {
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: any;
  temperature?: number;
}

export class LLMProvider {
  private client: GoogleGenAI | null = null;
  private isFallbackMode = false;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (key) {
      try {
        this.client = new GoogleGenAI({ 
          apiKey: key,
          httpOptions: {
            headers: {
              'User-Agent': 'sentinel-core-genkit-middleware',
            }
          }
        });
      } catch (err) {
        console.warn("SentinelCore Provider init failed, falling back to simulator:", err);
        this.isFallbackMode = true;
      }
    } else {
      this.isFallbackMode = true;
    }
  }

  /**
   * Determine whether client operates in simulation baseline
   */
  public isSimulated(): boolean {
    return this.isFallbackMode || !this.client;
  }

  /**
   * Abstracted call to generate structured or text contents
   */
  async generate(prompt: string, options: LLMRequestOptions = {}): Promise<string> {
    if (this.isFallbackMode || !this.client) {
      // Simulate slow responses matching network latency target
      await new Promise(resolve => setTimeout(resolve, 300));
      return this.localModelScrutinizer(prompt);
    }

    try {
      const response = await this.client.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          systemInstruction: options.systemInstruction,
          responseMimeType: options.responseMimeType,
          responseSchema: options.responseSchema,
          temperature: options.temperature ?? 0.1,
        }
      });

      return response.text ? response.text.trim() : "";
    } catch (err: any) {
      console.error("Provider query execution failed:", err);
      throw new Error(`ModelProviderError: ${err.message || "Unknown upstream timeout."}`);
    }
  }

  /**
   * In-memory local matcher for offline testing environments
   */
  private localModelScrutinizer(prompt: string): string {
    const norm = prompt.toLowerCase();
    
    // Check if this was a threat scan request or standard dialogue helper
    if (norm.includes("prosecutor") || norm.includes("debate") || norm.includes("categories")) {
      // Return a simulated JSON payload matching requested Schema formats to maintain runtime compatibility
      const hasSevereJailbreak = norm.includes("ignore") || norm.includes("override") || norm.includes("jailbreak");
      const hasScrape = norm.includes("scrape") || norm.includes("extraction") || norm.includes("patient");
      const hasSql = norm.includes("drop table") || norm.includes("delete from") || norm.includes("query");

      let verdict = "ALLOW";
      let score = 1;
      let risk = "NONE";
      const categories: string[] = [];

      if (hasSevereJailbreak) {
        verdict = "BLOCK";
        score = 8;
        risk = "HIGH";
        categories.push("Jailbreak Attempt");
      } else if (hasSql) {
        verdict = "BLOCK";
        score = 9;
        risk = "CRITICAL";
        categories.push("SQL Injection");
      } else if (hasScrape) {
        verdict = "FLAG";
        score = 5;
        risk = "MEDIUM";
        categories.push("Data Scraping");
      }

      return JSON.stringify({
        finalVerdict: verdict,
        finalScore: score,
        riskLevel: risk,
        tiersExecuted: score >= 7 ? [1, 2, 3] : [1, 2],
        categories,
        intentSummary: "Simulated offline verification parsing.",
        reasoning: "Executing local engine analyzer. Upstream API offline or unauthorized.",
        deceptiveFraming: hasSevereJailbreak || hasScrape,
        debateProsecutor: score >= 7 ? "Evaluating high hazard parameters. Compromise vector detected." : "",
        debateDefense: score >= 7 ? "Educational sandbox testing scenario validated." : "",
        debateJudge: score >= 7 ? `Affirming safeguard block state to preserve runtime assets.` : "",
        complianceReports: [
          {
            framework: "HIPAA",
            status: hasScrape ? "WARNING" : "COMPLIANT",
            analysis: "Audit logs checked.",
            remediationBrief: "Ensure SSN keys are masked prior to dispatch."
          }
        ]
      });
    }

    return "Processing completed. The prompt query seems structurally neutral.";
  }
}
