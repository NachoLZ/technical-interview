# Persona Ranker — Architecture & Code Walkthrough

## Design Philosophy

**Deterministic where possible, AI only where judgment is needed.**

The ranking system is split into three layers:

1. **Deterministic classification** (`src/lib/classify.ts`) — Rules derived directly from the persona spec. No API calls, no cost, reproducible. Handles ~60–70% of leads instantly via hard exclusions.
2. **AI evaluation** (`src/app/api/rank/route.ts`) — Uses an LLM only for things that need real-world knowledge or interpretation: company fit, ambiguous titles, within-company ranking.
3. **Deterministic post-filter** (`applyPostFilter` in route.ts) — Enforces soft exclusion rules *after* the AI returns. The AI can't override these — they're business rules, not suggestions.

This means:
- Most leads never touch the LLM (cheaper, faster)
- The LLM focuses on what it's actually good at (judgment, not table lookups)
- Soft exclusions are enforced deterministically, not left to the AI's discretion
- The system degrades gracefully if the AI is unavailable

---

## classify.ts — Deterministic Classification

### Overview

Every lead goes through `classifyLead()`, which produces a `LeadClassification` object containing: tier, seniority, department, base score, hard/soft exclusion status, and a typed `SoftExclusionKind` for the post-filter. Pure computation — no async, no API calls.

### Types

```typescript
CompanyTier   = "startup" | "smb" | "mid_market" | "enterprise" | "unknown"
Seniority     = "founder" | "c_level" | "vp" | "director" | "manager" | "ic"
Department    = "sales_development" | "sales" | "revenue_operations" | "business_development"
              | "gtm_growth" | "executive" | "finance" | "engineering" | "hr" | "legal"
              | "customer_success" | "product" | "marketing" | "operations" | "other"
SoftExclusionKind = "sdr_bdr" | "account_executive" | "marketing_leader" | "advisor_consultant_board"
```

`Department` is a proper union type (not `string`), which prevents typos in downstream `switch`/`if` checks.

`SoftExclusionKind` is a discriminant used by the post-filter — each kind maps to a specific enforcement rule.

---

### Step 1: Tier Mapping

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

Simple lookup — `TIER_MAP[range]`. No ambiguity, no AI needed.

**Why this matters:** The persona spec's entire targeting strategy changes by tier. A CEO is a 5/5 target at startups but a hard exclusion at enterprise. Getting the tier wrong cascades into every downstream decision.

---

### Step 2: Seniority Detection

```
job_title → Seniority
```

Uses an ordered array of `[Seniority, RegExp]` pairs. **First match wins:**

1. **founder** — `/co-?founder|co-?owner/i`
   Matches: "Founder & CEO", "Co-Founder", "Company Owner"

2. **c_level** — `/ceo|cro|cfo|cto|coo|cmo|chief|president|partner/i`
   Matches: "CEO", "Chief Revenue Officer", "President", "Managing Partner"

3. **vp** — `/vp|vice president|head of/i`
   Matches: "VP of Sales", "Vice President", "Head of Business Development"

4. **director** — `/director|directeur/i`
   Matches: "Sales Director", "Director of Sales Development"

5. **manager** — `/manager|supervisor|jefe/i`
   Matches: "Regional Sales Manager", "Sales Supervisor"

6. **ic** (default) — Everything else.

**Why founder beats c_level:** "Founder & CEO" should be classified as founder (5/5 at startups in the seniority matrix), not c_level. The persona spec distinguishes them.

**Why "Head of" is VP, not manager:** The persona spec lists "Head of Sales" at the same priority as "VP of Sales" (5/5 at SMB). Treating it as manager would under-score.

**Multilingual support:** Includes French (`président`, `directeur`), Spanish (`jefe/jefa`), and Portuguese (`presidente`) patterns since the CSV contains non-English titles.

---

### Step 3: Department Detection

```
job_title → Department
```

Ordered array — **specific departments before broad ones** to prevent false matches:

| Order | Department | Example patterns | Why this position |
|-------|-----------|-----------------|-------------------|
| 1 | sales_development | "sales development", "SDR", "BDR" | Most specific sales sub-type |
| 2 | revenue_operations | "revenue operations", "RevOps", "sales operations", "sales enablement", "revenue enablement" | Specific ops sub-type |
| 3 | business_development | "business development", "partnerships", "alliances" | Before generic "sales" |
| 4 | gtm_growth | "GTM", "growth", "go-to-market" | Before generic "sales" |
| 5 | customer_success | "customer success/service" | |
| 6 | hr | "human resources", "ressources humaines", "talent", "recruit", "employer brand" | Multilingual |
| 7 | legal | "legal", "compliance", "counsel", "abogado" | Multilingual |
| 8 | finance | "finance", "financial", "CFO", "accounting", "billing" | |
| 9 | product | "product manag..." | Only matches "product manager/management", NOT "product engineer" |
| 10 | marketing | "marketing", "CMO", "content creator", "graphic design" | |
| 11 | **executive** | "CEO", "founder", "owner", "president", "managing director", "partner" | **Before sales/engineering** |
| 12 | sales | "chief revenue officer", "CRO", "inside sales", "sales", "account manager/executive", "commercial", "ventes" | Broad catch-all |
| 13 | engineering | "engineer", "developer", "welder", "operator", "technician", "quality", "production" | Broad catch-all for tech/manufacturing |
| 14 | operations | "operations", "supply chain", "material planner/handler", "fulfillment", "logistics" | Broadest |

**Executive before sales/engineering — prevents founder titles from falling into lower-scoring buckets.**

Note: CTO is *not* in the engineering regex (it was removed during edge-case review), so "Co-Founder & CTO" would match executive via `founder` regardless of ordering. The ordering mainly guards against titles that combine a founder/owner keyword with a sales keyword (e.g., a hypothetical "Owner & Sales Lead") — without this ordering, `sales` could match first and the lead would miss the executive department score (5 at startups vs 5 for sales — equal in this case, but conceptually wrong). At larger tiers the ordering barely matters: executives are either hard-excluded (CEO at mid-market+) or get low department scores (1–2) regardless.

**CRO in sales, not executive.** "Chief Revenue Officer" is explicitly matched by the sales pattern (`/chief revenue officer|cro/`) because CRO owns pipeline — that's the sales function, not a generic executive role. This ensures CROs at SMB+ get the correct department score (5) instead of the lower executive score.

**"product manag..." not "product".** Matches "Product Manager" and "Product Management" but NOT "Product Engineer" (→ engineering) or "Product Marketing" (→ marketing).

---

### Step 4: Scoring

```
base_score = clamp(seniority_score + department_score, 1, 10)
```

**Seniority × Tier matrix** — directly from persona spec § Seniority Relevance Matrix:

```
                Startup  SMB  Mid-Market  Enterprise  Unknown
Founder/Owner      5      3       1           0          3
C-Level            5      3       2           1          3
VP                 3      5       5           5          4
Director           2      4       5           4          3
Manager            1      2       3           3          2
IC                 0      0       1           1          0
```

**Department scores** — from persona spec § Department Priority:

| Department | Score | Notes |
|-----------|-------|-------|
| sales_development | 5 | Core function Throxy supports |
| sales | 5 | Owns quota, cares about pipeline |
| revenue_operations | 4 | Controls process and tooling |
| business_development | 4 | Often overlaps with sales dev |
| gtm_growth | 4 | Strategic view of sales motion |
| executive | **5 at startup, 2 at SMB, 1 elsewhere** | Tier-dependent via `getDepartmentScore()` |
| everything else | 0 | Not relevant departments |

The `DEPARTMENT_SCORES` record lists all 15 department values exhaustively (all irrelevant ones set to 0). The `executive` case is handled separately in `getDepartmentScore()` because it's the only tier-dependent department.

**Examples:**

| Lead | Seniority × Tier | Department | Base Score |
|------|-----------------|------------|------------|
| VP of Sales @ SMB | 5 | 5 | **10** |
| Founder & CEO @ Startup | 5 | 5 | **10** |
| CRO @ Startup | 5 (c_level) | 5 (sales) | **10** |
| CEO @ Enterprise | 1 | 1 | **2** (also hard-excluded) |
| Sales Manager @ Enterprise | 3 | 5 | **8** |
| IC Engineer @ Enterprise | 1 | 0 | **1** (also hard-excluded) |

---

### Step 5: Hard Exclusions

These leads are **immediately marked irrelevant** — no AI evaluation. Returns a reason string or null.

**Check order:**

1. **Unusable title** — Empty, < 3 chars, placeholder values (`undefined`, `null`, `n/a`, `none`), or domain-like strings (`allie-ai.com`, `bts-it.com`). The regex `/\b[\w-]+\.(com|ai|io|net|org|es|co|tech|industries)\b/i` catches URLs/domains that ended up in the title field — actual data errors in the CSV.

2. **Government / public-sector accounts** — Checks `company + domain + industry` against patterns like `ayuntamiento`, `ajuntament`, `municipality`, `city of`, `ministry`, `.gov`, `.gob`, `.mil`. These are not B2B targets — filtering them deterministically saves AI tokens and prevents the LLM from wasting time evaluating government employees.

3. **Not in workforce** — "Retired", "Student", "Intern" (but not "Internal").

4. **Assistant roles** — "Executive Assistant", "Administrative Assistant". These were a false positive in the original version: "Senior Executive Assistant: Chief Financial Officer" would match `c_level` seniority because of "Chief", but the person is an assistant, not the CFO.

5. **Startup founder exception** — `seniority === "founder" && tier === "startup"` → skip ALL remaining checks. "Co-Founder & CTO" at a 10-person startup must NOT be excluded for CTO. Persona spec says Founder/Co-Founder = #1 target at startups (5/5).

6. **CEO/President at mid-market+** — Persona spec § Hard Exclusions: "Too far removed from outbound execution."

7. **Department-based exclusions** (any tier): finance, engineering, hr, legal, customer_success, product.

---

### Step 6: Soft Exclusions

Returns `{ kind: SoftExclusionKind; reason: string }` or null. The `kind` field drives the deterministic post-filter in route.ts.

| Pattern | Kind | Reason |
|---------|------|--------|
| BDR/SDR | `sdr_bdr` | Not decision-makers |
| Account Executive | `account_executive` | Closers, not outbound owners |
| CMO / VP Marketing (but NOT if "business development" also in title) | `marketing_leader` | Rarely owns outbound |
| Advisor / Consultant / Board | `advisor_consultant_board` | Too removed or no buying power |

**Guard on marketing_leader:** The check `!/business development/i.test(title)` prevents false positives on titles like "VP of Marketing & Business Development" where the person actually does outbound-adjacent work.

---

## route.ts — API Route

### Overview

The POST handler orchestrates the full pipeline:
1. Classify all leads deterministically
2. Return instant results for hard-excluded leads
3. Sort candidates by company → batch → send to AI
4. Apply deterministic post-filter to AI results
5. Combine and return all 200 results

### Model Selection

```typescript
function getModel() {
  if (process.env.OPENAI_API_KEY) return openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini");
  if (process.env.ANTHROPIC_API_KEY) return anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514");
  throw new Error("...");
}
```

Defaults to cheap, fast models suitable for classification. Model ID overridable via env vars.

**Why gpt-4o-mini:** Classification with structured output, not creative generation. ~$0.01 total for 200 leads.

### System Prompt

The prompt is designed to **complement the deterministic layer, not duplicate it.** Key guardrails added after edge-case review:

1. **"Do NOT invent facts"** — The AI has no web access. Without this guardrail, it might hallucinate "this company recently raised Series B" based on general knowledge.
2. **"Do NOT assume a company is a fit just because its own industry is manufacturing"** — The persona spec cares about companies that *sell into* complex verticals, not companies *in* those verticals. Steelcase *is* a manufacturer; "Allie - AI for Manufacturing" *sells into* manufacturing. Crucial distinction.
3. **"Treat unknown signals as unknown"** — If funding/layoffs/hiring aren't obvious from the provided text, don't guess.
4. **Within-company ranking** — When multiple leads from the same company appear, rank the primary buyer above champions.

### Batch Formatting — Company-Grouped

```typescript
function companyKey(c: LeadClassification): string {
  return `${c.lead.company}::${c.lead.domain}`.toLowerCase();
}
```

Candidates are **sorted by company key** before chunking, then **grouped by company within each batch**. This means the AI sees all leads from the same company together:

```
Company: Allie - AI for Manufacturing (allie-ai.com) | Startup (1–50) | Software Development
- [lead-3] Alex Sandoval — "Founder & CEO" | seniority=founder, department=executive, base_score=10
- [lead-40] Daksha Romero — "Chief Revenue Officer (CRO)" | seniority=c_level, department=sales, base_score=10
- [lead-60] Ernesto Hermosillo — "Chief Growth Officer" | seniority=c_level, department=gtm_growth, base_score=9
```

**Why this matters:** The AI can apply within-company ranking — marking the CEO/Founder as the primary buyer and others as secondary, instead of evaluating each lead in isolation.

The sort order is: company key → base score (desc) → title (alpha). Highest-scored leads appear first so the AI sees the strongest candidates before weaker ones.

### Deterministic Post-Filter

```typescript
function applyPostFilter(result: RankingResult, classification: LeadClassification): RankingResult
```

This is the **key architectural addition**: soft exclusion enforcement runs *after* AI evaluation, deterministically. The AI cannot override these rules.

| SoftExclusionKind | Action | Score cap | Rationale |
|-------------------|--------|-----------|-----------|
| `advisor_consultant_board` | Force `relevant: false` | 2 | Persona spec: "too removed from operations; no buying power" |
| `account_executive` | Force `relevant: false` | 3 | Persona spec: "closers, not outbound owners" |
| `marketing_leader` | Force `relevant: false` | 3 | Persona spec: "rarely owns outbound directly" |
| `sdr_bdr` @ mid-market/enterprise | Keep AI's `relevant`, cap score | 5 | Persona spec: "may serve as internal champions" — not killed, but capped |
| `sdr_bdr` @ startup/smb | Force `relevant: false` | 3 | Not decision-makers at this size, and no champion dynamic |

The post-filter also **normalizes scores** — `Math.max(1, Math.min(10, Math.round(result.score)))` — to ensure the AI doesn't return fractional or out-of-range values.

Reasoning is appended (not replaced) with a `Post-filter:` suffix so the review can see both the AI's original reasoning and the deterministic override.

**Why post-filter instead of hard exclusion?**
- Hard exclusions never go to the AI → no reasoning generated
- Post-filter lets the AI evaluate first (useful for the reasoning text), then enforces business rules on top
- SDR/BDR at mid-market+ can remain relevant as champions — hard exclusion would lose this nuance

### Fallback Behavior

```typescript
function buildDeterministicResult(classification: LeadClassification, reasoning: string): RankingResult
```

Used when the AI is unavailable (API error, rate limit, timeout). Produces a result from the base score alone, still passing through `applyPostFilter` so soft exclusions are enforced even without AI.

### AI Evaluation

`evaluateBatch()` sends ~20 leads to the AI and returns `RankingResult[]`.

**Happy path:**
1. `generateObject()` with Zod schema, system prompt, formatted batch
2. Map results by `lead_id`
3. For each lead: apply `applyPostFilter(ai_result, classification)`
4. If AI missed a lead → `buildDeterministicResult` fallback

**Error path:** Fall back to deterministic for the entire batch. Reasoning says "(AI unavailable)".

**`temperature: 0`** — Reproducibility. Same inputs → same outputs.

### Concurrency

```
BATCH_SIZE = 20, CONCURRENCY = 5
```

```
200 leads → ~130 hard-excluded (instant) + ~70 candidates
70 candidates → sorted by company → 4 batches
4 batches processed in 1 round (all parallel)
Total AI time: ~3–5 seconds
```

---

## Data Flow Diagram

```
CSV (200 leads)
  │
  ▼
classifyLead() ─────────────────────────────────────┐
  │                                                 │
  ├─ tier = mapTier(employee_range)                 │
  ├─ seniority = detectSeniority(title)             │
  ├─ department = detectDepartment(title)            │
  ├─ baseScore = seniority×tier + department         │
  ├─ hardExcluded? ─── YES ─→ { relevant: false,   │
  │                              score: 1, reason } │
  │                                                 │
  └─ softExcluded? ─── flag kind + continue         │
                                                    │
                 candidates (~70)                   │
                     │                              │
                     ▼                              │
           sort by company, score                   │
                     │                              │
                     ▼                              │
           chunk into batches of 20                 │
                     │                              │
                     ▼                              │
           AI evaluateBatch()                       │
           ┌──────────────────────┐                 │
           │ generateObject()     │                 │
           │ - company fit        │                 │
           │ - title validation   │                 │
           │ - within-co ranking  │                 │
           │ - final score        │                 │
           └─────────┬────────────┘                 │
                     │                              │
                     ▼                              │
           applyPostFilter()                        │
           ┌──────────────────────┐                 │
           │ normalize score      │                 │
           │ enforce soft excl.   │                 │
           │ cap / force relevant │                 │
           │ append reasoning     │                 │
           └─────────┬────────────┘                 │
                     │                              │
                     ▼                              │
           Combine all results ◄────────────────────┘
                     │
                     ▼
           NextResponse.json({ results: RankingResult[200] })
```

---

## Key Trade-offs

| Decision | Alternative | Why we chose this |
|----------|-------------|-------------------|
| Deterministic first, AI second | AI evaluates everything | Cheaper, faster, reproducible. AI focuses on judgment. |
| Hard-exclude government accounts deterministically | Let AI decide | "Ayuntamiento de Elche" is obviously not B2B. Saves tokens. |
| Hard-exclude assistant roles | Let seniority detection handle it | "Executive Assistant: CFO" falsely matched c_level seniority. Explicit check is safer. |
| Post-filter soft exclusions after AI | Let AI enforce them | Business rules shouldn't depend on LLM compliance. The AI generates reasoning; the post-filter enforces the rule. |
| SDR/BDR kept as champions at mid-market+ | Hard-exclude all SDRs | Persona spec explicitly mentions "champions (essential) — BDR Managers" at enterprise. Capping at 5 preserves this. |
| Company-grouped batching | Flat batches by count | Lets the AI compare peers at the same account and apply within-company ranking. |
| Sort candidates by company → score | Random/insertion order | Keeps same-company leads together after chunking. High-score leads first so AI sees strongest candidates. |
| Anti-hallucination guardrails in prompt | Trust AI judgment | Without guardrails, the AI invents "recently raised funding" or confuses "is in manufacturing" with "sells into manufacturing." |
| CRO matched as sales, not executive | Let executive catch it | CRO owns pipeline — that's sales function (score 5), not generic executive (score 1-2 at SMB+). |
| gpt-4o-mini / claude-sonnet | gpt-4o / claude-opus | Classification task. Cheaper model is sufficient. Total cost < $0.01. |
| temperature: 0 | temperature: 0.3+ | Reproducibility matters for ranking. |
| Full persona spec in prompt | Summarized rules | 6K tokens is cheap. Summary risks losing nuance. |
| Graceful degradation on AI error | Fail the whole request | `buildDeterministicResult` + `applyPostFilter` still produces reasonable results without AI. |
| Startup founders bypass exclusions | Apply exclusions uniformly | Spec says founders = #1 target at startups, even if title says CTO. |
