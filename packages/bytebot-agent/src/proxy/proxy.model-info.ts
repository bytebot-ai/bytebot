/**
 * Cache for OpenRouter model data to supplement LiteLLM
 * This avoids repeated API calls when LiteLLM doesn't provide context windows
 */
let openRouterModelsCache: Map<string, number> | null = null;
let openRouterCacheTimestamp = 0;
const CACHE_TTL = 3600000; // 1 hour in milliseconds

/**
 * Fetch model context windows from OpenRouter API
 * Used when LiteLLM doesn't provide the data
 */
async function fetchOpenRouterModels(): Promise<Map<string, number>> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`OpenRouter API returned ${response.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = await response.json();
    const modelMap = new Map<string, number>();

    // Build a map of model ID to context length
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (data.data && Array.isArray(data.data)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      for (const model of data.data) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (model.id && model.context_length) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
          modelMap.set(model.id, model.context_length);
        }
      }
    }

    return modelMap;
  } catch (error) {
    console.error('Failed to fetch OpenRouter models:', error);
    return new Map();
  }
}

/**
 * Get OpenRouter models with caching
 */
async function getOpenRouterModels(): Promise<Map<string, number>> {
  const now = Date.now();

  // Return cached data if still valid
  if (openRouterModelsCache && now - openRouterCacheTimestamp < CACHE_TTL) {
    return openRouterModelsCache;
  }

  // Fetch fresh data
  openRouterModelsCache = await fetchOpenRouterModels();
  openRouterCacheTimestamp = now;

  return openRouterModelsCache;
}

/**
 * Extract model ID from litellm_params.model path
 * Example: "openrouter/anthropic/claude-sonnet-4.5" -> "anthropic/claude-sonnet-4.5"
 */
function extractModelId(litellmModel: string): string | null {
  if (!litellmModel) return null;

  // Remove "openrouter/" prefix if present
  if (litellmModel.startsWith('openrouter/')) {
    return litellmModel.substring('openrouter/'.length);
  }

  return litellmModel;
}

/**
 * Default context window as final fallback
 */
const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Extract context window from LiteLLM model info response
 * 
 * DYNAMIC PRIORITY:
 * 1. LiteLLM's model_info.max_input_tokens (if provided)
 * 2. LiteLLM's model_info.max_tokens (if provided)
 * 3. OpenRouter API context_length (for OpenRouter models when LiteLLM returns null)
 * 4. Default fallback (128000)
 * 
 * See: https://docs.litellm.ai/docs/proxy/model_management
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function extractContextWindow(modelInfo: any): Promise<number> {
  // PRIORITY 1 & 2: Check LiteLLM's model_info first
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (modelInfo.model_info) {
    // max_input_tokens is the most accurate for context window (preferred)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (
      modelInfo.model_info.max_input_tokens &&
      typeof modelInfo.model_info.max_input_tokens === 'number'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
      return modelInfo.model_info.max_input_tokens;
    }

    // Fall back to max_tokens if max_input_tokens is not available
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (
      modelInfo.model_info.max_tokens &&
      typeof modelInfo.model_info.max_tokens === 'number'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
      return modelInfo.model_info.max_tokens;
    }
  }

  // Try top-level fields as well (in case structure varies)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (
    modelInfo.max_input_tokens &&
    typeof modelInfo.max_input_tokens === 'number'
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return modelInfo.max_input_tokens;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (modelInfo.max_tokens && typeof modelInfo.max_tokens === 'number') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return modelInfo.max_tokens;
  }

  // PRIORITY 3: If LiteLLM returns null (common with OpenRouter), fetch from OpenRouter API
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const litellmModel = modelInfo.litellm_params?.model;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const isOpenRouter = litellmModel && litellmModel.includes('openrouter');

  if (isOpenRouter) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const modelId = extractModelId(litellmModel);
    if (modelId) {
      const openRouterModels = await getOpenRouterModels();
      const contextWindow = openRouterModels.get(modelId);

      if (contextWindow) {
        return contextWindow;
      }
    }
  }

  // PRIORITY 4: Final fallback
  return DEFAULT_CONTEXT_WINDOW;
}
