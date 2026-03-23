import { NextResponse } from "next/server";
import { generateObject } from "ai";
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
import type { RankResponse, ApiError, RankingResult } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ── AI model selection ─────────────────────────────────────────────────

function getModel() {
  if (process.env.OPENAI_API_KEY) {
    return openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini");
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

// ── System prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are evaluating sales leads for Throxy, an AI-powered outbound sales company.

Each lead has been pre-classified deterministically:
- Company tier (startup/smb/mid_market/enterprise) from employee count
- Seniority and department from job title keyword matching
- Base score from persona spec scoring matrices

The tier classification is deterministic from employee count — do not change it.
You MAY override the department/seniority if the title is ambiguous and your interpretation differs.

Important guardrails:
- Do NOT invent facts or pretend you researched the company. You are not browsing the web.
- Use only the provided title, company name, domain, industry, and deterministic notes.
- If a qualification signal (funding, layoffs, SDR hiring, PLG motion, etc.) is not obvious from the provided text, treat it as unknown.
- Do NOT assume a company is a fit just because its own industry is manufacturing, education, or healthcare. The persona cares about companies that SELL INTO complex verticals.

Your job is to apply judgment where keyword matching falls short:

1. COMPANY FIT: Is this a viable Throxy customer?
   - Must be a B2B company (not government, non-profit, or B2C)
   - Prefer companies likely to benefit from complex outbound motions
   - Consider qualification signals only when they are directly supported by the provided text

2. TITLE ACCURACY: Validate the pre-classified seniority/department for ambiguous titles

3. SCORE ADJUSTMENT: Adjust the base score (1–10) based on company fit and signals

4. RELEVANCE: Set relevant=false if the company is not a Throxy fit OR the person is in the wrong function/seniority

5. WITHIN-COMPANY RANKING: When multiple contacts from the same company appear, prefer the people closest to owning outbound. Champions can be relevant, but should score below the primary buyer.

Keep reasoning to 1–2 concise sentences. Be conservative — when uncertain about relevance, lean toward false.

<persona_spec>
${PERSONA_SPEC}
</persona_spec>`;

// ── Batch formatting ───────────────────────────────────────────────────

function companyKey(c: LeadClassification): string {
  return `${c.lead.company}::${c.lead.domain}`.toLowerCase();
}

function formatBatch(batch: LeadClassification[]): string {
  const grouped = new Map<string, LeadClassification[]>();

  for (const lead of batch) {
    const key = companyKey(lead);
    grouped.set(key, [...(grouped.get(key) ?? []), lead]);
  }

  return [...grouped.values()]
    .map((group) => {
      const first = group[0];
      const companyHeader = `Company: ${first.lead.company} (${first.lead.domain}) | ${TIER_LABELS[first.tier]} | ${first.lead.industry || "no industry listed"}`;
      const lines = group.map((c) => {
        const l = c.lead;
        let line = `- [${l.id}] ${l.first_name} ${l.last_name} — "${l.job_title}"`;
        line += ` | seniority=${c.seniority}, department=${c.department}, base_score=${c.baseScore}`;
        if (c.softExcluded) line += ` | soft_exclusion=${c.exclusionReason}`;
        return line;
      });

      return `${companyHeader}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

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

// ── AI evaluation per batch ────────────────────────────────────────────

async function evaluateBatch(
  batch: LeadClassification[],
  model: ReturnType<typeof getModel>,
): Promise<RankingResult[]> {
  try {
    const { object } = await generateObject({
      model,
      schema: EvaluationSchema,
      system: SYSTEM_PROMPT,
      prompt: `Evaluate these ${batch.length} leads:\n\n${formatBatch(batch)}`,
      temperature: 0,
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

export async function POST(): Promise<NextResponse<RankResponse | ApiError>> {
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

    // 2. Hard-excluded leads get instant results (no AI cost)
    const excludedResults: RankingResult[] = hardExcluded.map((c) => ({
      lead_id: c.lead.id,
      relevant: false,
      score: 1,
      reasoning: c.exclusionReason ?? "Does not match target persona",
    }));

    // 3. Batch remaining candidates and evaluate with AI
    const BATCH_SIZE = 20;
    const CONCURRENCY = 5;
    const batches = chunk(candidates, BATCH_SIZE);
    const aiResults: RankingResult[] = [];

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((batch) => evaluateBatch(batch, model)),
      );
      aiResults.push(...results.flat());
    }

    console.log(
      `AI evaluated ${aiResults.length} leads across ${batches.length} batch(es)`,
    );

    // 4. Combine and return
    return NextResponse.json({
      results: [...excludedResults, ...aiResults],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ranking failed";
    console.error("Ranking error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
