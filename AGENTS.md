This file provides guidance to AI coding agents working in this repository.

## Project Overview

A Next.js app that ranks sales leads against a persona spec using AI. Leads are
loaded from CSV into memory. The frontend (table + ranking trigger) is done. The
candidate implements the ranking logic in the API route.

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Start dev server (http://localhost:3000)
npm run build      # Production build (use as typecheck)
npm run lint       # Run linter
```

## Architecture

```
data/
├── leads.csv                          # 200 leads (loaded into memory)
└── persona-spec.md                    # Persona definition + ranking criteria
src/
├── app/
│   ├── page.tsx                       # Main page (wired to API, shows table)
│   ├── layout.tsx                     # Root layout
│   ├── globals.css                    # CSS variables + table styles
│   └── api/
│       ├── leads/route.ts             # GET /api/leads
│       └── rank/route.ts             # POST /api/rank (candidate implements)
├── components/
│   └── leads-table.tsx                # Table component (sorting + display)
├── data/
│   ├── leads.ts                       # CSV parser → Lead[]
│   └── persona.ts                     # Reads persona-spec.md → string
└── types/
    └── index.ts                       # All type definitions
```

## Lead CSV columns

account_name, lead_first_name, lead_last_name, lead_job_title,
account_domain, account_employee_range, account_industry
