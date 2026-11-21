#!/bin/sh
# Agent Army on one Linux server: Docker, the app, and Caddy for automatic HTTPS.
#
#   curl -fsSL https://raw.githubusercontent.com/Genpire/agent-army/main/deploy/install.sh | sh
#
# Without questions (cloud-init user data, scripts):
#   curl -fsSL https://raw.githubusercontent.com/Genpire/agent-army/main/deploy/install.sh | DOMAIN=army.example.com sh
#
# Safe to re-run: it pulls the newest image and keeps .env (the keys, the domain and
# anything you added) and the data. Use a server with 8 GB of RAM or more.
#
# Options (environment variables):
#   DOMAIN            A name whose DNS A record points at this server. Empty: the server's
#                     public IPv4 address, with a 6-day Let's Encrypt IP certificate (experimental).
#                     Unset: asked on the first run, then kept in .env.
#   PUBLIC_IP         The public IPv4 address for IP mode, when the server is behind 1:1 NAT
#                     (Lightsail, EC2). Kept in .env.
#   SETUP_TOKEN       Choose the one-time setup token yourself (default: generated, then kept).
#   AGENT_ARMY_IMAGE  Default: ghcr.io/genpire/agent-army:latest (a fork: ghcr.io/<owner>/agent-army:latest).
#   GHCR_USER, GHCR_TOKEN  Log in to ghcr.io first, for a private image (a classic token with read:packages).
#   AGENT_ARMY_DIR    Default: /opt/agent-army.
#   NONINTERACTIVE=1  Never ask.
#
# It writes $AGENT_ARMY_DIR/.env (mode 600, with MASTER_KEY, which it never prints),
# compose.yaml and caddy/Caddyfile: the same files as deploy/compose/ in the repo.
set -eu

DIR="${AGENT_ARMY_DIR:-/opt/agent-army}"
ENV_FILE="$DIR/.env"
DATA_VOLUME="agent-army_army-data"

say() { printf '==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this installer runs on a Linux server."
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  die "run it as root, or install sudo."
fi
command -v curl >/dev/null 2>&1 || die "curl is required."

mem_kb="$(sed -n 's/^MemTotal: *\([0-9]*\) kB$/\1/p' /proc/meminfo 2>/dev/null || true)"
if [ -n "$mem_kb" ] && [ "$mem_kb" -lt 7000000 ]; then
  say "Warning: this server has about $(((mem_kb + 524288) / 1048576)) GB of RAM. Repo tasks need about 8 GB for 3 at a time:"
  say "use a bigger server, or set Settings > Repo task limits > Tasks at the same time to 1."
fi

# ---------- 1. Docker Engine and the Compose plugin ----------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker with the official script (get.docker.com)"
  script="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$script"
  $SUDO sh "$script"
  rm -f "$script"
fi
# RPM-based distributions do not start Docker after installing it.
$SUDO systemctl enable --now docker >/dev/null 2>&1 || true
$SUDO docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing: install docker-compose-plugin."

# ---------- 2. Settings, kept across re-runs ----------
have_env() { $SUDO test -f "$ENV_FILE"; }
current() { # KEY: its value in the existing .env, if any
  if have_env; then $SUDO sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; fi
}
random_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
plain() { # NAME VALUE: a value given in the environment must be safe to write to .env
  case "$2" in
    *[!A-Za-z0-9._~+/=-]*) die "$1 may only contain letters, digits and . _ ~ + / = -" ;;
  esac
}
is_private_ip() {
  case "$1" in
    "" | 0.* | 10.* | 127.* | 192.168.* | 169.254.*) return 0 ;;
    172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) return 0 ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[0-1][0-9].* | 100.12[0-7].*) return 0 ;;
    *) return 1 ;;
  esac
}

IMAGE="${AGENT_ARMY_IMAGE:-$(current AGENT_ARMY_IMAGE)}"
IMAGE="${IMAGE:-ghcr.io/genpire/agent-army:latest}"

if [ "${DOMAIN+set}" = "set" ]; then
  : # given; an empty value selects IP mode
elif have_env; then
  DOMAIN="$(current DOMAIN)"
else
  DOMAIN=""
  if [ "${NONINTERACTIVE:-0}" != "1" ] && (: </dev/tty) 2>/dev/null; then
    printf 'Domain for Agent Army (its DNS A record must point at this server).\nLeave empty to use the server IP address (experimental): ' >/dev/tty
    read -r DOMAIN </dev/tty || DOMAIN=""
  fi
fi
# Accept "https://army.example.com/" too.
DOMAIN="$(printf '%s' "$DOMAIN" | sed 's#^[A-Za-z]*://##; s#/.*$##' | tr '[:upper:]' '[:lower:]')"
case "$DOMAIN" in
  *[!a-z0-9.-]*) die "\"$DOMAIN\" is not a domain name." ;;
  *[!0-9.]*) ;;
  ?*) PUBLIC_IP="$DOMAIN"; DOMAIN="" ;; # an IP address: IP mode
esac

if [ -n "$DOMAIN" ]; then
  SITE="$DOMAIN"
  IP_MODE=0
  ip=""
else
  ip="${PUBLIC_IP:-$(current PUBLIC_IP)}"
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
  fi
  case "$ip" in *[!0-9.]*) die "\"$ip\" is not an IPv4 address." ;; esac
  if is_private_ip "$ip"; then
    die "no public IPv4 address on this server (it may be behind NAT). Re-run with DOMAIN=<a name pointing here> or PUBLIC_IP=<its public address>."
  fi
  SITE="$ip"
  IP_MODE=1
fi

# The key in an existing .env always wins: a different one would make the stored data unreadable.
existing_key="$(current MASTER_KEY)"
if [ -n "$existing_key" ]; then
  if [ -n "${MASTER_KEY:-}" ] && [ "$MASTER_KEY" != "$existing_key" ]; then
    die "MASTER_KEY differs from the one in $ENV_FILE. Keep the existing key: it decrypts the stored data."
  fi
  MASTER_KEY="$existing_key"
elif [ -n "${MASTER_KEY:-}" ]; then
  plain MASTER_KEY "$MASTER_KEY"
elif $SUDO docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
  die "the data volume $DATA_VOLUME exists, but $ENV_FILE has no MASTER_KEY. Put the old .env back, or re-run with MASTER_KEY=<the key it was created with>."
else
  MASTER_KEY="$(random_hex 32)"
fi
if [ -n "${SETUP_TOKEN:-}" ]; then
  plain SETUP_TOKEN "$SETUP_TOKEN"
else
  SETUP_TOKEN="$(current SETUP_TOKEN)"
  [ -n "$SETUP_TOKEN" ] || SETUP_TOKEN="$(random_hex 18)"
fi

say "Writing $DIR"
$SUDO mkdir -p "$DIR/caddy"
umask 077
put() { # PATH MODE, content on stdin
  tmp="$(mktemp)"
  cat >"$tmp"
  $SUDO install -m "$2" "$tmp" "$1"
  rm -f "$tmp"
}

{
  echo "# Agent Army, written by deploy/install.sh. Keep MASTER_KEY: it decrypts the stored data."
  echo "DOMAIN=$DOMAIN"
  echo "PUBLIC_IP=$ip"
  echo "SITE_ADDRESS=$SITE"
  echo "PUBLIC_URL=https://$SITE"
  echo "AGENT_ARMY_IMAGE=$IMAGE"
  echo "MASTER_KEY=$MASTER_KEY"
  echo "SETUP_TOKEN=$SETUP_TOKEN"
  # Keep anything else the owner added (TASK_TIMEOUT_MIN, BROWSER, ...).
  if have_env; then
    $SUDO grep -v -E '^(# Agent Army, written by|DOMAIN=|PUBLIC_IP=|SITE_ADDRESS=|PUBLIC_URL=|AGENT_ARMY_IMAGE=|MASTER_KEY=|SETUP_TOKEN=)' "$ENV_FILE" || true
  fi
} | put "$ENV_FILE" 600

# The three files below are deploy/compose/compose.yaml, caddy/Caddyfile and
# caddy/Caddyfile.ip, copied as they are (a test keeps them identical).
put "$DIR/compose.yaml" 644 <<'EOF'
# Agent Army on one server: the app and Caddy (automatic HTTPS).
# deploy/install.sh writes this file, caddy/Caddyfile and .env to /opt/agent-army.
# By hand: copy deploy/compose/ to the server, put a .env next to this file with
#   SITE_ADDRESS=army.example.com         (its DNS A record points at this server)
#   PUBLIC_URL=https://army.example.com
#   MASTER_KEY=...                        (openssl rand -hex 32; keep it: it decrypts the data)
#   SETUP_TOKEN=...                       (openssl rand -hex 18; creates the admin account)
# then run: docker compose up -d
name: agent-army
x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"
services:
  agent-army:
    image: ${AGENT_ARMY_IMAGE:-ghcr.io/genpire/agent-army:latest}
    restart: unless-stopped
    # Reaps the task workers' child processes (the server is PID 1 otherwise).
    init: true
    environment:
      MASTER_KEY: ${MASTER_KEY:?set MASTER_KEY in .env}
      REQUIRE_MASTER_KEY: "1"
      SETUP_TOKEN: ${SETUP_TOKEN:?set SETUP_TOKEN in .env}
      PUBLIC_URL: ${PUBLIC_URL:?set PUBLIC_URL in .env}
      RUNNER: local
      STORAGE: fs
      DATA_DIR: /data
      TASK_TIMEOUT_MIN: ${TASK_TIMEOUT_MIN:-50}
      BROWSER: ${BROWSER:-on}
    volumes:
      - army-data:/data
    # Headless Chromium runs out of shared memory with Docker's 64 MB default.
    shm_size: "1gb"
    stop_grace_period: 60s
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    logging: *logging
  caddy:
    image: caddy:2.11
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS:?set SITE_ADDRESS in .env}
    volumes:
      - ./caddy:/etc/caddy:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      agent-army:
        condition: service_healthy
    logging: *logging
volumes:
  army-data:
  caddy-data:
  caddy-config:
EOF

if [ "$IP_MODE" = "1" ]; then
  put "$DIR/caddy/Caddyfile" 644 <<'EOF'
# EXPERIMENTAL: Agent Army behind Caddy on the server's public IPv4 address, with no domain.
# Let's Encrypt issues IP address certificates only with its 6-day "shortlived" profile;
# Caddy renews them. Caddy's ACME "profile" option is itself experimental, so this may
# not get a certificate. If it doesn't, use a domain (Caddyfile), or a name such as
# 203-0-113-7.sslip.io (a third-party DNS service) that resolves to the IP.
# deploy/install.sh uses this file as caddy/Caddyfile when no domain is given.
# By hand: copy it over caddy/Caddyfile and set SITE_ADDRESS in .env to the IP address.
{$SITE_ADDRESS} {
	tls {
		issuer acme {
			profile shortlived
		}
	}
	reverse_proxy agent-army:8080
}
EOF
else
  put "$DIR/caddy/Caddyfile" 644 <<'EOF'
# Agent Army behind Caddy: a Let's Encrypt certificate for the domain, renewed automatically.
# SITE_ADDRESS (in .env) is the domain; ports 80 and 443 must be open to the internet.
{$SITE_ADDRESS} {
	reverse_proxy agent-army:8080
}
EOF
fi

# ---------- 3. Start ----------
dc() { $SUDO docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" "$@"; }
logs_hint="sudo docker compose -f $DIR/compose.yaml logs agent-army"

if [ -n "${GHCR_TOKEN:-}" ]; then
  [ -n "${GHCR_USER:-}" ] || die "set GHCR_USER together with GHCR_TOKEN."
  printf '%s' "$GHCR_TOKEN" | $SUDO docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
fi

say "Pulling $IMAGE (over 1 GB) and Caddy"
dc pull || die "could not pull the images. A private image: make the package public (GitHub > the package > Package settings > Change visibility), or re-run with GHCR_USER and GHCR_TOKEN (a classic token with read:packages)."
say "Starting (the first start takes up to a minute)"
dc up -d --remove-orphans || die "Agent Army did not start. Logs: $logs_hint"

say "Waiting for Agent Army to answer"
i=0
until dc exec -T agent-army curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 60 ] || die "Agent Army did not start. Logs: $logs_hint"
  sleep 5
done

say "Waiting for the HTTPS certificate"
i=0
https_ok=0
while [ "$i" -lt 24 ]; do
  if curl -fsS --max-time 10 "https://$SITE/healthz" >/dev/null 2>&1; then https_ok=1; break; fi
  i=$((i + 1))
  sleep 5
done

echo
echo "Agent Army is running: Pointer and its team."
echo
echo "  Open:         https://$SITE"
echo "  Setup token:  $SETUP_TOKEN"
echo
if [ "$https_ok" != "1" ]; then
  echo "HTTPS did not answer yet. Check that ports 80 and 443 are open to the internet"
  echo "(cloud firewall, Lightsail networking tab) and that the DNS record points here, then:"
  echo "  sudo docker compose -f $DIR/compose.yaml logs caddy"
  echo
fi
echo "Open the URL, create the admin account with the setup token, then connect Claude,"
echo "Slack and GitHub on the page. The keys are in $DIR/.env (keep MASTER_KEY safe);"
echo "the setup token again: sudo grep SETUP_TOKEN $DIR/.env"
echo "Update: run this installer again. Logs: sudo docker compose -f $DIR/compose.yaml logs -f agent-army"
