/**
 * ByteBot Workflow Orchestrator
 * v5.2.0: Phase 7 Enhanced Features with Swagger API Documentation
 *
 * This service is the brain of the ByteBot Workflows product (Product 2).
 * It manages:
 * - Workflow lifecycle (create, execute, complete, fail)
 * - Node scheduling using DB-driven FOR UPDATE SKIP LOCKED pattern
 * - Workspace lifecycle coordination with task-controller
 * - Agent task dispatch and result collection
 * - Goal-first orchestration (Manus-style)
 * - Goal templates and batch execution (Phase 7)
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Enable validation pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Enable CORS for internal services
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true,
  });

  // Set global prefix
  app.setGlobalPrefix('api/v1');

  // Configure Swagger API Documentation
  const config = new DocumentBuilder()
    .setTitle('ByteBot Workflow Orchestrator API')
    .setDescription(
      `
## Overview

The ByteBot Workflow Orchestrator API provides goal-first workflow orchestration capabilities.
Users can define natural language goals, and the system will autonomously plan and execute
workflows to achieve those goals.

## Key Features

- **Goal Runs**: Create and manage goal-based workflow executions
- **Templates**: Reusable goal templates with parameterization
- **Batch Execution**: Execute multiple goals in parallel or sequence
- **Analytics**: Comprehensive execution insights and metrics
- **Approvals**: Human-in-the-loop approval for high-risk actions

## Authentication

All API endpoints require tenant identification via the \`x-tenant-id\` header.
Some endpoints may require additional authentication headers.

## Rate Limiting

The API implements rate limiting:
- **Goal Creation**: 5 requests per minute
- **Batch Creation**: 3 requests per minute
- **General**: 100 requests per minute

## Error Responses

All errors follow a standard format:
\`\`\`json
{
  "statusCode": 400,
  "message": "Error description",
  "error": "Bad Request"
}
\`\`\`
      `,
    )
    .setVersion('5.2.0')
    .addTag('goal-runs', 'Goal-first workflow orchestration')
    .addTag('templates', 'Reusable goal templates')
    .addTag('batches', 'Batch goal execution')
    .addTag('analytics', 'Execution analytics and insights')
    .addTag('approvals', 'High-risk action approvals')
    .addTag('workflows', 'Low-level workflow management')
    .addTag('agents', 'Multi-agent orchestration')
    .addTag('webhooks', 'Webhook notifications')
    .addTag('health', 'Health checks')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-tenant-id',
        in: 'header',
        description: 'Tenant identifier',
      },
      'x-tenant-id',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-user-id',
        in: 'header',
        description: 'User identifier (optional)',
      },
      'x-user-id',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'ByteBot Orchestrator API',
    customfavIcon: '/favicon.ico',
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  const port = process.env.PORT || 8080;
  await app.listen(port);

  logger.log(`Workflow Orchestrator listening on port ${port}`);
  logger.log(`Health check: http://localhost:${port}/api/v1/health`);
  logger.log(`API Documentation: http://localhost:${port}/docs`);
}

bootstrap();
