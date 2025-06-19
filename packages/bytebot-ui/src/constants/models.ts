// Model identifiers using actual Anthropic model names
export const CLAUDE_SONNET_4 = 'claude-sonnet-4-20250514';
export const CLAUDE_OPUS_4 = 'claude-opus-4-20250514';

export const MODEL_DISPLAY_NAMES = {
  [CLAUDE_SONNET_4]: 'Claude Sonnet 4.0',
  [CLAUDE_OPUS_4]: 'Claude Opus 4.0',
} as const;

export const SUPPORTED_MODELS = [
  {
    value: CLAUDE_SONNET_4,
    label: MODEL_DISPLAY_NAMES[CLAUDE_SONNET_4],
  },
  {
    value: CLAUDE_OPUS_4,
    label: MODEL_DISPLAY_NAMES[CLAUDE_OPUS_4],
  },
] as const;

export const DEFAULT_MODEL = CLAUDE_SONNET_4;