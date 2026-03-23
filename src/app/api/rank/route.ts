import { generateObject, generateText } from "ai";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { LEADS } from "@/data/leads";
import { PERSONA_SPEC } from "@/data/persona";
import {
  classifyLead,
  TIER_LABELS,
  type LeadClassification,
} from "@/lib/classify";
import type { RankingResult } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ── AI model selection ─────────────────────────────────────────────────

function getModel() {
  if (process.env.OPENAI_API_KEY) {
    return openai(process.env.OPENAI_MODEL ?? "gpt-5.4");
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514");
  }
  throw new Error("Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env.local");
}

// ── Structured output schema ───────────────────────────────────────────

const EvaluationSchema = z.object({
  evaluations: z.array(
    z.object({
      lead_id: z.string().describe("The lead ID from the input"),
      relevant: z.boolean().describe("Should this lead be contacted?"),
      score: z.number().min(1).max(10).describe("Fit score 1–10"),
      reasoning: z.string().describe("1–2 sentence explanation"),
    }),
  ),
});

// ── Step 1: Company research via web search ────────────────────────────

const RESEARCH_PROMPT = `You are a sales research analyst. For the company below, search the web and provide a brief intelligence report.

Focus on these qualification signals (from Throxy's persona spec):

POSITIVE signals (boost the company):
- Recently raised funding (amount, round, date)
- Actively hiring SDRs/BDRs (check job boards)
- Sells into enterprise or mid-market buyers with complex sales cycles
- Long sales cycles (3+ months)
- Company posting about "pipeline problems" or "scaling sales"
- Small or no existing SDR team
- Previous use of outsourced outbound

NEGATIVE signals (deprioritize the company):
- Sells to SMB or consumers (B2C)
- Product-led growth (PLG) company where outbound is not primary
- Large, established SDR team (20+)
- Company in layoffs or cost-cutting mode
- No online presence or outdated website

Also determine:
- What does this company SELL and WHO do they sell to? (critical: "sells INTO manufacturing/education/healthcare" is very different from "is a manufacturer")
- Is this a B2B company?

Be factual. If you cannot find information on a signal, say "unknown" — do not guess.
Keep the report concise: 3–6 bullet points max.`;

async function researchCompany(
  name: string,
  domain: string,
  industry: string,
  tier: string,
  model: ReturnType<typeof getModel>,
): Promise<string> {
  try {
    const { text } = await generateText({
      model,
      system: RESEARCH_PROMPT,
      prompt: `Company: ${name}\nDomain: ${domain}\nIndustry: ${industry || "not listed"}\nSize: ${tier}`,
    });
    return text;
  } catch (err) {
    console.error(`Research failed for ${name}:`, err);
    return "Research unavailable — evaluate using provided data only.";
  }
}

// ── Step 2: Lead evaluation with research context ──────────────────────

const SYSTEM_PROMPT = `You are evaluating sales leads for Throxy, an AI-powered outbound sales company.

Each lead has been pre-classified deterministically:
- Company tier (startup/smb/mid_market/enterprise) from employee count
- Seniority and department from job title keyword matching
- Base score from persona spec scoring matrices

Each company also has a RESEARCH REPORT with qualification signals gathered via web search.
Use this research to inform your scoring — it contains real data about funding, hiring, business model, etc.

The tier classification is deterministic from employee count — do not change it.
You MAY override the department/seniority if the title is ambiguous and your interpretation differs.

Important guardrails:
- Do NOT assume a company is a fit just because its own industry is manufacturing, education, or healthcare. The persona cares about companies that SELL INTO those complex verticals — not companies operating in them.
- Use the research report as your primary source of company intelligence. If the research says "unknown" for a signal, treat it as unknown.

Your job is to apply judgment where keyword matching falls short:

1. COMPANY FIT: Is this a viable Throxy customer based on the research?
   - Must be a B2B company (not government, non-profit, or B2C)
   - Prefer companies likely to benefit from complex outbound motions
   - Apply qualification signals from the research report

2. TITLE ACCURACY: Validate the pre-classified seniority/department for ambiguous titles

3. SCORE ADJUSTMENT: Adjust the base score (1–10) based on company fit and research signals

4. INDIVIDUAL LEAD SIGNALS: If you recognize a lead's name from your knowledge, consider:
   - Recently promoted? (positive — eager to make an impact, open to new tools)
   - Previously worked at a company that used outsourced outbound? (positive — familiar with the model)
   - Has "Advisor" or "Consultant" in title? (negative — not employed, no buying power)

5. RELEVANCE: Set relevant=false if the company is not a Throxy fit OR the person is in the wrong function/seniority

6. WITHIN-COMPANY RANKING: When multiple contacts from the same company appear, prefer the people closest to owning outbound. Champions can be relevant, but should score below the primary buyer.

Keep reasoning to 1–2 concise sentences. Reference specific research findings when relevant.
Be conservative — when uncertain about relevance, lean toward false.

<persona_spec>
${PERSONA_SPEC}
</persona_spec>`;

// ── Batch formatting (now with research context) ───────────────────────

function companyKey(c: LeadClassification): string {
  return `${c.lead.company}::${c.lead.domain}`.toLowerCase();
}

function formatBatchWithResearch(
  batch: LeadClassification[],
  researchMap: Map<string, string>,
): string {
  const grouped = new Map<string, LeadClassification[]>();

  for (const lead of batch) {
    const key = companyKey(lead);
    grouped.set(key, [...(grouped.get(key) ?? []), lead]);
  }

  return [...grouped.entries()]
    .map(([key, group]) => {
      const first = group[0];
      const companyHeader = `Company: ${first.lead.company} (${first.lead.domain}) | ${TIER_LABELS[first.tier]} | ${first.lead.industry || "no industry listed"}`;

      const research = researchMap.get(key) ?? "No research available.";
      const researchBlock = `Research:\n${research}`;

      const lines = group.map((c) => {
        const l = c.lead;
        let line = `- [${l.id}] ${l.first_name} ${l.last_name} — "${l.job_title}"`;
        line += ` | seniority=${c.seniority}, department=${c.department}, base_score=${c.baseScore}`;
        if (c.softExcluded) line += ` | soft_exclusion=${c.exclusionReason}`;
        return line;
      });

      return `${companyHeader}\n${researchBlock}\n\nLeads:\n${lines.join("\n")}`;
    })
    .join("\n\n---\n\n");
}

// ── Post-filter and helpers ────────────────────────────────────────────

function appendReasoning(reasoning: string, suffix: string): string {
  return reasoning.includes(suffix) ? reasoning : `${reasoning} ${suffix}`.trim();
}

function applyPostFilter(
  result: RankingResult,
  classification: LeadClassification,
): RankingResult {
  const normalized = {
    ...result,
    score: Math.max(1, Math.min(10, Math.round(result.score))),
  };

  if (!classification.softExcluded || !classification.softExclusionKind) {
    return normalized;
  }

  switch (classification.softExclusionKind) {
    case "advisor_consultant_board":
      return {
        ...normalized,
        relevant: false,
        score: Math.min(normalized.score, 2),
        reasoning: appendReasoning(
          normalized.reasoning,
          "Post-filter: advisory and consultant roles are too removed from day-to-day ownership.",
        ),
      };
    case "account_executive":
      return {
        ...normalized,
        relevant: false,
        score: Math.min(normalized.score, 3),
        reasoning: appendReasoning(
          normalized.reasoning,
          "Post-filter: account executives are closers, not outbound owners.",
        ),
      };
    case "marketing_leader":
      // At startups, CMO/VP Marketing often owns outbound — let AI decide
      if (classification.tier === "startup") {
        return {
          ...normalized,
          score: Math.min(normalized.score, 6),
          reasoning: normalized.relevant
            ? appendReasoning(
                normalized.reasoning,
                "Post-filter: marketing leader at a startup may own outbound, scored as secondary target.",
              )
            : normalized.reasoning,
        };
      }
      return {
        ...normalized,
        relevant: false,
        score: Math.min(normalized.score, 3),
        reasoning: appendReasoning(
          normalized.reasoning,
          "Post-filter: marketing leadership rarely owns outbound directly.",
        ),
      };
    case "sdr_bdr":
      if (
        classification.tier === "mid_market" ||
        classification.tier === "enterprise"
      ) {
        return {
          ...normalized,
          score: Math.min(normalized.score, 5),
          reasoning: normalized.relevant
            ? appendReasoning(
                normalized.reasoning,
                "Post-filter: treat SDR/BDR roles as possible champions, not primary buyers.",
              )
            : normalized.reasoning,
        };
      }

      return {
        ...normalized,
        relevant: false,
        score: Math.min(normalized.score, 3),
        reasoning: appendReasoning(
          normalized.reasoning,
          "Post-filter: SDR/BDR roles are not decision-makers at this company size.",
        ),
      };
  }
}

function buildDeterministicResult(
  classification: LeadClassification,
  reasoning: string,
): RankingResult {
  return applyPostFilter(
    {
      lead_id: classification.lead.id,
      relevant: classification.baseScore >= 5,
      score: classification.baseScore,
      reasoning,
    },
    classification,
  );
}

// ── AI evaluation per batch (now with research) ────────────────────────

async function evaluateBatch(
  batch: LeadClassification[],
  model: ReturnType<typeof getModel>,
  researchMap: Map<string, string>,
): Promise<RankingResult[]> {
  try {
    const { object } = await generateObject({
      model,
      schema: EvaluationSchema,
      system: SYSTEM_PROMPT,
      prompt: `Evaluate these ${batch.length} leads:\n\n${formatBatchWithResearch(batch, researchMap)}`,
    });

    const aiMap = new Map(object.evaluations.map((e) => [e.lead_id, e]));

    // Ensure every lead has a result — fall back to deterministic if AI missed one
    return batch.map((c) => {
      const ai = aiMap.get(c.lead.id);
      if (ai) return applyPostFilter(ai, c);
      return buildDeterministicResult(c, "Scored by title and company profile");
    });
  } catch (err) {
    console.error("AI batch failed, falling back to deterministic:", err);
    return batch.map((c) =>
      buildDeterministicResult(
        c,
        "Scored by title and company profile (AI unavailable)",
      ),
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ── POST /api/rank ─────────────────────────────────────────────────────

export async function POST(): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(results: RankingResult[]) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ results }) + "\n"),
        );
      }

      try {
        const model = getModel();

        // 1. Classify every lead deterministically
        const classified = LEADS.map(classifyLead);
        const hardExcluded = classified.filter((c) => c.hardExcluded);
        const candidates = classified
          .filter((c) => !c.hardExcluded)
          .sort(
            (a, b) =>
              companyKey(a).localeCompare(companyKey(b)) ||
              b.baseScore - a.baseScore ||
              a.lead.job_title.localeCompare(b.lead.job_title),
          );

        console.log(
          `Classified ${LEADS.length} leads: ${hardExcluded.length} hard-excluded, ${candidates.length} candidates`,
        );

        // 2. Hard-excluded leads get instant results (no AI cost) — stream immediately
        const excludedResults: RankingResult[] = hardExcluded.map((c) => ({
          lead_id: c.lead.id,
          relevant: false,
          score: 1,
          reasoning: c.exclusionReason ?? "Does not match target persona",
        }));

        if (excludedResults.length > 0) {
          send(excludedResults);
        }

        // 3. Research unique companies (web search)
        const uniqueCompanies = new Map<
          string,
          { name: string; domain: string; industry: string; tier: string }
        >();
        for (const c of candidates) {
          const key = companyKey(c);
          if (!uniqueCompanies.has(key)) {
            uniqueCompanies.set(key, {
              name: c.lead.company,
              domain: c.lead.domain,
              industry: c.lead.industry,
              tier: TIER_LABELS[c.tier],
            });
          }
        }

        const RESEARCH_CONCURRENCY = 5;
        const researchMap = new Map<string, string>();
        const companyEntries = [...uniqueCompanies.entries()];

        console.log(`Researching ${companyEntries.length} unique companies...`);

        for (let i = 0; i < companyEntries.length; i += RESEARCH_CONCURRENCY) {
          const slice = companyEntries.slice(i, i + RESEARCH_CONCURRENCY);
          const results = await Promise.all(
            slice.map(async ([key, co]) => {
              const research = await researchCompany(
                co.name,
                co.domain,
                co.industry,
                co.tier,
                model,
              );
              return [key, research] as const;
            }),
          );
          for (const [key, research] of results) {
            researchMap.set(key, research);
          }
        }

        console.log(`Research complete for ${researchMap.size} companies`);

        // 4. Batch candidates and evaluate with AI — stream each batch as it completes
        const BATCH_SIZE = 20;
        const EVAL_CONCURRENCY = 5;
        const batches = chunk(candidates, BATCH_SIZE);
        let totalEvaluated = 0;

        for (let i = 0; i < batches.length; i += EVAL_CONCURRENCY) {
          const slice = batches.slice(i, i + EVAL_CONCURRENCY);
          const batchResults = await Promise.all(
            slice.map((batch) => evaluateBatch(batch, model, researchMap)),
          );
          for (const batch of batchResults) {
            send(batch);
            totalEvaluated += batch.length;
          }
        }

        console.log(
          `AI evaluated ${totalEvaluated} leads across ${batches.length} batch(es)`,
        );

        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Ranking failed";
        console.error("Ranking error:", message);
        controller.enqueue(
          encoder.encode(JSON.stringify({ error: message }) + "\n"),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
}
