import { BytebotAgentModel } from './agent/agent.types';

export const getCustomModels = (): BytebotAgentModel[] => {
  const llmConfigJson = process.env.LLM_CONFIG_JSON;
  if (!llmConfigJson) {
    return [];
  }

  try {
    const customModels = JSON.parse(llmConfigJson);
    if (Array.isArray(customModels)) {
      return customModels as BytebotAgentModel[];
    }
    return [];
  } catch (error) {
    console.error('Failed to parse LLM_CONFIG_JSON', error);
    return [];
  }
};
