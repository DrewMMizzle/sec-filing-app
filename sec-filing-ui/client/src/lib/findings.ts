import type { Filing } from "@shared/schema";

export type ReviewFinding = {
  category: string;
  headline: string;
  detail: string;
  why: string;
};

export const CATEGORY_LABELS: Record<string, string> = {
  perks_comp: "Perks & comp",
  severance_parachute: "Severance / parachute",
  related_party_insider: "Related-party / insider",
  language_governance_accounting: "Language / governance / accounting",
  other: "Other",
};

export function parseFindings(f: Filing): ReviewFinding[] {
  if (!f.reviewFindings) return [];
  try {
    const parsed = JSON.parse(f.reviewFindings);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function interestColor(level: string | null | undefined): string {
  if (level === "high") return "text-red-400";
  if (level === "medium") return "text-amber-400";
  return "text-muted-foreground";
}

// Rough per-filing Claude cost range (USD) for a footnoted review, by form type.
// Based on Opus 4.7 pricing ($5/1M input, $25/1M output) and the ~400k-char
// text cap. Long forms run near the cap; short forms (8-K) are cheap. These are
// deliberately approximate — actual cost depends on each filing's length.
const LARGE_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F", "DEF 14A", "S-1"]);

function perFilingRange(form?: string | null): [number, number] {
  if (!form) return [0.05, 0.75]; // unknown (e.g. not yet fetched)
  if (LARGE_FORMS.has(form)) return [0.15, 0.75];
  return [0.03, 0.12]; // 8-K and other short forms
}

export function estimateReviewCost(forms: Array<string | null | undefined>): { low: number; high: number } {
  let low = 0;
  let high = 0;
  for (const f of forms) {
    const [l, h] = perFilingRange(f);
    low += l;
    high += h;
  }
  return { low, high };
}

export function formatCostRange({ low, high }: { low: number; high: number }): string {
  const fmt = (n: number) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
  return `${fmt(low)}–${fmt(high)}`;
}
