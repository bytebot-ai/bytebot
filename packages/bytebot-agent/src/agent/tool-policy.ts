export type ExecutionSurface = 'TEXT_ONLY' | 'DESKTOP';

export interface ToolPolicyContext {
  requiresDesktop?: boolean | null;
  executionSurface?: ExecutionSurface | string | null;
  gatewayToolsOnly?: boolean | null;
  allowedTools?: string[] | null;
}

const ALWAYS_ALLOWED_TOOL_NAMES = new Set(['set_task_status', 'create_task']);

function normalizeSurface(value: unknown): ExecutionSurface {
  return value === 'DESKTOP' ? 'DESKTOP' : 'TEXT_ONLY';
}

function normalizeAllowedTools(allowedTools?: string[] | null): string[] {
  if (!Array.isArray(allowedTools)) return [];
  return allowedTools
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
}

function isDesktopToolName(toolName: string): boolean {
  return toolName.startsWith('computer_');
}

function isRecognizedToolToken(token: string): boolean {
  return (
    token === 'computer' ||
    token === 'set_task_status' ||
    token === 'create_task' ||
    token.startsWith('computer_')
  );
}

export function filterToolsByPolicy<T>(
  tools: T[],
  getName: (tool: T) => string,
  context?: ToolPolicyContext | null,
): T[] {
  if (!context) return tools;

  const requiresDesktop = Boolean(context.requiresDesktop);
  const executionSurface = normalizeSurface(context.executionSurface);
  const gatewayToolsOnly = Boolean(context.gatewayToolsOnly);

  // Text-only means text-only: never expose desktop tools unless BOTH are true:
  // - requiresDesktop=true
  // - surface=DESKTOP
  const allowDesktopTools = requiresDesktop && executionSurface === 'DESKTOP' && !gatewayToolsOnly;

  const allowedTools = normalizeAllowedTools(context.allowedTools);
  const recognizedAllowList = allowedTools.filter(isRecognizedToolToken);
  const enforceAllowList = recognizedAllowList.length > 0;

  return tools.filter((tool) => {
    const name = getName(tool);

    if (ALWAYS_ALLOWED_TOOL_NAMES.has(name)) return true;

    const isDesktop = isDesktopToolName(name);
    if (isDesktop) {
      if (!allowDesktopTools) return false;
      if (!enforceAllowList) return true;
      return (
        recognizedAllowList.includes('computer') || recognizedAllowList.includes(name)
      );
    }

    if (!enforceAllowList) return true;
    return recognizedAllowList.includes(name);
  });
}

