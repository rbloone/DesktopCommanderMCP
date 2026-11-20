#!/usr/bin/env bash
# One-shot setup of a disposable test/demo VPS (Ubuntu 22.04/24.04, run as root):
#   - user "demo" with fake projects (sandbox fake HOME) + a few real public GitHub repos
#   - Node 22, this fork cloned and built in /home/demo/dc
#   - cloudflared for the ChatGPT probe
# The machine is meant to be thrown away after the trial: Desktop Commander remote gives the AI
# full shell access as "demo". Do NOT put personal keys, tokens or data on it.
#
# Usage on the VPS:
#   curl -fsSL https://raw.githubusercontent.com/<you>/DesktopCommanderMCP/<branch>/sandbox/device-context/vps-setup.sh -o vps-setup.sh
#   FORK_URL=https://github.com/<you>/DesktopCommanderMCP.git BRANCH=main bash vps-setup.sh
set -euo pipefail

FORK_URL="${FORK_URL:-https://github.com/rbloone/DesktopCommanderMCP.git}"
BRANCH="${BRANCH:-main}"
DEMO_USER="${DEMO_USER:-demo}"
REAL_REPOS=(
  # Python + React monorepo (backend/, frontend/)
  "https://github.com/fastapi/full-stack-fastapi-template.git"
  # Node web framework
  "https://github.com/expressjs/express.git"
  # Real Django site
  "https://github.com/django/djangoproject.com.git"
)

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates tmux build-essential python3 >/dev/null

echo "== swap (cheap VPS: 512MB RAM is not enough for npm run build)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== node 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "== cloudflared"
if ! command -v cloudflared >/dev/null; then
  arch="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
  dpkg -i /tmp/cloudflared.deb >/dev/null
fi

echo "== user $DEMO_USER"
id "$DEMO_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DEMO_USER"
H="/home/$DEMO_USER"

as_demo() { sudo -u "$DEMO_USER" -H bash -lc "$1"; }

echo "== fork -> $H/dc"
as_demo "
  set -e
  git config --global user.name 'Demo User'; git config --global user.email 'demo@example.invalid'
  [ -d ~/dc/.git ] || git clone --branch '$BRANCH' '$FORK_URL' ~/dc
  cd ~/dc && git pull --ff-only || true
  npm ci --no-audit --no-fund && npm run build
"

echo "== fake projects (srv/crm, srv/shop, decoys, monorepo...) in $H"
as_demo "cd ~/dc && node -e \"import('./sandbox/device-context/fake-home.mjs').then(m => m.createFakeHome(process.env.HOME))\""

echo "== real repos -> $H/code"
as_demo "mkdir -p ~/code"
for url in "${REAL_REPOS[@]}"; do
  name="$(basename "$url" .git)"
  as_demo "[ -d ~/code/$name ] || git clone --depth 50 '$url' ~/code/$name"
done

echo "== env for every demo shell"
as_demo "grep -q DESKTOP_COMMANDER_DISABLE_TELEMETRY ~/.bashrc || cat >> ~/.bashrc <<'EOF'
export DESKTOP_COMMANDER_DISABLE_TELEMETRY=1
# device context mode for the remote daemon: off | tool | nudge | both (needs the feature built in ~/dc)
export DESKTOP_COMMANDER_DEVICE_CONTEXT=\${DESKTOP_COMMANDER_DEVICE_CONTEXT:-both}
EOF"

cat <<EOF

Done. Layout of $H:
  srv/crm srv/shop srv/legacy-billing srv/reports srv/backup-crm (decoy)
  work/crm-mobile (decoy name) work/platform (monorepo)
  code/$(for u in "${REAL_REPOS[@]}"; do printf '%s ' "$(basename "$u" .git)"; done)
  dc/  (this fork, built)

Next (as $DEMO_USER):   su - $DEMO_USER

  # 1) real Desktop Commander remote from the fork (first run prints a URL + code to authorize)
  tmux new -s dc 'cd ~/dc && node dist/index.js remote'
  #    then connect ChatGPT at https://mcp.desktopcommander.app

  # 2) ChatGPT probe with viewer (fake disk, no access to this machine)
  tmux new -s probe 'cd ~/dc && MODE=both node sandbox/device-context/chatgpt-probe.mjs'
  tmux new -s tunnel 'cloudflared tunnel --url http://localhost:8787'
  #    viewer from your laptop:  ssh -L 8787:localhost:8787 root@<vps-ip>  ->  http://localhost:8787/_probe/ui
EOF
