export type NeedsHelpErrorCode =
  | 'GOAL_INTAKE_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'DESKTOP_TAKEOVER_REQUIRED'
  | 'DISPATCHED_USER_PROMPT_STEP'
  | 'DESKTOP_NOT_ALLOWED'
  | 'LLM_EMPTY_RESPONSE'
  | 'TOOL_CONTRACT_VIOLATION'
  | 'LOOP_DETECTED_NO_PROGRESS'
  | 'UI_OBSERVATION_FAILED'
  | 'UI_BLOCKED_SIGNIN'
  | 'UI_BLOCKED_POPUP'
  | 'CAPABILITY_MISMATCH'
  | 'LLM_PROXY_DOWN'
  | 'MODEL_UNAVAILABLE'
  | 'WAITING_PROVIDER'
  | 'CONTRACT_VIOLATION_UNTYPED_NEEDS_HELP'
  | 'CONTRACT_VIOLATION_STRATEGY_AS_HELP'
  // Deprecated: do not emit. Kept for backward compatibility with older models.
  | 'AGENT_REQUESTED_HELP';

export type NeedsHelpResult = {
  errorCode: NeedsHelpErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

const NEEDS_HELP_ERROR_CODE_SET = new Set<NeedsHelpErrorCode>([
  'GOAL_INTAKE_REQUIRED',
  'APPROVAL_REQUIRED',
  'DESKTOP_TAKEOVER_REQUIRED',
  'DISPATCHED_USER_PROMPT_STEP',
  'DESKTOP_NOT_ALLOWED',
  'LLM_EMPTY_RESPONSE',
  'TOOL_CONTRACT_VIOLATION',
  'LOOP_DETECTED_NO_PROGRESS',
  'UI_OBSERVATION_FAILED',
  'UI_BLOCKED_SIGNIN',
  'UI_BLOCKED_POPUP',
  'CAPABILITY_MISMATCH',
  'LLM_PROXY_DOWN',
  'MODEL_UNAVAILABLE',
  'WAITING_PROVIDER',
  'CONTRACT_VIOLATION_UNTYPED_NEEDS_HELP',
  'CONTRACT_VIOLATION_STRATEGY_AS_HELP',
  'AGENT_REQUESTED_HELP',
]);

export function parseNeedsHelpErrorCode(value: unknown): NeedsHelpErrorCode | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return NEEDS_HELP_ERROR_CODE_SET.has(trimmed as NeedsHelpErrorCode)
    ? (trimmed as NeedsHelpErrorCode)
    : null;
}

const DEFAULT_MESSAGES: Record<NeedsHelpErrorCode, string> = {
  GOAL_INTAKE_REQUIRED:
    'This task requires additional user-provided details before it can proceed.',
  APPROVAL_REQUIRED:
    'This task requires explicit user approval before it can proceed.',
  DESKTOP_TAKEOVER_REQUIRED:
    'This task requires human takeover to proceed (e.g., sign-in, MFA, CAPTCHA, or other UI blocker).',
  DISPATCHED_USER_PROMPT_STEP:
    'This task requires user input and must not be executed by the agent.',
  DESKTOP_NOT_ALLOWED:
    'Desktop tools were requested, but this task is configured for TEXT_ONLY execution.',
  LLM_EMPTY_RESPONSE: 'LLM returned an empty response.',
  TOOL_CONTRACT_VIOLATION:
    'The desktop automation tool contract was violated repeatedly; execution paused for safety.',
  LOOP_DETECTED_NO_PROGRESS:
    'Desktop automation appears stuck in a no-progress loop; execution paused for safety.',
  UI_OBSERVATION_FAILED:
    'Unable to reliably observe the desktop state (screenshots missing); execution paused for safety.',
  UI_BLOCKED_SIGNIN:
    'The UI appears blocked by a sign-in flow that requires human action.',
  UI_BLOCKED_POPUP:
    'The UI appears blocked by a popup/modal that requires human action.',
  CAPABILITY_MISMATCH:
    'The task requested capabilities that are not available on this agent/runtime.',
  LLM_PROXY_DOWN:
    'The LLM gateway/proxy is unreachable; execution paused while waiting for provider recovery.',
  MODEL_UNAVAILABLE:
    'The requested model is unavailable; execution paused while waiting for capacity.',
  WAITING_PROVIDER:
    'The required provider/model capacity is unavailable; execution paused while waiting.',
  CONTRACT_VIOLATION_UNTYPED_NEEDS_HELP:
    'Agent returned NEEDS_HELP without a valid errorCode; treating as a contract violation.',
  CONTRACT_VIOLATION_STRATEGY_AS_HELP:
    'Agent attempted to ask a strategy question via NEEDS_HELP; treating as a contract violation.',
  AGENT_REQUESTED_HELP:
    'Agent requested help (deprecated); treating as a contract violation.',
};

export function buildNeedsHelpResult(input: {
  errorCode: NeedsHelpErrorCode;
  message?: string | null;
  details?: Record<string, unknown> | null;
}): NeedsHelpResult {
  const message =
    typeof input.message === 'string' && input.message.trim().length > 0
      ? input.message.trim()
      : DEFAULT_MESSAGES[input.errorCode];

  const details =
    input.details && typeof input.details === 'object' ? input.details : undefined;

  return {
    errorCode: input.errorCode,
    message,
    ...(details ? { details } : {}),
  };
}
