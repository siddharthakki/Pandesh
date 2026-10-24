#!/usr/bin/env bash
set -euo pipefail

RUNNER_DIR="${1:-$HOME/actions-runner}"
CLEAN_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

log() {
  printf '[karkedikha-runner] %s\n' "$*"
}

fail() {
  printf '[karkedikha-runner] ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ ! -d "$RUNNER_DIR" ]]; then
  fail "Runner directory does not exist: $RUNNER_DIR"
fi

if [[ ! -x "$RUNNER_DIR/run.sh" || ! -x "$RUNNER_DIR/svc.sh" ]]; then
  fail "Runner scripts were not found under $RUNNER_DIR. Configure the GitHub runner before installing the service."
fi

if [[ ! -f "$RUNNER_DIR/.runner" ]]; then
  fail "The runner is not configured. Use the repository Settings -> Actions -> Runners setup command first."
fi

if [[ "$(ps -p 1 -o comm= | tr -d ' ')" != 'systemd' ]]; then
  cat >&2 <<'EOF'
[karkedikha-runner] ERROR: systemd is not active in WSL.
Add the following to /etc/wsl.conf:

[boot]
systemd=true

Then run 'wsl --shutdown' from Windows PowerShell and start Ubuntu again.
EOF
  exit 2
fi

log "Installing required Linux packages."
sudo apt-get update
sudo apt-get install -y curl tar gzip git jq unzip build-essential

export PATH="$CLEAN_PATH"

command -v git >/dev/null || fail 'git is unavailable after package installation.'
command -v unzip >/dev/null || fail 'unzip is unavailable after package installation.'

cd "$RUNNER_DIR"

# The runner service does not reliably preserve the install shell's PATH under
# WSL. Persist a Linux-only PATH so Windows entries cannot affect checkout or
# tests that deliberately simulate an unavailable executable.
if [[ -f .env ]]; then
  sed -i '/^PATH=/d' .env
fi
printf 'PATH=%s\n' "$CLEAN_PATH" >> .env

if [[ ! -f .service ]]; then
  log 'Installing the official GitHub Actions runner systemd service.'
  sudo ./svc.sh install
else
  log "Runner service is already registered as $(cat .service)."
fi

log 'Restarting the runner service with the persisted Linux-only PATH.'
sudo ./svc.sh stop >/dev/null 2>&1 || true
sudo ./svc.sh start

log 'Runner service status:'
sudo ./svc.sh status

service_name="$(cat .service)"
if ! systemctl is-active --quiet "$service_name"; then
  fail "Service $service_name is not active. Inspect: journalctl -u $service_name"
fi

listener_pid="$(pgrep -f "$RUNNER_DIR/bin/Runner.Listener" | head -n 1 || true)"
if [[ -z "$listener_pid" ]]; then
  fail 'Runner.Listener did not start after the service restart.'
fi

listener_path="$(tr '\0' '\n' < "/proc/$listener_pid/environ" | sed -n 's/^PATH=//p')"
if [[ "$listener_path" != "$CLEAN_PATH" ]]; then
  fail "Runner.Listener PATH is not clean: $listener_path"
fi

log "Runner service $service_name is active with a Linux-only PATH."
log 'Install the Windows scheduled-task watchdog with scripts/github-actions/install-runner-autostart.ps1.'
