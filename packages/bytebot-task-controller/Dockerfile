# ByteBot Task Controller Dockerfile
# Phase 6.2: Pod-Per-Task Desktop Isolation

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./

# Install dependencies
RUN npm ci

# Copy prisma schema from bytebot-agent
COPY prisma ./prisma/

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY src ./src/

# Build
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy built application
COPY --from=builder /app/dist ./dist

# Set ownership to existing 'node' user (uid 1000 in Alpine)
RUN chown -R node:node /app

# Switch to non-root user (existing 'node' user in Alpine)
USER node

# Environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose ports
EXPOSE 8080 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1

# Start application
CMD ["node", "dist/main.js"]
