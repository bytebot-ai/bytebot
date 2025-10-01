# Multi-Provider Support for ByteBot

Fixes #144

## 🎯 Overview

This PR implements comprehensive multi-provider support for ByteBot, allowing users to seamlessly switch between different AI providers (OpenRouter, Gemini, Anthropic, OpenAI) based on their needs, costs, and preferences.

## ✨ Features Added

### 🏗️ Core Architecture
- **BaseProvider Interface**: Unified contract for all AI providers with methods for `send()`, `stream()`, `healthCheck()`, and `getAvailableModels()`
- **Provider Manager Service**: Central service for managing provider discovery, status, and switching
- **Dynamic Provider Detection**: Automatic enable/disable based on API key configuration

### 🤖 New Provider Implementation
- **OpenRouter Service**: Complete implementation supporting multiple models through unified API
- **OpenAI-Compatible Integration**: Seamless integration with OpenRouter's API
- **Model Enumeration**: Support for various models (Claude, GPT, Llama, Mistral, etc.)

### 🔧 Enhanced Existing Providers
- **Anthropic Service**: Added BaseProvider interface implementation
- **OpenAI Service**: Enhanced with health checks and model listing
- **Google Gemini Service**: Improved with BaseProvider compliance

### 🌐 API Endpoints
New REST endpoints for provider management:
- `GET /providers` - List all providers with status
- `GET /providers/enabled` - Get only enabled providers  
- `GET /providers/models` - Get all available models
- `GET /providers/:id/models` - Get provider-specific models
- `POST /providers/:id/test` - Test provider connectivity
- `POST /providers/refresh` - Refresh provider status

### 🔑 Enhanced API Key Management
- Support for multiple provider API keys
- Secure key storage and validation
- Provider-specific key testing
- Environment variable configuration

## 🧪 Testing

- **Unit Tests**: Comprehensive test coverage for all services
- **Integration Tests**: End-to-end API endpoint testing
- **Provider-Specific Tests**: OpenRouter service validation
- **Mock Testing**: Proper mocking of external API calls

## 📁 Files Added/Modified

### New Files:
```
packages/bytebot-agent/src/
├── providers/
│   ├── base-provider.interface.ts
│   ├── provider-manager.service.ts
│   ├── providers.controller.ts
│   ├── providers.module.ts
│   └── tests/
├── openrouter/
│   ├── openrouter.service.ts
│   ├── openrouter.constants.ts
│   ├── openrouter.tools.ts
│   ├── openrouter.module.ts
│   └── tests/
├── api-keys/
│   ├── api-keys.service.ts
│   ├── api-keys.controller.ts
│   └── dto/
└── docs/multi-provider-support.md
```

### Modified Files:
- Enhanced existing provider services (Anthropic, OpenAI, Google)
- Updated agent processor and modules
- Extended type definitions

## 🚀 Usage

### Environment Configuration
```bash
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_API_KEY=your_openai_key
GEMINI_API_KEY=your_gemini_key
OPENROUTER_API_KEY=your_openrouter_key
```

### API Usage Examples
```bash
# Get available providers
curl http://localhost:3000/providers

# Get all models
curl http://localhost:3000/providers/models

# Test provider connectivity
curl -X POST http://localhost:3000/providers/openrouter/test
```

## 🎯 Benefits

- **Cost Optimization**: Switch providers based on pricing
- **Reliability**: Graceful fallback when providers are unavailable
- **Future-Proof**: Easy addition of new providers
- **Unified Interface**: Consistent API across all providers
- **Health Monitoring**: Built-in provider status monitoring

## 🔄 Backward Compatibility

- ✅ Fully backward compatible with existing installations
- ✅ No breaking changes to existing APIs
- ✅ Existing provider configurations continue to work
- ✅ Optional feature - providers work independently

## 📋 Testing Instructions

1. **Install dependencies**: `npm install`
2. **Build project**: `npm run build`
3. **Run tests**: `npm test`
4. **Test specific providers**: `npm test -- --testPathPattern="providers"`

## 📚 Documentation

Complete documentation added in `docs/multi-provider-support.md` including:
- Architecture overview
- Implementation guide
- Usage examples
- Provider addition instructions

## ✅ Issue Requirements Fulfilled

- [x] Define a base provider interface ✅
- [x] Build adapters for OpenRouter and Gemini ✅  
- [x] Make config/UI switch to select provider ✅
- [x] Add tests (unit & integration) ✅
- [x] Update documentation and usage examples ✅

## 🔍 Review Notes

- All changes follow existing code patterns and conventions
- Comprehensive error handling and logging
- Production-ready with proper TypeScript types
- Follows NestJS best practices
- Maintains security standards for API key handling

Ready for review and testing! 🚀