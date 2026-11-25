# One image definition, two targets: "worker" and "web".
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# The optional "ca" secret is only used when building behind a TLS-inspecting proxy.
RUN --mount=type=secret,id=ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/ca corepack enable && \
    NODE_EXTRA_CA_CERTS=/run/secrets/ca corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Install dependencies (cached unless package files change).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=$( [ -f /run/secrets/ca ] && echo /run/secrets/ca ) \
    pnpm install --frozen-lockfile

# Worker: runs TypeScript directly with tsx (no build step).
FROM deps AS worker
# Chromium for Lighthouse audits (Debian package, no Google account or key needed).
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
COPY packages packages
COPY apps/worker apps/worker
# Pre-install DuckDB's httpfs extension (reads Common Crawl Parquet over HTTPS).
RUN --mount=type=secret,id=ca,required=false \
    cd apps/worker && SSL_CERT_FILE=$( [ -f /run/secrets/ca ] && echo /run/secrets/ca || echo /etc/ssl/certs/ca-certificates.crt ) \
    node -e "require('@duckdb/node-api').DuckDBInstance.create(':memory:').then(i=>i.connect()).then(c=>c.run('INSTALL httpfs')).then(()=>console.log('httpfs installed'))" \
    || echo "httpfs will be installed on first use"
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@lead/worker", "start"]

# Web: build Next.js, then run the small standalone server.
FROM deps AS web-build
COPY apps/web apps/web
RUN pnpm --filter @lead/web build

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
