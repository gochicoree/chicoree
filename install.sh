#!/bin/sh
# Chicorée installer — one command from a fresh Linux host to a running registry.
#
#   curl -fsSL https://raw.githubusercontent.com/gochicoree/chicoree/main/install.sh | sudo sh
#
# Asks a few questions (or reads them from CHICOREE_* variables — see below),
# installs git and Docker when missing, clones the repository, writes .env
# with fresh secrets, starts the stack and creates the first administrator.
# Re-running it on the same host updates the checkout and restarts the stack;
# .env and data are kept.
#
# Non-interactive use: export the answers and run with CHICOREE_YES=1.
#   CHICOREE_MODE=public|local        public = HTTPS via Traefik + Let's Encrypt (needs a domain)
#   CHICOREE_DOMAIN, CHICOREE_ACME_EMAIL
#   CHICOREE_DIR=/opt/chicoree        install directory
#   CHICOREE_SCANNER=trivy|clair|none
#   CHICOREE_DATA_DIR=                image layers directory (empty = docker volume)
#   CHICOREE_SMTP_HOST, CHICOREE_SMTP_PORT, CHICOREE_SMTP_USER, CHICOREE_SMTP_PASS, CHICOREE_SMTP_FROM
#   CHICOREE_ADMIN_EMAIL, CHICOREE_ADMIN_PASSWORD
#   CHICOREE_SIGNUP=closed|invite|open
#   CHICOREE_REPO, CHICOREE_REF       source to clone (default github.com/gochicoree/chicoree, main)
#   CHICOREE_REGISTRY_PORT            local mode only: host port for the docker API (default 5000)
set -eu

REPO_DEFAULT="https://github.com/gochicoree/chicoree.git"
REF_DEFAULT="main"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- questions --------------------------------------------------------------------

TTY=/dev/tty
if [ -n "${CHICOREE_YES:-}" ]; then INTERACTIVE=0; elif [ -r $TTY ] && [ -w $TTY ]; then INTERACTIVE=1; else INTERACTIVE=0; fi

# ask VAR "prompt" "default"  — reads from the terminal even when stdin is the curl pipe.
ask() {
  var=$1; prompt=$2; default=${3:-}
  eval "current=\${$var:-}"
  if [ -n "$current" ]; then return; fi
  if [ $INTERACTIVE -eq 0 ]; then
    [ -n "$default" ] || die "$var is required (set CHICOREE_${var#CH_} or run interactively)"
    eval "$var=\$default"; return
  fi
  if [ -n "$default" ]; then printf '%s [%s]: ' "$prompt" "$default" > $TTY; else printf '%s: ' "$prompt" > $TTY; fi
  read -r answer < $TTY || answer=""
  [ -n "$answer" ] || answer=$default
  eval "$var=\$answer"
}

# ask_secret VAR "prompt" — no echo; empty means "generate one".
ask_secret() {
  var=$1; prompt=$2
  eval "current=\${$var:-}"
  if [ -n "$current" ] || [ $INTERACTIVE -eq 0 ]; then return; fi
  printf '%s (empty = generate): ' "$prompt" > $TTY
  stty -echo < $TTY 2>/dev/null || true
  read -r answer < $TTY || answer=""
  stty echo < $TTY 2>/dev/null || true
  printf '\n' > $TTY
  eval "$var=\$answer"
}

rand() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c "$1"; }

bold "Chicorée — self-hosted OCI registry"
echo
[ -n "${CHICOREE_DRY_RUN:-}" ] || [ "$(uname -s)" = Linux ] || die "this installer targets Linux hosts (from a workstation use scripts/deploy.sh)"
if [ -z "${CHICOREE_DRY_RUN:-}" ] && [ "$(id -u)" -ne 0 ]; then
  die "run it as root:   curl -fsSL https://raw.githubusercontent.com/gochicoree/chicoree/main/install.sh | sudo sh"
fi

CH_MODE=${CHICOREE_MODE:-}
if [ -z "$CH_MODE" ] && [ $INTERACTIVE -eq 1 ]; then
  cat > $TTY <<EOF
How should the registry be reached?
  1) public   HTTPS with automatic Let's Encrypt certificates (needs a DNS name pointing here, ports 80/443 open)
  2) local    plain HTTP on this machine's ports 3000 (web) and 5000 (docker) — for a LAN or testing
EOF
  ask CH_MODE_CHOICE "Choice" "1"
  case "$CH_MODE_CHOICE" in 2) CH_MODE=local;; *) CH_MODE=public;; esac
fi
CH_MODE=${CH_MODE:-public}
case "$CH_MODE" in public|local) ;; *) die "CHICOREE_MODE must be public or local";; esac

if [ "$CH_MODE" = public ]; then
  CH_DOMAIN=${CHICOREE_DOMAIN:-}; ask CH_DOMAIN "Domain name (e.g. registry.example.com)"
  CH_ACME_EMAIL=${CHICOREE_ACME_EMAIL:-}; ask CH_ACME_EMAIL "Email for Let's Encrypt notices"
  case "$CH_DOMAIN" in *://*|*/*|"") die "enter a bare host name, without scheme or path";; esac
else
  CH_DOMAIN=${CHICOREE_DOMAIN:-}; ask CH_DOMAIN "Host name or IP clients will use" "$(hostname -f 2>/dev/null || hostname)"
  CH_REGISTRY_PORT=${CHICOREE_REGISTRY_PORT:-}; ask CH_REGISTRY_PORT "Host port for the docker API" "5000"
fi

CH_DIR=${CHICOREE_DIR:-}; ask CH_DIR "Install directory" "/opt/chicoree"

CH_SCANNER=${CHICOREE_SCANNER:-}
if [ -z "$CH_SCANNER" ] && [ $INTERACTIVE -eq 1 ]; then
  cat > $TTY <<EOF
Vulnerability scanning:
  1) trivy    bundled, light (a few hundred MB of RAM), no extra service   [recommended]
  2) clair    Clair v4 with its own database (several GB of advisory data, ~4 GB RAM)
  3) none
EOF
  ask CH_SCANNER_CHOICE "Choice" "1"
  case "$CH_SCANNER_CHOICE" in 2) CH_SCANNER=clair;; 3) CH_SCANNER=none;; *) CH_SCANNER=trivy;; esac
fi
CH_SCANNER=${CH_SCANNER:-trivy}
case "$CH_SCANNER" in trivy|clair|none) ;; *) die "CHICOREE_SCANNER must be trivy, clair or none";; esac

CH_DATA_DIR=${CHICOREE_DATA_DIR:-}
if [ $INTERACTIVE -eq 1 ] && [ -z "$CH_DATA_DIR" ]; then
  ask CH_DATA_DIR_IN "Directory for image layers (empty = a docker volume on this disk)" ""
  CH_DATA_DIR=${CH_DATA_DIR_IN:-}
fi

CH_SMTP_HOST=${CHICOREE_SMTP_HOST:-}
if [ $INTERACTIVE -eq 1 ] && [ -z "$CH_SMTP_HOST" ] && [ -z "${CHICOREE_SMTP_SKIP:-}" ]; then
  ask CH_SMTP_IN "SMTP server for emails (invitations, notifications; empty = skip, configurable later)" ""
  CH_SMTP_HOST=${CH_SMTP_IN:-}
fi
CH_SMTP_PORT=${CHICOREE_SMTP_PORT:-587}; CH_SMTP_USER=${CHICOREE_SMTP_USER:-}; CH_SMTP_PASS=${CHICOREE_SMTP_PASS:-}; CH_SMTP_FROM=${CHICOREE_SMTP_FROM:-}
if [ -n "$CH_SMTP_HOST" ] && [ $INTERACTIVE -eq 1 ]; then
  [ -n "${CHICOREE_SMTP_PORT:-}" ] || ask CH_SMTP_PORT "SMTP port" "587"
  if [ -z "$CH_SMTP_USER" ]; then
    ask CH_SMTP_USER_IN "SMTP user (empty = none)" ""
    CH_SMTP_USER=${CH_SMTP_USER_IN:-}
  fi
  if [ -n "$CH_SMTP_USER" ] && [ -z "$CH_SMTP_PASS" ]; then
    printf 'SMTP password: ' > $TTY; stty -echo < $TTY 2>/dev/null || true; read -r CH_SMTP_PASS < $TTY || CH_SMTP_PASS=""; stty echo < $TTY 2>/dev/null || true; printf '\n' > $TTY
  fi
  [ -n "${CHICOREE_SMTP_FROM:-}" ] || ask CH_SMTP_FROM "From address" "Chicorée <registry@$CH_DOMAIN>"
fi

CH_ADMIN_EMAIL=${CHICOREE_ADMIN_EMAIL:-}; ask CH_ADMIN_EMAIL "Administrator email" "${CH_ACME_EMAIL:-admin@$CH_DOMAIN}"
CH_ADMIN_PASSWORD=${CHICOREE_ADMIN_PASSWORD:-}; ask_secret CH_ADMIN_PASSWORD "Administrator password"
ADMIN_GENERATED=0
if [ -z "$CH_ADMIN_PASSWORD" ]; then CH_ADMIN_PASSWORD=$(rand 20); ADMIN_GENERATED=1; fi
[ ${#CH_ADMIN_PASSWORD} -ge 8 ] || die "the administrator password needs at least 8 characters"

CH_SIGNUP=${CHICOREE_SIGNUP:-}
if [ -z "$CH_SIGNUP" ] && [ $INTERACTIVE -eq 1 ]; then
  cat > $TTY <<EOF
Who may create accounts after yours?
  1) closed   only administrators create accounts (Administration → Users)   [recommended]
  2) invite   people invited into an organization
  3) open     anyone who can reach the sign-up page
EOF
  ask CH_SIGNUP_CHOICE "Choice" "1"
  case "$CH_SIGNUP_CHOICE" in 2) CH_SIGNUP=invite;; 3) CH_SIGNUP=open;; *) CH_SIGNUP=closed;; esac
fi
CH_SIGNUP=${CH_SIGNUP:-closed}

CH_REPO=${CHICOREE_REPO:-$REPO_DEFAULT}
CH_REF=${CHICOREE_REF:-$REF_DEFAULT}

echo
bold "Summary"
echo "  mode:        $CH_MODE"
echo "  address:     $CH_DOMAIN"
echo "  directory:   $CH_DIR"
echo "  scanner:     $CH_SCANNER"
echo "  image data:  ${CH_DATA_DIR:-docker volume}"
echo "  email:       ${CH_SMTP_HOST:-not configured}"
echo "  admin:       $CH_ADMIN_EMAIL"
echo "  sign-up:     $CH_SIGNUP"
echo "  source:      $CH_REPO ($CH_REF)"
echo
if [ $INTERACTIVE -eq 1 ]; then
  ask GO "Install with these settings? [Y/n]" "y"
  case "$GO" in y|Y|yes|YES) ;; *) die "aborted";; esac
fi

[ -n "${CHICOREE_DRY_RUN:-}" ] && { info "dry run: stopping before any change"; exit 0; }

# --- privileges & dependencies ------------------------------------------------------

pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$@"
  elif command -v yum >/dev/null 2>&1; then yum install -y -q "$@"
  elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install "$@"
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache "$@"
  else die "no supported package manager found; install $* by hand and re-run"
  fi
}

need=""
for tool in curl git openssl; do command -v $tool >/dev/null 2>&1 || need="$need $tool"; done
if [ -n "$need" ]; then info "installing$need"; pkg_install $need ca-certificates; fi

if ! command -v docker >/dev/null 2>&1; then
  info "installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
fi
if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing (install docker-compose-plugin)"

# --- source ------------------------------------------------------------------------

if [ -d "$CH_DIR/.git" ]; then
  info "updating $CH_DIR"
  git -C "$CH_DIR" fetch -q origin "$CH_REF" && git -C "$CH_DIR" checkout -q "$CH_REF" 2>/dev/null || true
  git -C "$CH_DIR" pull -q --ff-only origin "$CH_REF" || warn "could not fast-forward; continuing with the current checkout"
else
  info "cloning $CH_REPO ($CH_REF) into $CH_DIR"
  mkdir -p "$(dirname "$CH_DIR")"
  git clone -q --depth 1 --branch "$CH_REF" "$CH_REPO" "$CH_DIR"
fi
cd "$CH_DIR"

# --- configuration -----------------------------------------------------------------

case "$CH_SCANNER" in
  trivy) SCANNER=trivy; PROFILES=""; CLAIR_URL="";;
  clair) SCANNER=clair; PROFILES=clair; CLAIR_URL=http://clair:6060;;
  none)  SCANNER=off;   PROFILES=""; CLAIR_URL="";;
esac

if [ -n "$CH_DATA_DIR" ]; then
  mkdir -p "$CH_DATA_DIR" && chown 10001:10001 "$CH_DATA_DIR"
fi

if [ "$CH_MODE" = public ]; then
  COMPOSE="docker compose -f docker-compose.prod.yml"
  if [ ! -f .env ]; then
    info "writing .env"
    sed \
      -e "s|^DOMAIN=.*|DOMAIN=$CH_DOMAIN|" \
      -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$CH_ACME_EMAIL|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 32)|" \
      -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(rand 48)|" \
      -e "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(rand 48)|" \
      -e "s|^JOBS_API_TOKEN=.*|JOBS_API_TOKEN=$(rand 48)|" \
      -e "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=$PROFILES|" \
      -e "s|^CLAIR_URL=.*|CLAIR_URL=$CLAIR_URL|" \
      -e "s|^SCANNER=.*|SCANNER=$SCANNER|" \
      -e "s|^SMTP_HOST=.*|SMTP_HOST=$CH_SMTP_HOST|" \
      -e "s|^SMTP_PORT=.*|SMTP_PORT=$CH_SMTP_PORT|" \
      -e "s|^SMTP_USER=.*|SMTP_USER=$CH_SMTP_USER|" \
      -e "s|^SMTP_PASS=.*|SMTP_PASS=$CH_SMTP_PASS|" \
      -e "s|^SMTP_FROM=.*|SMTP_FROM=$CH_SMTP_FROM|" \
      .env.prod.example > .env
    [ -n "$CH_DATA_DIR" ] && printf 'REGISTRY_DATA_DIR=%s\n' "$CH_DATA_DIR" >> .env
    printf 'SIGNUP_MODE=%s\n' "$CH_SIGNUP" >> .env
    chmod 600 .env
  else
    info ".env exists — keeping it"
  fi
  APP_URL="https://$CH_DOMAIN"
  REGISTRY_HOST="$CH_DOMAIN"
else
  COMPOSE="docker compose"
  sh scripts/gen-keys.sh >/dev/null
  if ! grep -q '^# installer' .env 2>/dev/null; then
    info "configuring .env for local mode"
    APP_URL="http://$CH_DOMAIN:3000"
    REGISTRY_HOST="$CH_DOMAIN:${CH_REGISTRY_PORT:-5000}"
    sed -i \
      -e "s|^APP_URL=.*|APP_URL=$APP_URL|" \
      -e "s|^REGISTRY_HOST=.*|REGISTRY_HOST=$REGISTRY_HOST|" \
      -e "s|^REGISTRY_PORT=.*|REGISTRY_PORT=${CH_REGISTRY_PORT:-5000}|" \
      -e "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=$PROFILES|" \
      -e "s|^CLAIR_URL=.*|CLAIR_URL=$CLAIR_URL|" \
      -e "s|^SCANNER=.*|SCANNER=$SCANNER|" \
      -e "s|^SMTP_HOST=.*|SMTP_HOST=$CH_SMTP_HOST|" \
      -e "s|^SMTP_PORT=.*|SMTP_PORT=$CH_SMTP_PORT|" \
      -e "s|^SMTP_USER=.*|SMTP_USER=$CH_SMTP_USER|" \
      -e "s|^SMTP_PASS=.*|SMTP_PASS=$CH_SMTP_PASS|" \
      -e "s|^SMTP_FROM=.*|SMTP_FROM=$CH_SMTP_FROM|" \
      -e "s|^SIGNUP_MODE=.*|SIGNUP_MODE=$CH_SIGNUP|" \
      .env
    grep -q '^SCANNER=' .env || printf 'SCANNER=%s\n' "$SCANNER" >> .env
    grep -q '^SIGNUP_MODE=' .env || printf 'SIGNUP_MODE=%s\n' "$CH_SIGNUP" >> .env
    [ -n "$CH_DATA_DIR" ] && printf 'REGISTRY_DATA_DIR=%s\n' "$CH_DATA_DIR" >> .env
    printf '# installer: configured %s\n' "$(date -u +%FT%TZ)" >> .env
  else
    info ".env already configured — keeping it"
  fi
  APP_URL=$(sed -n 's/^APP_URL=//p' .env); REGISTRY_HOST=$(sed -n 's/^REGISTRY_HOST=//p' .env)
fi

# --- start -------------------------------------------------------------------------

info "building and starting the stack (the first build takes a few minutes)"
$COMPOSE up -d --build --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

info "waiting for the web app"
i=0
until $COMPOSE exec -T web node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -lt 90 ] || { $COMPOSE ps; die "the web app did not become healthy; check: $COMPOSE logs web"; }
  sleep 2
done

# --- first administrator ------------------------------------------------------------

info "creating the administrator account"
SIGNUP=$($COMPOSE exec -T -e ADMIN_EMAIL="$CH_ADMIN_EMAIL" -e ADMIN_PASSWORD="$CH_ADMIN_PASSWORD" -e ORIGIN="$APP_URL" web node -e '
const body = JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, name: "Administrator" });
fetch("http://127.0.0.1:3000/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: process.env.ORIGIN }, body })
  .then(async (r) => { console.log(r.status + " " + (await r.text()).slice(0, 200)); })
  .catch((e) => { console.log("0 " + e.message); });' 2>/dev/null || echo "0 exec failed")
case "$SIGNUP" in
  200*) ADMIN_STATE=created
        # The administrator typed this address themselves; skip the verification round trip.
        $COMPOSE exec -T postgres psql -U chicoree -d chicoree -q -c "UPDATE \"user\" SET email_verified = true WHERE email = '$CH_ADMIN_EMAIL'" >/dev/null 2>&1 || true;;
  *"already"*|*"exist"*|422*) ADMIN_STATE=exists;;
  *) ADMIN_STATE="failed ($SIGNUP)";;
esac

echo
bold "Chicorée is running"
echo
echo "  Web UI:        $APP_URL"
echo "  Docker login:  docker login $REGISTRY_HOST -u $CH_ADMIN_EMAIL"
case "$ADMIN_STATE" in
  created) if [ "$ADMIN_GENERATED" = 1 ]; then echo "  Admin login:   $CH_ADMIN_EMAIL / $CH_ADMIN_PASSWORD   (generated — change it under Settings → Security)"; else echo "  Admin login:   $CH_ADMIN_EMAIL (the password you chose)"; fi;;
  exists) echo "  Admin login:   an account for $CH_ADMIN_EMAIL already existed; its password is unchanged";;
  *) warn "the administrator account could not be created: $ADMIN_STATE"; echo "  Open $APP_URL/sign-up — the first account becomes the administrator.";;
esac
echo
echo "  Configuration: $CH_DIR/.env   (secrets live here — keep it safe)"
echo "  Update later:  cd $CH_DIR && git pull && $COMPOSE up -d --build"
echo "  Logs:          cd $CH_DIR && $COMPOSE logs -f"
if [ "$CH_MODE" = public ]; then
  echo
  echo "  Let's Encrypt needs $CH_DOMAIN to resolve to this host with ports 80 and 443 reachable;"
  echo "  the certificate is issued on the first HTTPS request (it can take a minute)."
else
  echo
  echo "  Docker refuses plain-HTTP registries other than localhost: on client machines add"
  echo "  {\"insecure-registries\": [\"$REGISTRY_HOST\"]} to /etc/docker/daemon.json, or put a TLS proxy in front."
fi
echo
