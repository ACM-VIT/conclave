#!/bin/bash

start_chromium() {
    echo "Starting Chromium..."
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
        --window-size=1280,720 \
        "${START_URL:-about:blank}"
}

while true; do
    start_chromium
    echo "Chromium exited (exit code $?). Restarting in 1 second..."
    sleep 1
done
