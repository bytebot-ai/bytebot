import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

type LlmFailoverEvent = {
  endpoint: string;
  requestedModel: string;
  usedModel: string;
};

type LlmCircuitStateChangedEvent = {
  endpoint: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
};

type LlmEndpointFailoverEvent = {
  fromEndpoint: string;
  toEndpoint: string;
  reason: string;
  requestedModel: string;
};

type LlmEndpointCallEvent = {
  endpoint: string;
  requestedModel: string;
  durationMs: number;
};

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly registry = new Registry();

  private readonly llmFailoverTotal = new Counter({
    name: 'bytebot_llm_failover_total',
    help: 'Total LLM failovers (requested_model != used_model)',
    labelNames: ['endpoint', 'requested_model', 'used_model'] as const,
    registers: [this.registry],
  });

  private readonly llmCircuitOpenedTotal = new Counter({
    name: 'bytebot_llm_circuit_opened_total',
    help: 'Total LLM circuit breaker openings',
    labelNames: ['endpoint'] as const,
    registers: [this.registry],
  });

  private readonly llmCircuitOpen = new Gauge({
    name: 'bytebot_llm_circuit_open',
    help: 'LLM circuit breaker open state (1=open, 0=closed)',
    labelNames: ['endpoint'] as const,
    registers: [this.registry],
  });

  private readonly llmEndpointFailoverTotal = new Counter({
    name: 'bytebot_llm_endpoint_failover_total',
    help: 'Total endpoint-level failovers (primary endpoint -> fallback endpoint)',
    labelNames: ['from_endpoint', 'to_endpoint', 'reason', 'requested_model'] as const,
    registers: [this.registry],
  });

  private readonly llmEndpointCallDurationSeconds = new Histogram({
    name: 'bytebot_llm_endpoint_call_duration_seconds',
    help: 'LLM call duration by endpoint (seconds)',
    labelNames: ['endpoint', 'requested_model'] as const,
    buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    registers: [this.registry],
  });

  private readonly desktopKeydownRewrittenTotal = new Counter({
    name: 'bytebot_desktop_keydown_rewritten_total',
    help: 'Total illegal key-down requests rewritten into safe taps',
    labelNames: ['key', 'reason'] as const,
    registers: [this.registry],
  });

  private readonly desktopInterruptsTotal = new Counter({
    name: 'bytebot_desktop_interrupts_total',
    help: 'Total desktop automation interrupts raised for safety',
    labelNames: ['reason_code'] as const,
    registers: [this.registry],
  });

  private readonly desktopLoopDetectedTotal = new Counter({
    name: 'bytebot_desktop_loop_detected_total',
    help: 'Total desktop loop detections (no progress)',
    labelNames: ['rule'] as const,
    registers: [this.registry],
  });

  private readonly desktopForcedScreenshotTotal = new Counter({
    name: 'bytebot_desktop_forced_screenshot_total',
    help: 'Total forced desktop screenshots injected to enforce observation',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async getMetrics(): Promise<string> {
    return await this.registry.metrics();
  }

  @OnEvent('llm.failover')
  onLlmFailover(event: LlmFailoverEvent): void {
    this.llmFailoverTotal.inc({
      endpoint: event.endpoint,
      requested_model: event.requestedModel,
      used_model: event.usedModel,
    });
  }

  @OnEvent('llm.circuit.opened')
  onCircuitOpened(event: { endpoint: string }): void {
    this.llmCircuitOpenedTotal.inc({ endpoint: event.endpoint });
    this.llmCircuitOpen.set({ endpoint: event.endpoint }, 1);
  }

  @OnEvent('llm.circuit.state-changed')
  onCircuitStateChanged(event: LlmCircuitStateChangedEvent): void {
    this.llmCircuitOpen.set({ endpoint: event.endpoint }, event.state === 'OPEN' ? 1 : 0);
    this.logger.debug(`Circuit state changed for ${event.endpoint}: ${event.state}`);
  }

  @OnEvent('llm.endpoint.failover')
  onEndpointFailover(event: LlmEndpointFailoverEvent): void {
    this.llmEndpointFailoverTotal.inc({
      from_endpoint: event.fromEndpoint,
      to_endpoint: event.toEndpoint,
      reason: event.reason,
      requested_model: event.requestedModel,
    });
  }

  @OnEvent('llm.endpoint.call')
  onEndpointCall(event: LlmEndpointCallEvent): void {
    this.llmEndpointCallDurationSeconds.observe(
      { endpoint: event.endpoint, requested_model: event.requestedModel },
      event.durationMs / 1000,
    );
  }

  @OnEvent('desktop.keydown.rewritten')
  onDesktopKeydownRewritten(event: { key: string; reason: string }): void {
    this.desktopKeydownRewrittenTotal.inc({ key: event.key, reason: event.reason });
  }

  @OnEvent('desktop.interrupt')
  onDesktopInterrupt(event: { reasonCode: string }): void {
    this.desktopInterruptsTotal.inc({ reason_code: event.reasonCode });
  }

  @OnEvent('desktop.loop.detected')
  onDesktopLoopDetected(event: { rule: string }): void {
    this.desktopLoopDetectedTotal.inc({ rule: event.rule });
  }

  @OnEvent('desktop.forced_screenshot')
  onDesktopForcedScreenshot(event: { reason: string }): void {
    this.desktopForcedScreenshotTotal.inc({ reason: event.reason });
  }
}
