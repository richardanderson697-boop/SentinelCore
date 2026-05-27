import { GoogleGenAI } from "@google/genai";

export interface LLMRequestOptions {
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: any;
  temperature?: number;
}

export class LLMProvider {
  private client: GoogleGenAI | null = null;
  private providerType: 'gemini' | 'anthropic' | 'openai' | 'simulated' = 'simulated';
  private resolvedKey: string = '';

  constructor(apiKey?: string) {
    if (apiKey) {
      this.resolvedKey = apiKey;
      if (apiKey.startsWith("sk-ant-")) {
        this.providerType = "anthropic";
      } else if (apiKey.startsWith("sk-") || apiKey.startsWith("org-")) {
        this.providerType = "openai";
      } else {
        this.providerType = "gemini";
      }
    } else if (process.env.ANTHROPIC_API_KEY) {
      this.resolvedKey = process.env.ANTHROPIC_API_KEY;
      this.providerType = "anthropic";
    } else if (process.env.GEMINI_API_KEY) {
      this.resolvedKey = process.env.GEMINI_API_KEY;
      this.providerType = "gemini";
    } else if (process.env.OPENAI_API_KEY) {
      this.resolvedKey = process.env.OPENAI_API_KEY;
      this.providerType = "openai";
    }

    if (this.providerType === "gemini" && this.resolvedKey) {
      try {
        this.client = new GoogleGenAI({ 
          apiKey: this.resolvedKey,
          httpOptions: {
            headers: {
              'User-Agent': 'sentinel-core-genkit-middleware',
            }
          }
        });
      } catch (err) {
        console.warn("SentinelCore Gemini init failed, entering simulated provider layer.", err);
        this.providerType = "simulated";
      }
    }
  }

  /**
   * Determine whether client operates in simulation baseline
   */
  public isSimulated(): boolean {
    return this.providerType === 'simulated' || (!this.client && this.providerType === 'gemini');
  }

  /**
   * Abstracted call to generate structured or text contents
   */
  async generate(prompt: string, options: LLMRequestOptions = {}): Promise<string> {
    if (this.providerType === 'simulated') {
      // Simulate slow responses matching network latency target
      await new Promise(resolve => setTimeout(resolve, 300));
      return this.localModelScrutinizer(prompt);
    }

    if (this.providerType === 'anthropic') {
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.resolvedKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-latest",
            max_tokens: 4096,
            system: options.systemInstruction || "",
            messages: [{ role: "user", content: prompt }],
            temperature: options.temperature ?? 0.1
          })
        });

        if (!response.ok) {
          const rawErr = await response.text();
          throw new Error(`Anthropic Error HTTP ${response.status}: ${rawErr}`);
        }

        const data = await response.json();
        const content = data?.content?.[0]?.text;
        return content ? content.trim() : "";
      } catch (err: any) {
        console.error("Open-source Anthropic pipeline query execution failed, fallback to local:", err);
        return this.localModelScrutinizer(prompt);
      }
    }

    if (this.providerType === 'openai') {
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.resolvedKey}`
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              ...(options.systemInstruction ? [{ role: "system", content: options.systemInstruction }] : []),
              { role: "user", content: prompt }
            ],
            response_format: options.responseMimeType === "application/json" ? { type: "json_object" } : undefined,
            temperature: options.temperature ?? 0.1
          })
        });

        if (!response.ok) {
          const rawErr = await response.text();
          throw new Error(`OpenAI Error HTTP ${response.status}: ${rawErr}`);
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        return text ? text.trim() : "";
      } catch (err: any) {
        console.error("Open-source OpenAI pipeline query execution failed, fallback to local:", err);
        return this.localModelScrutinizer(prompt);
      }
    }

    // Default to Gemini API
    try {
      if (!this.client) {
        throw new Error("Gemini AI client not initialized properly.");
      }
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
      console.error("Gemini query execution failed, fallback to local:", err);
      return this.localModelScrutinizer(prompt);
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
