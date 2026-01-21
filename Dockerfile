# Dockerfile for Zight Automation Webhook Server
# Optimized for Coolify deployment with Playwright support

FROM node:20-slim

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev for playwright)
RUN npm ci

# Install Playwright browsers (Chromium only)
RUN npx playwright install chromium --with-deps

# Copy application files
COPY . .

# Create logs directory
RUN mkdir -p /app/logs /app/screenshots

# Expose webhook port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start webhook server
CMD ["npm", "run", "webhook"]
