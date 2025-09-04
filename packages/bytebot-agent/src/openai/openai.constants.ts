import { BytebotAgentModel } from 'src/agent/agent.types';

export const OPENAI_MODELS: BytebotAgentModel[] = [
  {
    provider: 'openai',
    name: 'o3-2025-04-16',
    title: 'o3',
    contextWindow: 200000,
  },
  {
    provider: 'openai',
    name: 'gpt-4.1-2025-04-14',
    title: 'GPT-4.1',
    contextWindow: 1047576,
  },
];

export const DEFAULT_MODEL = OPENAI_MODELS[0];
