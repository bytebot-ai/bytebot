# ByteBot Temporal Worker - Production Dockerfile
#
# Multi-stage build for minimal image size and security.
# Based on Node.js 20 LTS with glibc (required by Temporal SDK).
#
# NOTE: Temporal SDK requires glibc - cannot use Alpine (musl) base image.

# ============================================================================
# Stage 1: Builder
# ============================================================================

FROM node:20-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY nest-cli.json ./

# Install dependencies
RUN npm ci --only=production=false

# Copy source code
COPY src/ ./src/

# Build application
RUN npm run build

# ============================================================================
# Stage 2: Production Dependencies
# ============================================================================

FROM node:20-slim AS deps

WORKDIR /app

COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# ============================================================================
# Stage 3: Production Runtime
# ============================================================================

FROM node:20-slim AS runtime

# Install curl for health checks (must be done before USER switch)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Security: Run as non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -m bytebot

WORKDIR /app

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R bytebot:nodejs /app

# Switch to non-root user
USER bytebot

# Environment defaults
ENV NODE_ENV=production
ENV HTTP_PORT=3000
ENV TEMPORAL_ADDRESS=temporal-frontend.temporal.svc.cluster.local:7233
ENV TEMPORAL_NAMESPACE=bytebot
ENV TEMPORAL_TASK_QUEUE=bytebot-goal-runs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:${HTTP_PORT}/health/live || exit 1

# Expose ports
EXPOSE 3000
EXPOSE 9464

# Start command - runs both HTTP server and Temporal worker
CMD ["node", "dist/worker.js"]
