import { BytebotAgentModel } from 'src/agent/agent.types';

export const DOUBAO_MODELS: BytebotAgentModel[] = [
  {
    provider: 'doubao',
    name: 'doubao-seed-1-6-vision-250815',
    title: 'doubao-seed-1-6-vision',
    contextWindow: 1047576,
  },
];

export const DEFAULT_MODEL = DOUBAO_MODELS[0];
