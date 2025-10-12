# Base image
FROM node:20-alpine

# Install OpenSSL (required by Prisma)
RUN apk add --no-cache openssl

# Create app directory
WORKDIR /app

# Copy app source
COPY ./shared ./shared
COPY ./bytebot-agent/ ./bytebot-agent/

WORKDIR /app/bytebot-agent

# Install dependencies
RUN npm install

# Set Prisma to use binary engine (not WASM) for better compatibility
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x

# Generate Prisma Client with correct engine
RUN npx prisma generate

# Build the application  
RUN npm run build

# Run the application
CMD ["npm", "run", "start:prod"] 


