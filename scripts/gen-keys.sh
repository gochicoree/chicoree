#!/usr/bin/env sh
# Generates everything the stack needs to start:
#   - secrets/registry-token.key  ES256 private key (web app signs tokens)
#   - secrets/registry-token.pub  matching public key (registryd verifies)
#   - .env                        from .env.example, with fresh random secrets
# Idempotent: existing keys and .env are left untouched.
set -eu

cd "$(dirname "$0")/.."
mkdir -p secrets

if [ ! -f secrets/registry-token.key ]; then
  openssl ecparam -name prime256v1 -genkey -noout \
    | openssl pkcs8 -topk8 -nocrypt -out secrets/registry-token.key
  chmod 600 secrets/registry-token.key
  echo "wrote secrets/registry-token.key"
fi

if [ ! -f secrets/registry-token.pub ]; then
  openssl ec -in secrets/registry-token.key -pubout -out secrets/registry-token.pub 2>/dev/null
  echo "wrote secrets/registry-token.pub"
fi

if [ ! -f .env ]; then
  AUTH_SECRET="$(openssl rand -base64 32 | tr -d '\n')"
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  JOBS_API_TOKEN="$(openssl rand -hex 32)"
  sed \
    -e "s|^AUTH_SECRET=.*|AUTH_SECRET=${AUTH_SECRET}|" \
    -e "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=${WEBHOOK_SECRET}|" \
    -e "s|^JOBS_API_TOKEN=.*|JOBS_API_TOKEN=${JOBS_API_TOKEN}|" \
    .env.example > .env
  echo "wrote .env with fresh secrets"
fi

echo "done — run: docker compose up --build"
