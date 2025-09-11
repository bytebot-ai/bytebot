# Base image
FROM node:20-bookworm-slim

# Create app directory
WORKDIR /app

# Copy app source
COPY ./shared ./shared
COPY ./bytebot-agent/ ./bytebot-agent/

WORKDIR /app/bytebot-agent

# Install required system deps for Prisma on Debian/Ubuntu
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Ensure Prisma uses the Node-API (library) engine, not WASM
ENV PRISMA_CLIENT_ENGINE_TYPE=library
ENV PRISMA_CLI_QUERY_ENGINE_TYPE=library

# Install dependencies
RUN npm install


RUN npm run build

# Run the application
CMD ["npm", "run", "start:prod"] 


