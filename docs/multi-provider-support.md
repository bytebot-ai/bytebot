# Multi-Provider Support Documentation

## Overview

ByteBot now supports multiple AI providers through a unified interface, allowing users to switch between different AI services based on their needs, costs, and preferences.

## Supported Providers

### Current Providers

1. **Anthropic Claude** (`anthropic`)
   - Models: Claude Opus 4.1, Claude Sonnet 4
   - API Key: `ANTHROPIC_API_KEY`
   - Strengths: Advanced reasoning, long conversations

2. **OpenAI** (`openai`)
   - Models: o3, GPT-4.1
   - API Key: `OPENAI_API_KEY`
   - Strengths: Broad capabilities, tool use

3. **Google Gemini** (`google`)
   - Models: Gemini 2.5 Pro, Gemini 2.5 Flash
   - API Key: `GEMINI_API_KEY`
   - Strengths: Large context windows, multimodal

4. **OpenRouter** (`openrouter`)
   - Models: Multiple models through unified API
   - API Key: `OPENROUTER_API_KEY`
   - Strengths: Access to many models, cost optimization

## Architecture

### Base Provider Interface

All providers implement the `BaseProvider` interface:

```typescript
interface BaseProvider {
  send(systemPrompt: string, messages: Message[], model: string, useTools: boolean, signal?: AbortSignal): Promise<BytebotAgentResponse>;
  stream?(systemPrompt: string, messages: Message[], model: string, useTools: boolean, signal?: AbortSignal): AsyncGenerator<Partial<BytebotAgentResponse>>;
  healthCheck(): Promise<boolean>;
  getAvailableModels(): Promise<string[]>;
}
```

### Provider Manager Service

The `ProviderManagerService` handles:
- Provider discovery and status
- Model enumeration
- Provider health checks
- Dynamic provider switching

## API Endpoints

### Get All Providers
```
GET /providers
```
Returns all configured providers with their status.

### Get Enabled Providers
```
GET /providers/enabled
```
Returns only providers with valid API keys.

### Get All Models
```
GET /providers/models
```
Returns all available models from enabled providers.

### Get Provider Models
```
GET /providers/:providerId/models
```
Returns models for a specific provider.

### Test Provider
```
POST /providers/:providerId/test
```
Tests if a provider is working correctly.

### Refresh Providers
```
POST /providers/refresh
```
Refreshes provider status after API key changes.

## Configuration

### Environment Variables

Set API keys as environment variables:

```bash
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_API_KEY=your_openai_key
GEMINI_API_KEY=your_gemini_key
OPENROUTER_API_KEY=your_openrouter_key
```

### Provider Selection

Providers are automatically enabled when their API key is configured. The system will:
1. Use the first available provider by default
2. Allow manual provider/model selection through the UI
3. Fall back gracefully if a provider becomes unavailable

## Usage Examples

### Basic Usage

```typescript
// Get available providers
const providers = providerManager.getEnabledProviders();

// Get models for a specific provider
const models = providerManager.getModelsForProvider('openrouter');

// Get a provider service
const service = providerManager.getProviderService('anthropic');

// Generate a message
const response = await service.generateMessage(
  systemPrompt,
  messages,
  'claude-opus-4-1-20250805',
  true
);
```

### Health Checks

```typescript
// Check if a provider is healthy
const isHealthy = await providerManager.testProvider('openrouter');

// Get overall system health
const enabledProviders = providerManager.getEnabledProviders();
const healthResults = await Promise.all(
  enabledProviders.map(p => providerManager.testProvider(p.id))
);
```

## Adding New Providers

To add a new provider:

1. **Create Provider Service**
   ```typescript
   @Injectable()
   export class NewProviderService implements BytebotAgentService, BaseProvider {
     // Implement required methods
   }
   ```

2. **Create Constants**
   ```typescript
   export const NEW_PROVIDER_MODELS: BytebotAgentModel[] = [
     // Define available models
   ];
   ```

3. **Create Module**
   ```typescript
   @Module({
     providers: [NewProviderService],
     exports: [NewProviderService],
   })
   export class NewProviderModule {}
   ```

4. **Update Provider Manager**
   - Add to constructor dependencies
   - Add to services map
   - Add to providerConfigs array

5. **Update App Module**
   - Import the new provider module

## Testing

### Unit Tests
- Provider service functionality
- Provider manager logic
- Error handling

### Integration Tests
- API endpoint functionality
- Provider switching
- Health checks

### Example Test
```typescript
describe('NewProviderService', () => {
  it('should generate messages successfully', async () => {
    const response = await service.generateMessage(
      'Test prompt',
      messages,
      'test-model',
      true
    );
    
    expect(response.contentBlocks).toBeDefined();
    expect(response.tokenUsage).toBeDefined();
  });
});
```

## Error Handling

The system includes robust error handling:
- Graceful degradation when providers are unavailable
- Automatic fallbacks
- Comprehensive logging
- User-friendly error messages

## Security Considerations

- API keys are stored as environment variables
- Keys are never exposed in API responses
- Provider health checks don't expose sensitive information
- All external API calls include appropriate headers and timeouts

## Performance Optimization

- Lazy loading of provider services
- Caching of provider status
- Efficient model enumeration
- Connection pooling where applicable

## Future Enhancements

Planned improvements:
- Provider load balancing
- Cost optimization algorithms
- Advanced provider health monitoring
- Dynamic model discovery
- Provider-specific feature detection