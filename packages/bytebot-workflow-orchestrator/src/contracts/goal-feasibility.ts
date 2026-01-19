import { ExecutionSurface } from '@prisma/client';

export type GoalFeasibilityInference = {
  requiredSurface: ExecutionSurface;
  reason: string;
};

/**
 * Infer the minimum required execution surface for a goal.
 *
 * This is a *feasibility* gate, not a strategy selector. It should:
 * - Prefer deterministic signals when available
 * - Be conservative (upgrade to DESKTOP when in doubt for web-shopping goals)
 * - Avoid creating user prompts (strategy must never block execution)
 *
 * NOTE: Until GoalSpec schemas are domain-specific, we use a small, auditable
 * keyword/regex gate for travel-shopping to prevent misroutes to TEXT_ONLY.
 */
export function inferGoalFeasibility(goal: string | null | undefined): GoalFeasibilityInference | null {
  const text = String(goal ?? '').trim().toLowerCase();
  if (!text) return null;

  // Travel-shopping: requires interacting with live web UIs (aggregators, booking sites).
  // Examples seen in incidents: "price a trip with flight and hotel", "search for round-trip flights".
  const travelPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bflight(s)?\b/, reason: 'keyword:flight' },
    { pattern: /\bairfare\b/, reason: 'keyword:airfare' },
    { pattern: /\bround[- ]?trip\b/, reason: 'keyword:round-trip' },
    { pattern: /\bdepart(ing|ure)?\b/, reason: 'keyword:depart' },
    { pattern: /\breturn(ing)?\b/, reason: 'keyword:return' },
    { pattern: /\bhotel(s)?\b/, reason: 'keyword:hotel' },
    { pattern: /\bcar rental\b/, reason: 'keyword:car-rental' },
    { pattern: /\bbooking\.com\b/, reason: 'site:booking.com' },
    { pattern: /\bexpedia\b/, reason: 'site:expedia' },
    { pattern: /\bkayak\b/, reason: 'site:kayak' },
    { pattern: /\bgoogle flights\b/, reason: 'site:google-flights' },
  ];

  for (const entry of travelPatterns) {
    if (entry.pattern.test(text)) {
      return { requiredSurface: ExecutionSurface.DESKTOP, reason: `travel-shopping(${entry.reason})` };
    }
  }

  return null;
}

