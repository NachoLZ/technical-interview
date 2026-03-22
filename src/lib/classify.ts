import type { Lead } from "@/types";

// ── Types ──────────────────────────────────────────────────────────────

export type CompanyTier =
  | "startup"
  | "smb"
  | "mid_market"
  | "enterprise"
  | "unknown";

export type Seniority =
  | "founder"
  | "c_level"
  | "vp"
  | "director"
  | "manager"
  | "ic";

export type LeadClassification = {
  lead: Lead;
  tier: CompanyTier;
  seniority: Seniority;
  department: string;
  baseScore: number; // 1–10
  hardExcluded: boolean;
  softExcluded: boolean;
  exclusionReason?: string;
};

// ── Company tier mapping (persona spec § Lead Targeting by Company Size) ──

const TIER_MAP: Record<string, CompanyTier> = {
  "1-10": "startup",
  "2-10": "startup",
  "11-50": "startup",
  "51-200": "smb",
  "201-500": "mid_market",
  "501-1000": "mid_market",
  "1001-5000": "enterprise",
  "5001-10000": "enterprise",
  "10001+": "enterprise",
};

export const TIER_LABELS: Record<CompanyTier, string> = {
  startup: "Startup (1–50)",
  smb: "SMB (51–200)",
  mid_market: "Mid-Market (201–1,000)",
  enterprise: "Enterprise (1,000+)",
  unknown: "Unknown size",
};

export function mapTier(range: string): CompanyTier {
  return TIER_MAP[range] ?? "unknown";
}

// ── Seniority detection (persona spec § Seniority Relevance Matrix) ────
// Order matters: most specific first.

const SENIORITY_RULES: [Seniority, RegExp][] = [
  ["founder", /\b(co-?)?founder\b|\b(co-?)?owner\b/i], //Matches: "Founder & CEO", "Co-Founder", "Company Owner"
  [
    "c_level", //Matches: "CEO", "Chief Revenue Officer", "President", "Managing Partner"
    /\bceo\b|\bcro\b|\bcfo\b|\bcto\b|\bcoo\b|\bcmo\b|\bchief\b|\bpresident[e]?\b|\bprésident\b|\bpartner\b/i,
  ],
  ["vp", /\bvp\b|\bvice[- ]president\b|\bhead of\b/i], //"Head of" is mapped to VP because the persona spec lists "Head of Sales" at the same priority as "VP of Sales" in the SMB and Mid-Market tiers.
  ["director", /\bdirector[ea]?\b|\bdirecteur\b/i],
  ["manager", /\bmanager\b|\bsupervisor[a]?\b|\bjef[ea]\b/i],
];

export function detectSeniority(title: string): Seniority {
  for (const [level, pattern] of SENIORITY_RULES) {
    if (pattern.test(title)) return level;
  }
  return "ic"; //Everything else.
                //Matches: "Business Analyst", "BDR", "Sales Associate"
}

// ── Department detection (order: specific → broad) ─────────────────────

const DEPARTMENT_RULES: [string, RegExp][] = [
  ["sales_development", /\bsales development\b|\bsdr\b|\bbdr\b/i],
  [
    "revenue_operations",
    /\brevenue operations\b|\brevops\b|\bsales operations\b/i,
  ],
  ["business_development", /\bbusiness development\b/i],
  ["gtm_growth", /\bgtm\b|\bgrowth\b|\bgo[- ]to[- ]market\b/i],
  ["customer_success", /\bcustomer (success|service)\b/i],
  [
    "hr",
    /\bhuman resources\b|\bressources humaines\b|\brecursos humanos\b|\btalent\b|\brecruit|\bemployer brand/i,
  ],
  ["legal", /\blegal\b|\bcompliance\b|\bcounsel\b|\babogado\b/i],
  [
    "finance",
    /\bfinance[s]?\b|\bfinancial\b|\bcfo\b|\baccounting\b|\baccounts payable\b|\bbilling\b/i,
  ],
  ["product", /\bproduct manag/i],
  ["marketing", /\bmarketing\b|\bcmo\b|\bcontent creator\b|\bgraphic design/i],
  // Executive before sales/engineering so "Founder & CEO" → executive, not engineering
  [
    "executive",
    /\bceo\b|\bfounder\b|\bowner\b|\bpresident\b|\bmanaging director\b|\bpartner\b/i,
  ],
  [
    "sales",
    /\bsales\b|\baccount (manager|executive)\b|\bcommercial\b|\bcomercial\b|\bventes\b/i,
  ],
  [
    "engineering",
    /\bengineer\b|\bdeveloper\b|\bwelder\b|\boperator\b|\bmaintenance\b|\bassembly\b|\btechnician\b|\bquality\b|\bsoftware\b|\bproduction\b|\bproducción\b|\bvisuali[sz]/i,
  ],
  [
    "operations",
    /\boperations\b|\bsupply chain\b|\bmaterial[s]?\s*(plan|handl|special)|\bfulfillment\b|\blogistics\b|\bwarehouse\b/i,
  ],
];

export function detectDepartment(title: string): string {
  for (const [dept, pattern] of DEPARTMENT_RULES) {
    if (pattern.test(title)) return dept;
  }
  return "other";
}

// ── Scoring matrices (persona spec § Seniority Relevance Matrix + § Department Priority)

const SENIORITY_SCORES: Record<Seniority, Record<CompanyTier, number>> = {
  founder: { startup: 5, smb: 3, mid_market: 1, enterprise: 0, unknown: 3 },
  c_level: { startup: 5, smb: 3, mid_market: 2, enterprise: 1, unknown: 3 },
  vp: { startup: 3, smb: 5, mid_market: 5, enterprise: 5, unknown: 4 },
  director: { startup: 2, smb: 4, mid_market: 5, enterprise: 4, unknown: 3 },
  manager: { startup: 1, smb: 2, mid_market: 3, enterprise: 3, unknown: 2 },
  ic: { startup: 0, smb: 0, mid_market: 1, enterprise: 1, unknown: 0 },
};

const DEPARTMENT_SCORES: Record<string, number> = {
  sales_development: 5,
  sales: 5,
  revenue_operations: 4,
  business_development: 4,
  gtm_growth: 4,
};

function getDepartmentScore(dept: string, tier: CompanyTier): number {
  if (dept === "executive") {
    // Persona spec: Executive is 5/5 at startups, drops sharply elsewhere
    return tier === "startup" ? 5 : tier === "smb" ? 2 : 1;
  }
  return DEPARTMENT_SCORES[dept] ?? 0;
}

export function computeBaseScore(
  seniority: Seniority,
  department: string,
  tier: CompanyTier,
): number {
  const s = SENIORITY_SCORES[seniority][tier];
  const d = getDepartmentScore(department, tier);
  return Math.max(1, Math.min(10, s + d));
}

// ── Hard exclusions (persona spec § Who NOT to Contact) ────────────────

function checkHardExclusion(
  lead: Lead,
  tier: CompanyTier,
  seniority: Seniority,
  dept: string,
): string | null {
  const title = lead.job_title.trim();

  // Unusable title (empty, too short, or looks like a URL / data error)
  if (!title || title.length < 3 || /\.\w{2,4}$/.test(title)) {
    return "No usable job title";
  }

  // Not in workforce
  if (/\bretired\b/i.test(title)) return "Retired";
  if (/\bstudent\b/i.test(title)) return "Student";
  if (/\bintern\b/i.test(title) && !/\binternal\b/i.test(title))
    return "Intern";

  // Founders at startups are always primary targets, even if title includes CTO etc.
  if (seniority === "founder" && tier === "startup") return null;

  // CEO / President hard-excluded at mid-market and enterprise
  if (
    (tier === "mid_market" || tier === "enterprise") &&
    /\b(ceo|president[e]?|président)\b/i.test(title)
  ) {
    return "CEO/President at mid-market+ — too far removed from outbound";
  }

  // Department-based hard exclusions (any tier)
  if (dept === "finance") return "Finance department";
  if (dept === "engineering") return "Engineering/Technical role";
  if (dept === "hr") return "HR/Talent role";
  if (dept === "legal") return "Legal/Compliance role";
  if (dept === "customer_success") return "Customer Success — post-sale focus";
  if (dept === "product") return "Product Management — different function";

  return null;
}

// ── Soft exclusions (persona spec § Soft Exclusions) ───────────────────

function checkSoftExclusion(title: string): string | null {
  if (/\bbdr\b|\bsdr\b/i.test(title))
    return "BDR/SDR — not decision-makers";
  if (/\baccount executive\b/i.test(title))
    return "Account Executive — closer, not outbound owner";
  if (
    /\bcmo\b/i.test(title) ||
    (/\bvp\b/i.test(title) && /\bmarketing\b/i.test(title))
  ) {
    return "CMO/VP Marketing — rarely owns outbound";
  }
  if (/\badvisor\b|\bconsultant\b|\bboard\b/i.test(title)) {
    return "Advisor/Consultant/Board — too removed or no buying power";
  }
  return null;
}

// ── Main classification ────────────────────────────────────────────────

export function classifyLead(lead: Lead): LeadClassification {
  const tier = mapTier(lead.employee_range);
  const seniority = detectSeniority(lead.job_title);
  const department = detectDepartment(lead.job_title);
  const baseScore = computeBaseScore(seniority, department, tier);

  const hardExclusion = checkHardExclusion(lead, tier, seniority, department);
  const softExclusion = hardExclusion
    ? null
    : checkSoftExclusion(lead.job_title);

  return {
    lead,
    tier,
    seniority,
    department,
    baseScore,
    hardExcluded: !!hardExclusion,
    softExcluded: !!softExclusion,
    exclusionReason: hardExclusion ?? softExclusion ?? undefined,
  };
}
