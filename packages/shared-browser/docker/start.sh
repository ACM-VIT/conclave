#!/bin/bash
set -e

Xvfb :99 -screen 0 ${RESOLUTION:-1280x720x24} &
sleep 1

RESOLUTION="${RESOLUTION:-1280x720x24}"
WIDTH="${RESOLUTION%%x*}"
REST="${RESOLUTION#*x}"
HEIGHT="${REST%%x*}"
EXTENSION_DIR="${UBLOCK_ORIGIN_EXTENSION_DIR:-/usr/share/chromium/extensions/ublock-origin}"

/usr/bin/chromium \
    --user-data-dir=/tmp/chromium-profile \
    --ozone-platform=x11 \
    --disable-extensions-except="${EXTENSION_DIR}" \
    --load-extension="${EXTENSION_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    --autoplay-policy=no-user-gesture-required \
    --force-device-scale-factor=1 \
    --window-position=0,0 \
    --window-size="${WIDTH},${HEIGHT}" \
    --start-fullscreen \
    "${START_URL:-about:blank}" &
sleep 2

x11vnc -display :99 -forever -shared -rfbport 5900 -nopw &
websockify --web=/usr/share/novnc 6080 localhost:5900

wait
