# Base image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy app source from repository root
# Note: Build context is the repository root for Railway
COPY packages/shared ./shared
COPY packages/bytebot-agent ./bytebot-agent

WORKDIR /app/bytebot-agent

# Install dependencies
RUN npm install

RUN npm run build

# Run the application
CMD ["npm", "run", "start:prod"] 


