# syntax=docker/dockerfile:1
# Journey chat server. Two targets:
#   docker build -t journey-chat .                     -> the app (default)
#   docker build -t journey-chat-migrate --target migrate .  -> run once per deploy: prisma migrate deploy
FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

FROM build AS prod-deps
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
USER node
EXPOSE 4000
# Heap cap leaves headroom in a 2 GB container; ~10k sockets use ~300 MB of heap (see docs/DEPLOYMENT.md).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--max-old-space-size=1536", "--enable-source-maps", "dist/index.js"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
