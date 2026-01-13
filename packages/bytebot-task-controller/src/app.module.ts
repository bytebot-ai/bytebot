/**
 * App Module
 * Root module for the Task Controller
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TerminusModule } from '@nestjs/terminus';

// Services
import { KubernetesService } from './services/kubernetes.service';
import { DatabaseService } from './services/database.service';
import { LeaderElectionService } from './services/leader-election.service';
import { ReconcilerService } from './services/reconciler.service';
import { WorkspaceGCService } from './services/workspace-gc.service';

// Guards
import { InternalAuthGuard } from './guards/internal-auth.guard';

// Controllers
import { HealthController } from './controllers/health.controller';
import { TaskController } from './controllers/task.controller';
import { WorkspaceController } from './controllers/workspace.controller';

// Modules
import { MetricsModule } from './modules/metrics.module';

@Module({
  imports: [
    // Configuration from environment
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Scheduling for reconciliation loop
    ScheduleModule.forRoot(),

    // Event emitter for leader election events
    EventEmitterModule.forRoot(),

    // Health checks
    TerminusModule,

    // Metrics
    MetricsModule,
  ],
  controllers: [HealthController, TaskController, WorkspaceController],
  providers: [
    KubernetesService,
    DatabaseService,
    LeaderElectionService,
    ReconcilerService,
    WorkspaceGCService,
    InternalAuthGuard,
  ],
})
export class AppModule {}
