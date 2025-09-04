import { BytebotAgentModel } from '../agent/agent.types';

export const ANTHROPIC_MODELS: BytebotAgentModel[] = [
  {
    provider: 'anthropic',
    name: 'claude-opus-4-1-20250805',
    title: 'Claude Opus 4.1',
    contextWindow: 200000,
  },
  {
    provider: 'anthropic',
    name: 'claude-sonnet-4-20250514',
    title: 'Claude Sonnet 4',
    contextWindow: 200000,
  },
];

export const DEFAULT_MODEL = ANTHROPIC_MODELS[0];
