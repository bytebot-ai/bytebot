import { LLMResilienceService, LLMErrorType } from './llm-resilience.service';

describe('LLMResilienceService', () => {
  const makeService = (overrides: Record<string, string> = {}) => {
    const configService = {
      get: jest.fn((key: string, fallback: string) => {
        const map: Record<string, string> = {
          LLM_MAX_RETRIES: '5',
          LLM_BASE_DELAY_MS: '1',
          LLM_MAX_DELAY_MS: '10',
          LLM_JITTER_FACTOR: '0',
          LLM_CIRCUIT_BREAKER_THRESHOLD: '2',
          LLM_CIRCUIT_BREAKER_RESET_MS: '60000',
          ...overrides,
        };
        return map[key] ?? fallback;
      }),
    } as any;

    const eventEmitter = {
      emit: jest.fn(),
    } as any;

    const service = new LLMResilienceService(configService, eventEmitter);
    return { service, configService, eventEmitter };
  };

  it('opens circuit breaker after threshold and fails fast', async () => {
    const { service } = makeService({ LLM_CIRCUIT_BREAKER_THRESHOLD: '2' });

    const operation = jest.fn(async () => {
      const error = new Error('connect ECONNREFUSED 10.0.0.1:4000');
      (error as any).code = 'ECONNREFUSED';
      throw error;
    });

    const r1 = await service.executeWithRetry(operation, 'litellm', { maxRetries: 0 });
    expect(r1.success).toBe(false);
    expect(r1.attempts).toBe(1);
    expect(service.getCircuitBreakerStatus('litellm')?.state).toBe('CLOSED');

    const r2 = await service.executeWithRetry(operation, 'litellm', { maxRetries: 0 });
    expect(r2.success).toBe(false);
    expect(r2.attempts).toBe(1);
    expect(service.getCircuitBreakerStatus('litellm')?.state).toBe('OPEN');

    const r3 = await service.executeWithRetry(operation, 'litellm', { maxRetries: 0 });
    expect(r3.success).toBe(false);
    expect(r3.attempts).toBe(0);
    expect(r3.error?.message).toMatch(/Circuit breaker open/i);

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('treats auth errors as non-retryable', async () => {
    const { service } = makeService();

    const operation = jest.fn(async () => {
      const error = new Error('401 Unauthorized');
      (error as any).status = 401;
      throw error;
    });

    const result = await service.executeWithRetry(operation, 'litellm', { maxRetries: 5 });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error?.type).toBe(LLMErrorType.AUTH_ERROR);
    expect(result.error?.retryable).toBe(false);
  });

  it('can be manually tripped open for fast failover', async () => {
    const { service } = makeService({ LLM_CIRCUIT_BREAKER_THRESHOLD: '5' });

    service.openCircuit('litellm', {
      type: LLMErrorType.NETWORK,
      message: 'connect ECONNREFUSED 10.0.0.1:4000',
      retryable: true,
    });

    expect(service.getCircuitBreakerStatus('litellm')?.state).toBe('OPEN');

    const operation = jest.fn(async () => {
      throw new Error('should not be called');
    });

    const result = await service.executeWithRetry(operation, 'litellm', { maxRetries: 0 });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });
});
