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
