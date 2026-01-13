export type CanonicalInteractionToolToken = 'ASK_USER' | 'APPROVAL';

export const CANONICAL_INTERACTION_TOOL_TOKENS: ReadonlyArray<CanonicalInteractionToolToken> = [
  'ASK_USER',
  'APPROVAL',
];

export type PlannerOutputContractViolationCode =
  | 'UNKNOWN_SUGGESTED_TOOL_TOKEN'
  | 'EXECUTE_STEP_HAS_INTERACTION_TOOL';

export class PlannerOutputContractViolationError extends Error {
  readonly code: PlannerOutputContractViolationCode;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    code: PlannerOutputContractViolationCode;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'PlannerOutputContractViolationError';
    this.code = params.code;
    this.details = params.details;
  }
}

export class UnknownSuggestedToolTokenError extends PlannerOutputContractViolationError {
  readonly toolToken: string;

  constructor(params: { toolToken: string; allowedTools: string[] }) {
    super({
      code: 'UNKNOWN_SUGGESTED_TOOL_TOKEN',
      message: `Planner output contains an unknown suggestedTools token: ${JSON.stringify(params.toolToken)}`,
      details: { toolToken: params.toolToken, allowedTools: params.allowedTools },
    });
    this.name = 'UnknownSuggestedToolTokenError';
    this.toolToken = params.toolToken;
  }
}

export class ExecuteStepHasInteractionToolError extends PlannerOutputContractViolationError {
  constructor(params: { stepIndex: number; stepDescription: string; interactionTool: string }) {
    super({
      code: 'EXECUTE_STEP_HAS_INTERACTION_TOOL',
      message:
        `Planner output misclassified an interaction step as EXECUTE (stepIndex=${params.stepIndex}, ` +
        `interactionTool=${JSON.stringify(params.interactionTool)}): ${params.stepDescription}`,
      details: {
        stepIndex: params.stepIndex,
        stepDescription: params.stepDescription,
        interactionTool: params.interactionTool,
      },
    });
    this.name = 'ExecuteStepHasInteractionToolError';
  }
}

const INTERACTION_TOOL_ALIASES: Record<string, CanonicalInteractionToolToken> = {
  // Canonical
  ask_user: 'ASK_USER',
  approval: 'APPROVAL',

  // Backwards-compatible aliases (planner drift)
  chat: 'ASK_USER',
  prompt_user: 'ASK_USER',
  confirm_user: 'ASK_USER',
  prompt_the_user: 'ASK_USER',
  ask_the_user: 'ASK_USER',
  user_input: 'ASK_USER',

  // Common synonyms
  approve: 'APPROVAL',
  request_approval: 'APPROVAL',
  ask_approval: 'APPROVAL',
};

// When GoalRun.constraints.allowedTools is missing, we still enforce a contract-level
// allowlist to fail-closed against "invented tools" and schema drift.
const DEFAULT_EXECUTION_TOOL_TOKENS: ReadonlyArray<string> = [
  // Desktop / computer-use tools (agent-side)
  'computer',
  'click',
  'type',
  'key',
  'scroll',
  'screenshot',
  'move',
  'drag',
  'cursor_position',

  // Common planner hints used in ByteBot plans/templates
  'browser',
  'file_download',
  'email',
  'Shell',

  // Butler gateway tool names (agent-side)
  'search_web_search',
  'search_news',
  'weather_get_current',
  'weather_get_forecast',
  'communications_send_email',
  'communications_send_sms',
  'calendar_list_events',
  'calendar_create_event',
  'calendar_delete_event',
  'notes_create',
  'notes_list',
  'notes_delete',
  'document_parse',
  'document_summarize',
  'data_extract',
  'data_transform',
  'file_read',
  'file_write',
  'file_list',
  'integration_webhook',
  'integration_api_call',
];

function normalizeToolTokenKey(token: string): string {
  return token.trim().toLowerCase();
}

export function toCanonicalInteractionToolToken(token: string): CanonicalInteractionToolToken | null {
  return INTERACTION_TOOL_ALIASES[normalizeToolTokenKey(token)] ?? null;
}

export function hasUserInteractionTool(suggestedTools?: string[] | null): boolean {
  const tools = Array.isArray(suggestedTools) ? suggestedTools : [];
  for (const raw of tools) {
    if (typeof raw !== 'string') continue;
    if (toCanonicalInteractionToolToken(raw)) return true;
  }
  return false;
}

export function normalizeSuggestedToolsOrThrow(params: {
  suggestedTools?: string[] | null;
  allowedTools?: string[] | null;
}): string[] {
  const rawTools = Array.isArray(params.suggestedTools) ? params.suggestedTools : [];

  const allowedTools = Array.isArray(params.allowedTools) ? params.allowedTools : [];
  const allowedByKey = new Map<string, string>();
  for (const t of allowedTools) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (!trimmed) continue;
    allowedByKey.set(normalizeToolTokenKey(trimmed), trimmed);
  }

  const defaultByKey = new Map<string, string>();
  for (const t of DEFAULT_EXECUTION_TOOL_TOKENS) {
    defaultByKey.set(normalizeToolTokenKey(t), t);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawTools) {
    if (typeof raw !== 'string') {
      throw new UnknownSuggestedToolTokenError({
        toolToken: String(raw),
        allowedTools,
      });
    }

    const trimmed = raw.trim();
    if (!trimmed) continue;

    const interaction = toCanonicalInteractionToolToken(trimmed);
    const key = normalizeToolTokenKey(trimmed);
    const canonical = interaction ?? allowedByKey.get(key) ?? defaultByKey.get(key);

    if (!canonical) {
      throw new UnknownSuggestedToolTokenError({
        toolToken: trimmed,
        allowedTools,
      });
    }

    if (!seen.has(canonical)) {
      normalized.push(canonical);
      seen.add(canonical);
    }
  }

  return normalized;
}

