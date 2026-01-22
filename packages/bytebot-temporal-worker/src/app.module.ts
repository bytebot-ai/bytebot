/**
 * Butler Vantage Temporal Worker - NestJS Application Module
 *
 * This module sets up the NestJS application for:
 * - Health check endpoints (liveness, readiness)
 * - Prometheus metrics (Phase 10.1: Enhanced Observability)
 * - Configuration management
 *
 * The actual Temporal worker runs separately via worker.ts
 *
 * Phase 10.1 Enhancements:
 * - Custom business metrics for workflows, steps, activities
 * - LLM call tracking and latency histograms
 * - Human-in-the-loop event metrics
 * - Error classification and tracking
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Health checks
    TerminusModule,

    // Phase 10.1: Enhanced Prometheus metrics with custom business metrics
    MetricsModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
