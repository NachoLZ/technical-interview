# Persona Ranker — Architecture & Code Walkthrough

## Design Philosophy

**Deterministic where possible, AI only where judgment is needed.**

The ranking system is split into two layers:

1. **Deterministic layer** (`src/lib/classify.ts`) — Rules directly derived from the persona spec. No API calls, no cost, reproducible results. Handles ~60–70% of leads instantly via hard exclusions.
2. **AI layer** (`src/app/api/rank/route.ts`) — Uses an LLM only for things that require real-world knowledge or interpretation: company fit, ambiguous titles, qualification signals.

This means:
- Most leads never touch the LLM (cheaper, faster)
- The LLM focuses on what it's actually good at (judgment, not table lookups)
- Results are partially reproducible — the deterministic portion never changes

---

## classify.ts — Deterministic Classification

### Overview

Every lead goes through `classifyLead()`, which produces a `LeadClassification` object containing: tier, seniority, department, base score, and exclusion status. This is pure computation — no async, no API calls.

### Step 1: Tier Mapping (lines 33–55)

```
employee_range → CompanyTier
```

| CSV value | Tier | Persona spec section |
|-----------|------|---------------------|
| 2-10, 11-50 | startup | "Startups (1-50 employees)" |
| 51-200 | smb | "SMB (51-200 employees)" |
| 201-500, 501-1000 | mid_market | "Mid-Market (201-1,000 employees)" |
| 1001-5000, 10001+ | enterprise | "Enterprise (1,000+ employees)" |
| empty / unrecognized | unknown | Defaults to moderate scores |

This is a simple lookup table — `TIER_MAP[range]`. No ambiguity, no AI needed.

**Why this matters:** The persona spec's entire targeting strategy changes by tier. A CEO is a 5/5 target at startups but a hard exclusion at enterprise. Getting the tier wrong would cascade into every downstream decision.

`TIER_LABELS` is a human-readable mapping used in the AI prompt so the LLM knows what "startup" means in context.

---

### Step 2: Seniority Detection (lines 60–76)

```
job_title → Seniority (founder | c_level | vp | director | manager | ic)
```

Uses an ordered array of `[Seniority, RegExp]` pairs. **Order is critical** — the first match wins:

1. **founder** — `/co-?founder|co-?owner/i`
   Matches: "Founder & CEO", "Co-Founder", "Company Owner"

2. **c_level** — `/ceo|cro|cfo|cto|coo|cmo|chief|president|partner/i`
   Matches: "CEO", "Chief Revenue Officer", "President", "Managing Partner"

3. **vp** — `/vp|vice president|head of/i`
   Matches: "VP of Sales", "Vice President", "Head of Business Development"
   **Note:** "Head of" is mapped to VP because the persona spec lists "Head of Sales" at the same priority as "VP of Sales" in the SMB and Mid-Market tiers.

4. **director** — `/director|directeur/i`
   Matches: "Sales Director", "Director of Sales Development"
   Includes French "directeur" for multilingual data.

5. **manager** — `/manager|supervisor|jefe/i`
   Matches: "Regional Sales Manager", "Sales Supervisor"
   Includes Spanish "jefe/jefa" for multilingual data.

6. **ic** (default) — Everything else.
   Matches: "Business Analyst", "BDR", "Sales Associate"

**Why founder beats c_level:** "Founder & CEO" should be classified as founder (highest priority at startups), not c_level. If c_level matched first, the title would get c_level behavior, which is similar but semantically wrong — the persona spec distinguishes them in the seniority matrix.

**Why "Head of" is VP, not manager:** The persona spec lists "Head of Sales" alongside VPs as primary targets with the same priority scores (5/5 at SMB). Treating "Head of" as manager would under-score these leads.

---

### Step 3: Department Detection (lines 80–124)

```
job_title → department string
```

Also an ordered array — **specific departments before broad ones** to avoid false matches:

| Order | Department | Example patterns | Why this position |
|-------|-----------|-----------------|-------------------|
| 1 | sales_development | "sales development", "SDR", "BDR" | Most specific sales sub-type |
| 2 | revenue_operations | "revenue operations", "RevOps", "sales operations" | Specific ops sub-type |
| 3 | business_development | "business development" | Before generic "sales" |
| 4 | gtm_growth | "GTM", "growth" | Before generic "sales" |
| 5 | customer_success | "customer success/service" | Before generic "sales" |
| 6 | hr | "human resources", "ressources humaines", "talent", "recruit" | Multilingual |
| 7 | legal | "legal", "compliance", "counsel", "abogado" | Multilingual |
| 8 | finance | "finance", "financial", "CFO", "accounting", "billing" | |
| 9 | product | "product manag..." | Only matches "product manager/management", NOT "product engineer" |
| 10 | marketing | "marketing", "CMO", "content creator", "graphic design" | |
| 11 | **executive** | "CEO", "founder", "owner", "president", "managing director" | **Before sales/engineering** — see below |
| 12 | sales | "sales", "account manager/executive", "commercial", "ventes" | Broad catch-all for sales roles |
| 13 | engineering | "engineer", "developer", "welder", "operator", "technician", "quality", "production" | Broad catch-all for tech/manufacturing |
| 14 | operations | "operations", "supply chain", "material planner/handler", "fulfillment" | Broadest |

**Critical ordering decision: executive before sales/engineering.**

The title "Co-Founder & CTO" contains both "founder" (executive) and implicitly "CTO" which would match engineering. By placing executive first, "founder" matches → department = executive. This is correct because:
- At a startup, a co-founder/CTO is a decision-maker (executive function), not an engineer to exclude
- The persona spec says founders at startups are 5/5 priority targets regardless of their other titles

If engineering came first, "CTO" would match → department = engineering → hard excluded. That would wrongly filter out a primary target.

**Why "product manag..." and not "product":** The pattern `/product manag/` matches "Product Manager" and "Product Management" but NOT "Product Engineer" (which should be engineering) or "Product Marketing" (which should fall through to marketing).

---

### Step 4: Scoring (lines 128–161)

```
base_score = clamp(seniority_score + department_score, 1, 10)
```

**Seniority × Tier matrix** (lines 128–135) — Directly from persona spec § Seniority Relevance Matrix:

```
                Startup  SMB  Mid-Market  Enterprise  Unknown
Founder/Owner      5      3       1           0          3
C-Level            5      3       2           1          3
VP                 3      5       5           5          4
Director           2      4       5           4          3
Manager            1      2       3           3          2
IC                 0      0       1           1          0
```

**Department scores** (lines 137–151) — From persona spec § Department Priority:

| Department | Score | Notes |
|-----------|-------|-------|
| sales_development | 5 | Core function Throxy supports |
| sales | 5 | Owns quota, cares about pipeline |
| revenue_operations | 4 | Controls process and tooling |
| business_development | 4 | Often overlaps with sales dev |
| gtm_growth | 4 | Strategic view of sales motion |
| executive | **5 at startup, 2 at SMB, 1 elsewhere** | Persona spec: "5/5 → 1/5, only relevant at startups" |
| everything else | 0 | Not relevant departments |

**Examples:**

| Lead | Seniority × Tier | Department | Base Score |
|------|-----------------|------------|------------|
| VP of Sales @ SMB | 5 | 5 | **10** (perfect) |
| Founder & CEO @ Startup | 5 | 5 | **10** (perfect) |
| CEO @ Enterprise | 1 | 1 | **2** (terrible — also hard-excluded) |
| Sales Manager @ Enterprise | 3 | 5 | **8** (good) |
| IC Engineer @ Enterprise | 1 | 0 | **1** (irrelevant — also hard-excluded) |

The `unknown` tier column uses moderate values (3, 4, 3...) so leads from companies with missing employee data get middle-of-the-road scores, letting the AI decide.

---

### Step 5: Hard Exclusions (lines 165–204)

These leads are **immediately marked as irrelevant** with no AI evaluation. The function returns a reason string (excluded) or null (not excluded).

**Check order:**

1. **Unusable title** — Empty, < 3 characters, or looks like a URL (e.g., "allie-ai.com" as a job title — actual data error in the CSV). These can't be evaluated by anyone.

2. **Not in workforce** — "Retired", "Student", "Intern". These are never decision-makers.

3. **Startup founder exception** — If `seniority === "founder" && tier === "startup"`, skip ALL remaining exclusion checks. This is critical: "Co-Founder & CTO" at a 10-person startup should NOT be excluded for having "CTO" in the title. The persona spec lists Founder/Co-Founder as the #1 target for startups (5/5).

4. **CEO/President at mid-market+** — Persona spec § Hard Exclusions: "CEO / President (Mid-Market & Enterprise) — Too far removed from outbound execution." Only tier-dependent hard exclusion.

5. **Department-based exclusions** (any tier):
   - finance → "Wrong department"
   - engineering → "No relevance to sales"
   - hr → "Will slow deals or ignore outreach"
   - legal → "Will slow deals or ignore outreach"
   - customer_success → "Post-sale focus"
   - product → "Different function entirely"

**Why we're conservative:** If a title is ambiguous (e.g., "Head of Business Operations & Finance"), the department detection might pick "gtm_growth" (from "business") before "finance". That's fine — the AI will see the full title and can mark it irrelevant if it disagrees. We only hard-exclude when the keyword match is unambiguous.

---

### Step 6: Soft Exclusions (lines 208–223)

Leads matching soft exclusions are **NOT filtered out**. They're flagged and sent to the AI with a warning note. The AI decides the final verdict.

From persona spec § Soft Exclusions:

| Pattern | Reason |
|---------|--------|
| BDR/SDR | "May feel threatened; not decision-makers" |
| Account Executive | "Closers, not outbound owners" |
| CMO / VP Marketing | "Rarely owns outbound directly" |
| Advisor/Consultant/Board | "Too removed from operations; no buying power" |

Soft exclusions only run if the lead wasn't already hard-excluded (no point double-flagging).

---

### Step 7: classifyLead() (lines 227–248)

Orchestrates all the above in order:

1. Map tier from employee_range
2. Detect seniority from job title
3. Detect department from job title
4. Compute base score from seniority × tier + department
5. Check hard exclusion → if excluded, set reason and skip soft check
6. Check soft exclusion → if flagged, set reason
7. Return the full `LeadClassification` object

---

## route.ts — API Route with AI Evaluation

### Overview

The POST handler orchestrates the full ranking pipeline:
1. Classify all leads deterministically
2. Return instant results for hard-excluded leads
3. Batch remaining candidates and send to AI
4. Combine and return all 200 results

### Model Selection (lines 20–28)

```typescript
function getModel() {
  if (process.env.OPENAI_API_KEY) return openai("gpt-4o-mini");
  if (process.env.ANTHROPIC_API_KEY) return anthropic("claude-sonnet-4-20250514");
  throw new Error("...");
}
```

Checks environment variables in order. Defaults to cheap, fast models suitable for classification tasks:
- **gpt-4o-mini** — Very cheap ($0.15/1M input), good at structured output
- **claude-sonnet-4-20250514** — Good balance of cost, speed, and quality

Model ID is overridable via `OPENAI_MODEL` / `ANTHROPIC_MODEL` env vars without code changes.

**Why gpt-4o-mini over gpt-4o:** The AI layer isn't doing creative generation — it's classification with structured output. gpt-4o-mini handles this well at 1/10th the cost. Total API cost for ~200 leads: < $0.01.

### Structured Output Schema (lines 32–41)

```typescript
const EvaluationSchema = z.object({
  evaluations: z.array(z.object({
    lead_id: z.string(),
    relevant: z.boolean(),
    score: z.number().min(1).max(10),
    reasoning: z.string(),
  })),
});
```

Uses Zod schema with `generateObject()` from the Vercel AI SDK. This gives:
- **Type-safe responses** — no JSON parsing or string extraction
- **Automatic validation** — if the LLM returns malformed data, it throws (caught by our error handler)
- **Provider-agnostic** — works with both OpenAI (function calling) and Anthropic (tool use) under the hood

The `.describe()` calls on each field are hints for the LLM about what to put in each field.

### System Prompt (lines 45–72)

The prompt is designed to **complement the deterministic layer, not duplicate it:**

1. **Tells the AI what's already been done** — tier, seniority, department, base score are pre-computed
2. **Tells the AI what to focus on:**
   - **Company fit** — Is this a B2B company? Government? Non-profit? B2C?
   - **Title accuracy** — Override the keyword-based classification for ambiguous titles
   - **Qualification signals** — Funding, hiring SDRs, PLG model, layoffs (requires real-world knowledge we don't have in the CSV)
   - **Relevance verdict** — Final yes/no with reasoning
3. **Includes the full persona spec** in `<persona_spec>` tags so the AI has all the context
4. **Conservative bias** — "when uncertain about relevance, lean toward false" (better to miss a lead than to contact someone irrelevant)

**Why include the full spec instead of a summary?** The spec is ~5,000 words / ~6,000 tokens. At $0.15/1M tokens (gpt-4o-mini), sending it in every batch costs fractions of a cent. Summarizing risks losing nuance (like the champion concept at mid-market, or the "sells INTO manufacturing" distinction).

### Batch Formatting (lines 76–87)

Each lead is formatted as a structured block for the AI:

```
[lead-3] Alex Sandoval — "Founder & CEO"
  Company: Allie - AI for Manufacturing (allie-ai.com) | Startup (1–50) | Software Development
  Pre-classified: seniority=founder, department=executive, base_score=10
```

If the lead has a soft exclusion flag:
```
  NOTE: Soft exclusion — Advisor/Consultant/Board — too removed or no buying power
```

This gives the AI everything it needs in a scannable format: who the person is, what the deterministic layer thinks, and any flags to consider.

### AI Evaluation (lines 91–126)

`evaluateBatch()` sends one batch of ~20 leads to the AI and returns `RankingResult[]`.

**Happy path:**
1. Call `generateObject()` with the schema, system prompt, and formatted batch
2. Map results by `lead_id` into a lookup
3. For each lead in the batch, return the AI's evaluation if found
4. If the AI missed a lead (shouldn't happen, but defensive), fall back to deterministic: `relevant = baseScore >= 5`

**Error path:**
- If the entire AI call fails (rate limit, timeout, model error), **fall back to deterministic scoring for the whole batch**
- The reasoning says "(AI unavailable)" so the user knows these weren't AI-evaluated
- The system doesn't crash — it degrades gracefully

**`temperature: 0`** — Ensures consistent results across runs. This is a classification task, not creative writing. Same inputs should produce same outputs.

### Concurrency Control (lines 159–171)

```typescript
const BATCH_SIZE = 20;
const CONCURRENCY = 5;
```

Leads are split into batches of 20, then processed 5 batches at a time:

```
200 leads → ~130 hard-excluded (instant) + ~70 candidates
70 candidates → 4 batches of 20 (last batch has 10)
Batch 1-4 processed: round 1 (all 4 in parallel)
Total: 1 round of API calls, ~3-5 seconds
```

**Why batch at 20, not per-company or per-lead?**
- Per-lead (200 API calls) = slow and expensive
- Per-company = uneven batches (Steelcase might have 5 candidates, but a startup has 2). Many tiny calls.
- Fixed batches of 20 = predictable latency, simple code, good token density per call

**Why concurrency 5?** Avoids hitting API rate limits while still being fast. 5 parallel calls × 3-5 seconds = total ~5 seconds for all AI evaluation.

### POST Handler (lines 138–186)

The main flow:

```
LEADS (200)
  ↓ classifyLead() for each
  ├── hardExcluded (~130) → instant RankingResult { relevant: false, score: 1 }
  └── candidates (~70)
        ↓ chunk into batches of 20
        ↓ evaluateBatch() × 4 batches (5 concurrent)
        ↓ AI returns RankingResult[] per batch
  ↓
Combine all results (200 total) → NextResponse.json({ results })
```

Error handling wraps the entire flow. If `getModel()` throws (no API key), it returns a 500 with a helpful message. If anything else fails, same pattern.

Console logs at key milestones help during the review demo:
```
Classified 200 leads: 132 hard-excluded, 68 candidates
AI evaluated 68 leads across 4 batch(es)
```

---

## Data Flow Diagram

```
CSV (200 leads)
  │
  ▼
classifyLead() ──────────────────────────────┐
  │                                          │
  ├─ tier = mapTier(employee_range)          │
  ├─ seniority = detectSeniority(title)      │
  ├─ department = detectDepartment(title)    │
  ├─ baseScore = seniority×tier + dept       │
  ├─ hardExcluded? ──── YES ─→ { relevant: false, score: 1, reason }
  │                                          │
  └─ softExcluded? ──── flag but continue    │
                                             │
                    candidates (~70)          │
                        │                    │
                        ▼                    │
              chunk into batches of 20       │
                        │                    │
                        ▼                    │
              AI evaluateBatch()             │
              ┌─────────────────────┐        │
              │ generateObject()    │        │
              │ - company fit       │        │
              │ - title validation  │        │
              │ - qual signals      │        │
              │ - final score       │        │
              └────────┬────────────┘        │
                       │                     │
                       ▼                     │
              AI RankingResult[]             │
                       │                     │
                       ▼                     │
              Combine all results ◄──────────┘
                       │
                       ▼
              NextResponse.json({ results: RankingResult[200] })
```

---

## Key Trade-offs

| Decision | Alternative | Why we chose this |
|----------|-------------|-------------------|
| Deterministic first, AI second | AI evaluates everything | Cheaper, faster, reproducible. AI focuses on judgment. |
| Hard-exclude aggressively | Send borderline leads to AI | ~130 leads instantly resolved saves tokens and time. Only exclude when highly confident. |
| Conservative soft exclusions | Hard-exclude soft cases too | Better to let AI decide on BDRs/AEs than to miss a potential champion. |
| gpt-4o-mini / claude-sonnet | gpt-4o / claude-opus | Classification task, not creative. Cheaper model is sufficient. |
| temperature: 0 | temperature: 0.3-0.7 | Reproducibility matters for a ranking system. |
| Batch by count (20) | Batch by company | Simpler, predictable. Company context is included per-lead anyway. |
| Full persona spec in prompt | Summarized rules | 6K tokens is cheap. Summary risks losing nuance. |
| Fallback to deterministic on AI error | Fail the whole request | Graceful degradation > total failure. |
| Startup founders bypass exclusions | Apply exclusions uniformly | Spec says founders are #1 target at startups, even if their title says CTO. |
