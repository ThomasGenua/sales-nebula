# ─── BUILD STAGE ───
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# Copy source
COPY . .
RUN npm run prisma:generate

# Build the single page app. Without this the image ships React source
# that nothing compiles, so the public site does not exist in production.
RUN cd frontend \
 && npm ci --no-audit --no-fund \
 && npm run build

# ─── PRODUCTION STAGE ───
FROM node:20-alpine AS production

RUN apk add --no-cache openssl

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/.env.example ./.env.example

# Create uploads directory
RUN mkdir -p uploads && chown -R node:node /app

USER node

EXPOSE 7544

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:7544/api/health || exit 1

CMD ["node", "src/index.js"]
