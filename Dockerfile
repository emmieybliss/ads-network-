# syntax=docker/dockerfile:1
# One Dockerfile, four runtime targets: api, worker, web, demo-site.
#   docker build --target api -t blissnova-api .
# The web target bakes API_INTERNAL_URL (where the web server proxies /api/v1,
# /sdk and /assets) into its routes at build time.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_DEMO_MODE=false
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_DEMO_MODE=$NEXT_PUBLIC_DEMO_MODE
RUN pnpm --filter @blissnova/ad-tag build \
 && pnpm --filter @blissnova/api build \
 && pnpm --filter @blissnova/worker build \
 && pnpm --filter @blissnova/web build
# Production-only node_modules for the bundled API and worker.
RUN pnpm --filter @blissnova/api deploy --prod --legacy /out/api \
 && pnpm --filter @blissnova/worker deploy --prod --legacy /out/worker \
 && rm -rf /out/api/dist /out/worker/dist \
 && cp -r apps/api/dist /out/api/dist \
 && cp -r apps/worker/dist /out/worker/dist

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /data/storage && chown -R node:node /data
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app
ENV PORT=4000 HOST=0.0.0.0 STORAGE_DIR=/data/storage
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker /app
CMD ["node", "dist/index.js"]

FROM runtime AS web
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone /app
COPY --from=build --chown=node:node /repo/apps/web/.next/static /app/apps/web/.next/static
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# Development-only fictional publisher page. It refuses NODE_ENV=production.
FROM node:22-bookworm-slim AS demo-site
ENV NODE_ENV=development DEMO_SITE_PORT=3100
WORKDIR /app
COPY --chown=node:node apps/demo-site /app
USER node
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3100/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
