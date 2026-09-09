# The Node stages run on the builder's own platform (BUILDPLATFORM): what
# they produce is JavaScript, so one `next build` serves every target and a
# multi-arch build needs no emulation for npm and Next. Only the runtime
# stage is the target platform. (The standalone output carries the builder's
# native sharp binaries; the app does not use next/image, so they are never
# loaded.)
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Docker Desktop's VM network resets under npm's default parallelism; fewer
# sockets plus retries make the install reliable everywhere.
RUN npm ci --no-audit --no-fund --maxsockets 4 --fetch-retries 5

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Standalone output inlines server deps, so the migration runner gets its own
# minimal install, isolated under /migrate.
FROM --platform=$BUILDPLATFORM node:22-alpine AS migrate-deps
WORKDIR /migrate
# A lockfile (migrate/package-lock.json) lets this be `npm ci` too: pinned
# transitive deps, and no registry metadata lookups during the build.
COPY migrate/package.json migrate/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --maxsockets 4 --fetch-retries 5

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
    TRIVY_CACHE_DIR=/var/lib/chicoree/trivy
# What this image was built from; the footer and GET /api/v1 (`build`) show
# it. The release workflow passes the tag and commit, scripts/deploy.sh the
# local checkout's.
ARG APP_VERSION=
ARG APP_COMMIT=
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /var/lib/chicoree/keys /var/lib/chicoree/trivy \
    && chown app:app /var/lib/chicoree/keys /var/lib/chicoree/trivy
# Trivy scanner backend (SCANNER=trivy): a static binary, so it runs on alpine
# as is. Its database lands in TRIVY_CACHE_DIR (mount a volume there).
COPY --from=aquasec/trivy:0.74.0 /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=migrate-deps /migrate/node_modules /migrate/node_modules
COPY --from=build /app/scripts/migrate.mjs /app/scripts/bootstrap.mjs /migrate/scripts/
COPY --from=build /app/drizzle /migrate/drizzle
USER app
EXPOSE 3000
# bootstrap: token keys + Clair database when missing (a volume-only setup
# has no bind mounts to provide them).
CMD ["sh", "-c", "node /migrate/scripts/bootstrap.mjs && node /migrate/scripts/migrate.mjs && node server.js"]
