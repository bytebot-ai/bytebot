# ByteBot Workflow Orchestrator

Multi-step workflow orchestration service with persistent workspaces, approval flows, and audit logging.

## Overview

The Workflow Orchestrator is a NestJS application that manages complex, multi-step workflow executions with:

- **Persistent Workspaces**: Workflows execute in persistent desktop environments that maintain state across steps
- **Node-based Execution**: Workflows consist of nodes (TASK, DECISION, PARALLEL, WAIT) with dependency tracking
- **High-Risk Approval Flow** (M5): Human-in-the-loop approval for sensitive operations
- **Idempotency Guarantees** (M5): Exactly-once execution semantics for high-risk actions
- **Webhook Notifications** (Post-M5): Real-time notifications for approval events
- **Audit Logging** (Post-M5): Immutable compliance audit trail for all approval actions
- **Prometheus Metrics** (Post-M5): Comprehensive observability for approval flows

## Architecture

```
┌─────────────────┐     ┌─────────────────────────┐     ┌──────────────────┐
│   bytebot-api   │────▶│  workflow-orchestrator  │────▶│ task-controller  │
└─────────────────┘     └─────────────────────────┘     └──────────────────┘
                                    │                           │
                                    ▼                           ▼
                        ┌─────────────────────┐     ┌──────────────────┐
                        │     PostgreSQL      │     │  Desktop Pods    │
                        └─────────────────────┘     └──────────────────┘
```

## API Endpoints

### Workflows
- `POST /api/v1/workflows` - Create a new workflow
- `GET /api/v1/workflows/:id` - Get workflow status
- `POST /api/v1/workflows/:id/start` - Start workflow execution
- `POST /api/v1/workflows/:id/cancel` - Cancel workflow

### Workspaces
- `GET /api/v1/workspaces/:id/status` - Get workspace status
- `POST /api/v1/workspaces/:id/lock` - Acquire workspace lock
- `DELETE /api/v1/workspaces/:id/lock` - Release workspace lock

### Approvals (M5)
- `POST /api/v1/approvals/request` - Request approval for high-risk action
- `GET /api/v1/approvals` - List pending approvals
- `GET /api/v1/approvals/:id` - Get approval details
- `POST /api/v1/approvals/:id/approve` - Approve request
- `POST /api/v1/approvals/:id/reject` - Reject request
- `GET /api/v1/approvals/stats` - Get approval statistics

### Webhooks (Post-M5)
- `GET /api/v1/webhooks` - List webhook configurations
- `POST /api/v1/webhooks` - Create webhook
- `PUT /api/v1/webhooks/:id` - Update webhook
- `DELETE /api/v1/webhooks/:id` - Delete webhook
- `POST /api/v1/webhooks/:id/test` - Test webhook
- `POST /api/v1/webhooks/:id/rotate-secret` - Rotate webhook secret

### Audit (Post-M5)
- `GET /api/v1/audit` - Query audit logs
- `GET /api/v1/audit/approvals/:id` - Get audit trail for approval
- `GET /api/v1/audit/export` - Export audit logs
- `GET /api/v1/audit/stats` - Get audit statistics

### Health & Metrics
- `GET /api/v1/health/live` - Liveness probe
- `GET /api/v1/health/ready` - Readiness probe
- `GET /api/v1/metrics` - Prometheus metrics

## Database Schema

The service uses Prisma ORM with PostgreSQL. Key entities:

- `Workspace` - Persistent workspace environments
- `WorkflowRun` - Workflow execution instances
- `WorkflowNode` - Workflow step definitions with runtime state
- `WorkflowNodeRun` - Individual node execution attempts
- `ApprovalRequest` - High-risk action approval requests
- `IdempotencyRecord` - Exactly-once execution tracking
- `WebhookConfig` - Webhook endpoint configurations
- `WebhookDelivery` - Webhook delivery records
- `AuditLog` - Immutable compliance audit trail

## Deployment

### Prerequisites

1. PostgreSQL database with a `bytebotdb` database
2. Kubernetes cluster with the `bytebot` namespace
3. Helm 3.x

### Database Migration

Before first deployment, run Prisma migrations:

```bash
# Connect to the database and run migrations
kubectl run -it --rm prisma-migrate \
  --image=jbutler1980/bytebot-workflow-orchestrator:1.0.0 \
  --namespace=bytebot \
  --env="DATABASE_URL=postgresql://..." \
  -- npx prisma migrate deploy
```

### Helm Deployment

```bash
# Deploy to Kubernetes
helm upgrade --install bytebot-workflow-orchestrator \
  ./kubernetes/helm/charts/bytebot-workflow-orchestrator \
  -f ./kubernetes/helm/charts/bytebot-workflow-orchestrator/values-production.yaml \
  --namespace bytebot \
  --kube-context=agent
```

### Configuration

Key environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `TASK_CONTROLLER_URL` | Task controller service URL | `http://bytebot-task-controller:8080` |
| `SCHEDULER_ENABLED` | Enable workflow scheduler | `true` |
| `SCHEDULER_BATCH_SIZE` | Nodes to process per batch | `10` |
| `HIGH_RISK_APPROVAL_EXPIRY_MINUTES` | Approval request timeout | `60` |
| `IDEMPOTENCY_TTL_HOURS` | Idempotency record retention | `24` |
| `WEBHOOK_TIMEOUT_MS` | Webhook delivery timeout | `30000` |
| `AUDIT_LOG_RETENTION_DAYS` | Audit log retention period | `90` |

## Docker

### Build

```bash
docker build -t jbutler1980/bytebot-workflow-orchestrator:1.0.0 .
```

### Push

```bash
docker push jbutler1980/bytebot-workflow-orchestrator:1.0.0
```

## Development

### Local Setup

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Run in development mode
npm run start:dev
```

### Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Coverage
npm run test:cov
```

## Metrics

Prometheus metrics available at `/api/v1/metrics`:

- `approvals_total` - Total approval requests by status
- `approvals_pending` - Current pending approvals
- `approval_latency_seconds` - Approval decision latency
- `webhooks_total` - Total webhook deliveries
- `webhook_delivery_seconds` - Webhook delivery latency
- `audit_logs_total` - Total audit log entries
- `idempotency_checks_total` - Idempotency check counts

## Version History

- **v1.0.0** (2025-12-13): Initial release with M5 approval flows and Post-M5 enhancements
