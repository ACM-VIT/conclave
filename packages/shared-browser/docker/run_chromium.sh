#!/bin/bash

start_chromium() {
    echo "Starting Chromium..."
    if [[ -n "${PULSE_SERVER:-}" ]]; then
        socket="${PULSE_SERVER#unix:}"
        for i in {1..20}; do
            if [[ -S "$socket" ]]; then
                break
            fi
            sleep 0.2
        done
    fi
    /usr/bin/chromium \
        --no-sandbox \
        --disable-gpu \
        --disable-software-rasterizer \
        --disable-dev-shm-usage \
        --no-first-run \
        --autoplay-policy=no-user-gesture-required \
        --enable-features=UsePulseAudio \
        --disable-background-networking \
        --disable-sync \
        --disable-translate \
        --disable-extensions \
        --disable-default-apps \
        --disable-features=TranslateUI \
        --no-zygote \
        --renderer-process-limit=2 \
        --js-flags="--max-old-space-size=256" \
        --window-size=1280,720 \
        "${START_URL:-about:blank}"
}

while true; do
    start_chromium
    echo "Chromium exited (exit code $?). Restarting in 1 second..."
    sleep 1
done
