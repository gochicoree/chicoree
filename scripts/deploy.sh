#!/usr/bin/env sh
# Deploy the production stack (docker-compose.prod.yml) to a single host over
# SSH: syncs this checkout, writes .env with fresh secrets on first run,
# installs Docker if missing, and runs `docker compose up -d --build`.
#
#   scripts/deploy.sh user@host [domain] [acme-email]
#   NO_CLAIR=1 scripts/deploy.sh ...   # first run without vulnerability scanning
#
# Re-runs are idempotent: .env on the server is never overwritten.
set -eu

TARGET="${1:?usage: scripts/deploy.sh user@host [domain] [acme-email]}"
DOMAIN="${2:-}"
ACME_EMAIL="${3:-}"
REMOTE_DIR="${REMOTE_DIR:-chicoree}"

cd "$(dirname "$0")/.."

# The footer and GET /api/v1 show what the web app was built from: the tag
# when this checkout sits exactly on one, and the short commit (with -dirty
# when uncommitted changes are deployed).
APP_VERSION="$(git describe --tags --exact-match 2>/dev/null || true)"
APP_COMMIT="$(git rev-parse --short=7 HEAD 2>/dev/null || true)"
if [ -n "$APP_COMMIT" ] && ! git diff --quiet HEAD -- 2>/dev/null; then APP_COMMIT="$APP_COMMIT-dirty"; fi

echo "==> syncing to $TARGET:$REMOTE_DIR"
rsync -az --delete \
  --exclude .git --exclude .claude --exclude node_modules --exclude .next --exclude secrets \
  --exclude .env --exclude '*.log' --exclude .DS_Store \
  ./ "$TARGET:$REMOTE_DIR/"

ssh "$TARGET" REMOTE_DIR="$REMOTE_DIR" DOMAIN="$DOMAIN" ACME_EMAIL="$ACME_EMAIL" NO_CLAIR="${NO_CLAIR:-}" APP_VERSION="$APP_VERSION" APP_COMMIT="$APP_COMMIT" 'sh -s' <<'REMOTE'
set -eu
cd "$REMOTE_DIR"
export APP_VERSION APP_COMMIT

if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker info >/dev/null 2>&1; then
  echo "cannot talk to the Docker daemon as $(id -un); use root or add the user to the docker group" >&2
  exit 1
fi

if [ ! -f .env ]; then
  : "${DOMAIN:?first deploy needs: scripts/deploy.sh user@host <domain> <acme-email>}"
  : "${ACME_EMAIL:?first deploy needs: scripts/deploy.sh user@host <domain> <acme-email>}"
  rand() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c "$1"; }
  echo "==> writing .env for $DOMAIN"
  sed \
    -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
    -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$ACME_EMAIL|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 32)|" \
    -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(rand 48)|" \
    -e "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(rand 48)|" \
    -e "s|^JOBS_API_TOKEN=.*|JOBS_API_TOKEN=$(rand 48)|" \
    -e "s|^SCAN_WORKER_TOKEN=.*|SCAN_WORKER_TOKEN=$(rand 48)|" \
    .env.prod.example > .env
  if [ -n "$NO_CLAIR" ]; then
    sed -i -e 's|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=|' -e 's|^CLAIR_URL=.*|CLAIR_URL=|' .env
  fi
  chmod 600 .env
fi
# On re-runs these arrive empty and would shadow the values in .env.
[ -n "$DOMAIN" ] || unset DOMAIN
[ -n "$ACME_EMAIL" ] || unset ACME_EMAIL

echo "==> building and starting${APP_VERSION:+ $APP_VERSION}${APP_COMMIT:+ ($APP_COMMIT)}"
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -f docker-compose.prod.yml ps
# Every build leaves layers behind; keep a little cache, drop the rest.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --keep-storage 2G >/dev/null 2>&1 || true
echo "==> disk: $(df -h / | awk 'NR==2 {print $4 " free of " $2 " (" $5 " used)"}')"
REMOTE

echo "==> done: https://${DOMAIN:-<domain>}"
