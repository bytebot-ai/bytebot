import { BytebotAgentModel } from '../agent/agent.types';

export const OPENROUTER_MODELS: BytebotAgentModel[] = [
  {
    provider: 'openrouter',
    name: 'anthropic/claude-3.5-sonnet',
    title: 'Claude 3.5 Sonnet (OpenRouter)',
    contextWindow: 200000,
  },
  {
    provider: 'openrouter',
    name: 'openai/gpt-4-turbo',
    title: 'GPT-4 Turbo (OpenRouter)',
    contextWindow: 128000,
  },
  {
    provider: 'openrouter',
    name: 'google/gemini-pro-1.5',
    title: 'Gemini Pro 1.5 (OpenRouter)',
    contextWindow: 1000000,
  },
  {
    provider: 'openrouter',
    name: 'meta-llama/llama-3.1-405b-instruct',
    title: 'Llama 3.1 405B (OpenRouter)',
    contextWindow: 32768,
  },
  {
    provider: 'openrouter',
    name: 'mistralai/mistral-large-2407',
    title: 'Mistral Large (OpenRouter)',
    contextWindow: 128000,
  },
];

export const DEFAULT_MODEL = OPENROUTER_MODELS[0];