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

  // Weak travel cues must never trigger on their own (avoid false positives for common words like "return").
  // Only classify travel when the combined intent is very likely travel-shopping.
  const hasDepartWord = /\bdepart(?:ing|ure)?\b/.test(text);
  const hasReturnWord = /\breturn(?:ing)?\b/.test(text);

  // Minimal "date-like" matcher: common short numeric dates and month names.
  // We purposely keep this small and auditable to avoid stringy NL heuristics.
  const hasDateLikeToken =
    /\b(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/.test(
      text,
    );

  if (hasDepartWord && hasReturnWord && hasDateLikeToken) {
    return {
      requiredSurface: ExecutionSurface.DESKTOP,
      reason: 'travel-shopping(keyword:depart+return+date)',
    };
  }

  return null;
}
