# ─── BUILD STAGE ───
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY scripts/generate-sqlite-schema.js ./scripts/generate-sqlite-schema.js
RUN npm ci --include=dev

# Copy source
COPY . .

# Build the single page app. Without this the image ships React source
# that nothing compiles, so the public site does not exist in production.
RUN cd frontend \
 && npm ci --no-audit --no-fund \
 && npm run build

# ─── PRODUCTION STAGE ───
FROM node:20-alpine AS production

RUN apk add --no-cache openssl postgresql16-client

WORKDIR /app

# Copy from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/frontend/dist ./frontend/dist
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/.env.example ./.env.example

# Create uploads directory
RUN mkdir -p uploads backups && chown node:node /app uploads backups

USER node

EXPOSE 7544

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:7544/api/health || exit 1

CMD ["node", "src/index.js"]
ENTRYPOINT ["node", "scripts/docker-entrypoint.js"]
