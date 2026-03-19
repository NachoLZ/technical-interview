import { NextResponse } from "next/server";
import { LEADS } from "@/data/leads";
import { PERSONA_SPEC } from "@/data/persona";
import type { RankResponse, ApiError, RankingResult } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/rank
 *
 * Rank all leads against the persona spec using AI.
 *
 * This is the main endpoint you need to implement. Your job:
 *
 * 1. Design a prompt strategy that evaluates leads against the persona spec.
 *    Consider: what does the AI need to know to judge relevance and fit?
 *
 * 2. Call an AI provider to rank the leads.
 *
 * 3. Return results matching the RankingResult type: for each lead, whether
 *    they're relevant, a score (1-10), and a short reasoning.
 *
 * Available data:
 *   LEADS        — all leads loaded from the CSV (see src/types for the shape)
 *   PERSONA_SPEC — the full persona spec as a markdown string
 *
 * The frontend is already wired to call this route and display results.
 */
export async function POST(): Promise<NextResponse<RankResponse | ApiError>> {
  // TODO: implement your ranking logic here

  return NextResponse.json({ error: "Not implemented" }, { status: 501 });
}
