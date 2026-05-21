#!/usr/bin/env bash
# Auto-tune recording params based on the host's vCPU and RAM, then upsert into .env.
# Run this on the VM once after pulling new code; safe to re-run.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

VCPU="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"
TOTAL_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [[ "$TOTAL_MB" == "0" ]]; then
  TOTAL_MB="$(sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024/1024)}' || echo 0)"
fi
GIB="$(awk -v m="$TOTAL_MB" 'BEGIN{ printf "%.1f", m/1024 }')"

profile="low"
max_concurrent=1
width=1280
height=720
fps=24
vb=2000
ab=96

if (( VCPU >= 2 )) && (( TOTAL_MB >= 6000 )); then
  profile="standard"
  width=1280; height=720; fps=30; vb=3500; ab=128
fi
if (( VCPU >= 4 )) && (( TOTAL_MB >= 14000 )); then
  profile="high"
  max_concurrent=2
  width=1920; height=1080; fps=30; vb=5000; ab=128
fi
if (( VCPU >= 8 )) && (( TOTAL_MB >= 28000 )); then
  profile="max"
  max_concurrent=3
  width=1920; height=1080; fps=60; vb=9000; ab=192
fi

echo "Detected: ${VCPU} vCPU, ${GIB} GiB RAM → profile=${profile}"
echo "  ${width}x${height}@${fps}fps  v${vb}k  a${ab}k  max-concurrent=${max_concurrent}"

upsert() {
  local key="$1" value="$2"
  if [[ -z "$value" ]]; then return; fi
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # macOS sed compatibility unnecessary; this runs on Ubuntu VM only.
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf "\n%s=%s" "$key" "$value" >> "$ENV_FILE"
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}; creating empty file" >&2
  touch "$ENV_FILE"
fi

upsert "RECORDER_PROFILE" "$profile"
upsert "RECORDER_DEFAULT_WIDTH" "$width"
upsert "RECORDER_DEFAULT_HEIGHT" "$height"
upsert "RECORDER_DEFAULT_FPS" "$fps"
upsert "RECORDER_DEFAULT_VIDEO_BITRATE_KBPS" "$vb"
upsert "RECORDER_DEFAULT_AUDIO_BITRATE_KBPS" "$ab"
upsert "RECORDER_MAX_CONCURRENT_SESSIONS" "$max_concurrent"
upsert "RECORDER_CHROMIUM_PATH" "/usr/bin/chromium"
upsert "RECORDING_STORAGE_PATH" "/var/lib/conclave/recordings"
upsert "CONCLAVE_SQLITE_PATH" "/var/lib/conclave/recordings/conclave.sqlite"

if [[ -z "${RECORDER_PUBLIC_URL:-}" ]] && ! grep -qE "^RECORDER_PUBLIC_URL=" "$ENV_FILE"; then
  if grep -qE "^NEXT_PUBLIC_APP_URL=" "$ENV_FILE"; then
    base="$(grep -E '^NEXT_PUBLIC_APP_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')"
    upsert "RECORDER_PUBLIC_URL" "$base"
  else
    upsert "RECORDER_PUBLIC_URL" "https://conclave.acmvit.in"
  fi
fi

# Make sure the recording storage dir exists with permissions docker can write to.
if [[ ! -d /var/lib/conclave/recordings ]]; then
  sudo mkdir -p /var/lib/conclave/recordings
  sudo chown -R 1000:1000 /var/lib/conclave
fi

echo "Updated ${ENV_FILE}. Run scripts/deploy-sfu.sh to roll the change out."
