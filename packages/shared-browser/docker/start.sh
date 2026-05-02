#!/bin/bash
set -euo pipefail

cleanup() {
    jobs -pr | xargs -r kill 2>/dev/null || true
}

trap cleanup EXIT INT TERM

Xvfb :99 -screen 0 ${RESOLUTION:-1280x720x24} &

for _ in {1..50}; do
    if xdpyinfo -display :99 >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

RESOLUTION="${RESOLUTION:-1280x720x24}"
WIDTH="${RESOLUTION%%x*}"
REST="${RESOLUTION#*x}"
HEIGHT="${REST%%x*}"
EXTENSION_DIR="${UBLOCK_ORIGIN_EXTENSION_DIR:-/usr/share/chromium/extensions/ublock-origin}"

/usr/bin/chromium \
    --user-data-dir=/tmp/chromium-profile \
    --ozone-platform=x11 \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-extensions-except="${EXTENSION_DIR}" \
    --load-extension="${EXTENSION_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    --autoplay-policy=no-user-gesture-required \
    --force-device-scale-factor=1 \
    --window-position=0,0 \
    --window-size="${WIDTH},${HEIGHT}" \
    "${START_URL:-about:blank}" &
sleep 2

x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -noxdamage -xkb -repeat &
websockify --web=/usr/share/novnc 6080 localhost:5900 &

wait -n
