import { BytebotAgentModel } from 'src/agent/agent.types';

// Only include models that support vision (image inputs)
// This is required for computer-use agents that send screenshots
export const OPENAI_MODELS: BytebotAgentModel[] = [
  {
    provider: 'openai',
    name: 'gpt-4o',
    title: 'GPT-4o',
    contextWindow: 128000,
  },
  {
    provider: 'openai',
    name: 'gpt-4o-mini',
    title: 'GPT-4o Mini',
    contextWindow: 128000,
  },
  {
    provider: 'openai',
    name: 'gpt-4-turbo',
    title: 'GPT-4 Turbo',
    contextWindow: 128000,
  },
  {
    provider: 'openai',
    name: 'gpt-4',
    title: 'GPT-4',
    contextWindow: 8192,
  },
];

export const DEFAULT_MODEL = OPENAI_MODELS[0];
