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

Your job is to apply judgment where keyword matching falls short:

1. COMPANY FIT: Is this a viable Throxy customer?
   - Must be a B2B company (not government, non-profit, or B2C)
   - Ideally sells into complex verticals (manufacturing, education, healthcare)
   - Consider qualification signals you know about: funding, hiring SDRs, PLG model, layoffs, etc.

2. TITLE ACCURACY: Validate the pre-classified seniority/department for ambiguous titles

3. SCORE ADJUSTMENT: Adjust the base score (1–10) based on company fit and signals

4. RELEVANCE: Set relevant=false if the company is not a Throxy fit OR the person is in the wrong function/seniority

Keep reasoning to 1–2 concise sentences. Be conservative — when uncertain about relevance, lean toward false.

<persona_spec>
${PERSONA_SPEC}
</persona_spec>`;

// ── Batch formatting ───────────────────────────────────────────────────

function formatBatch(batch: LeadClassification[]): string {
  return batch
    .map((c) => {
      const l = c.lead;
      let line = `[${l.id}] ${l.first_name} ${l.last_name} — "${l.job_title}"`;
      line += `\n  Company: ${l.company} (${l.domain}) | ${TIER_LABELS[c.tier]} | ${l.industry || "no industry listed"}`;
      line += `\n  Pre-classified: seniority=${c.seniority}, department=${c.department}, base_score=${c.baseScore}`;
      if (c.softExcluded) line += `\n  NOTE: Soft exclusion — ${c.exclusionReason}`;
      return line;
    })
    .join("\n\n");
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
      if (ai) return ai;
      return {
        lead_id: c.lead.id,
        relevant: c.baseScore >= 5,
        score: c.baseScore,
        reasoning: "Scored by title and company profile",
      };
    });
  } catch (err) {
    console.error("AI batch failed, falling back to deterministic:", err);
    return batch.map((c) => ({
      lead_id: c.lead.id,
      relevant: c.baseScore >= 5,
      score: c.baseScore,
      reasoning: "Scored by title and company profile (AI unavailable)",
    }));
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
    const candidates = classified.filter((c) => !c.hardExcluded);

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
