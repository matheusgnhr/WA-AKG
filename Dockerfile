FROM node:24.21.0-alpine AS builder
RUN apk add --no-cache openssl ca-certificates
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --ignore-scripts
COPY . .
RUN node node_modules/prisma/build/index.js generate && npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.21.0-alpine AS runner
RUN apk add --no-cache openssl ca-certificates ffmpeg
WORKDIR /app
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/tsconfig.json ./
COPY --from=builder --chown=node:node /app/next.config.ts ./
RUN mkdir -p data/media uploads .next/cache && chown -R node:node data uploads .next/cache
USER node
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 ENABLE_TELEMETRY=false
EXPOSE 3000
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/server/index.ts"]
