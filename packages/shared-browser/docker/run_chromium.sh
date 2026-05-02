#!/bin/bash
set -euo pipefail

get_display_size() {
    local resolution="${RESOLUTION:-1280x720x24}"
    local width="${resolution%%x*}"
    local rest="${resolution#*x}"
    local height="${rest%%x*}"

    if [[ -z "$width" || -z "$height" || "$width" == "$resolution" ]]; then
        width="1280"
        height="720"
    fi

    echo "${width},${height}"
}

wait_for_xvfb() {
    for _ in {1..50}; do
        if xdpyinfo -display "${DISPLAY:-:99}" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.2
    done

    echo "Timed out waiting for Xvfb on ${DISPLAY:-:99}" >&2
    return 1
}

start_chromium() {
    echo "Starting Chromium..."
    wait_for_xvfb

    if [[ -n "${PULSE_SERVER:-}" ]]; then
        socket="${PULSE_SERVER#unix:}"
        for i in {1..20}; do
            if [[ -S "$socket" ]]; then
                break
            fi
            sleep 0.2
        done
    fi

    mkdir -p /tmp/chromium-profile
    local window_size
    window_size="$(get_display_size)"
    local extension_dir="${UBLOCK_ORIGIN_EXTENSION_DIR:-/usr/share/chromium/extensions/ublock-origin}"

    /usr/bin/chromium \
        --user-data-dir=/tmp/chromium-profile \
        --ozone-platform=x11 \
        --disable-extensions-except="${extension_dir}" \
        --load-extension="${extension_dir}" \
        --no-first-run \
        --no-default-browser-check \
        --autoplay-policy=no-user-gesture-required \
        --force-device-scale-factor=1 \
        --window-position=0,0 \
        --window-size="${window_size}" \
        --start-fullscreen \
        "${START_URL:-about:blank}"
}

while true; do
    start_chromium
    echo "Chromium exited (exit code $?). Restarting in 1 second..."
    sleep 1
done
