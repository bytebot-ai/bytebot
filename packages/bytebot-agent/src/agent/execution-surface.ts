export type ExecutionSurface = 'TEXT_ONLY' | 'DESKTOP';

export function parseExecutionSurface(value: unknown): ExecutionSurface | undefined {
  if (value === 'TEXT_ONLY' || value === 'DESKTOP') return value;
  return undefined;
}

export function resolveExecutionSurface(input: {
  requiresDesktop?: boolean;
  executionSurface?: unknown;
}): ExecutionSurface {
  const explicit = parseExecutionSurface(input.executionSurface);
  if (explicit) return explicit;
  return input.requiresDesktop ? 'DESKTOP' : 'TEXT_ONLY';
}

export function shouldAcquireDesktop(input: {
  requiresDesktop: boolean;
  surface: ExecutionSurface;
  hasDesktopToolUse: boolean;
}): boolean {
  return input.requiresDesktop && input.surface === 'DESKTOP' && input.hasDesktopToolUse;
}

export function isDispatchedUserPromptStep(input: { allowedTools?: string[] | null }): boolean {
  return (input.allowedTools || []).includes('ASK_USER');
}

