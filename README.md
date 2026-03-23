# Persona Ranker — Completed Technical Challenge

> **This is my completed solution** to a take-home coding exercise from [Throxy](https://throxy.com). The original challenge prompt is preserved below for context.

## My Solution

A four-layer persona ranking system that classifies ~200 leads against an ideal customer persona, combining deterministic rules with AI-powered evaluation:

1. **Deterministic classification** — Rules derived from the persona spec handle ~60–70% of leads instantly (hard exclusions, seniority/department detection, tier mapping). No API calls needed.
2. **Company research** — GPT 5.4 with web search gathers real qualification signals (funding, hiring, PLG, layoffs) per unique company. One call per company, cached and shared across leads.
3. **AI lead evaluation** — LLM evaluates remaining candidates in batches with research context, applying within-company ranking and structured scoring via Zod schemas.
4. **Deterministic post-filter** — Enforces soft exclusion business rules after AI evaluation. The AI generates reasoning; the post-filter enforces the rules.

### Key files

| File | Role |
| --- | --- |
| `src/app/api/rank/route.ts` | API route — orchestrates research, evaluation, and post-filtering |
| `src/lib/classify.ts` | Pure deterministic classification (tier, seniority, department, scoring, exclusions) |
| `ARCHITECTURE.md` | Full architecture walkthrough and design rationale |

### Tech stack

- **Next.js** (App Router) + TypeScript
- **Vercel AI SDK** with OpenAI and Anthropic providers
- Web search for real-time company qualification signals

### Running it

```bash
npm install
cp .env.example .env.local   # add your OpenAI or Anthropic API key
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Original Challenge Prompt

### About Throxy

We're an AI-powered sales company booking meetings in traditional industries. We're a data company at our core; we find the ideal accounts and leads to book you meetings.

We're growing fast and hiring full stack developers for our internal platform.

### The Challenge

Build our **persona ranking system**: given a list of people at target companies, qualify and rank them against an ideal customer persona and surface the best relevant contacts for each company.

A goal use case of this system would be to create email campaigns where we only contact the most fit N **relevant** leads per company.

If a lead is not relevant, we won't want to contact them. For example, we might only have the contact of an HR worker at a company, but that doesn't mean we should contact them to sell a sales platform. Relevance filtering should be part of your ranking process.

This repo is scaffolded for you:

- Leads are loaded from CSV into memory and displayed in a table
- The page is wired to call `POST /api/rank` and show results
- You implement the ranking logic in one API route

Your time goes into the ranking strategy, prompt design, and AI integration.

### Setup

```bash
npm install
cp .env.example .env.local   # add your AI provider API key
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### What to implement

Open `src/app/api/rank/route.ts`. This is the main file you need to change.

1. Design a prompt strategy that evaluates leads against the persona spec
2. Call the AI to rank each lead
3. Return results matching the `RankingResult` type

The [Vercel AI SDK](https://sdk.vercel.ai) is included with OpenAI and Anthropic providers. See `.env.example` for the API key variable names.

The persona spec is available as `PERSONA_SPEC` (a markdown string) and all leads are available as `LEADS` (a typed array). Both are already imported in the route file.

You're free to add files, helpers, or utilities as needed. You can modify the frontend if you want, but it's not required.

### Data

| File | Description |
| --- | --- |
| `data/leads.csv` | ~200 leads to rank |
| `data/persona-spec.md` | Ideal persona definition and disqualification criteria |

Leads are loaded into memory on server start. No database required. Types are pre-defined in `src/types/index.ts`.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/leads` | `GET` | List all leads |
| `/api/rank` | `POST` | Rank leads against persona |

### What NOT to worry about

- Database setup (leads are in memory)
- Deployment (you'll run it locally during the review)
- UI design (the table and layout are provided)
- Project structure (the scaffolding is already organized)

### Time expectation

This should take **2-3 hours**. The scaffolding removes the boilerplate; your time goes into the ranking strategy, prompt design, and wiring things together.

### AI / LLM usage

We expect you to use AI to finish this task. All code written and decisions taken will be treated and evaluated as your own.

Being able to recognize when the AI follows anti-patterns, makes mistakes on edge cases, or isn't aligned with the positive business outcome of a feature is the most important skill we're looking for.
