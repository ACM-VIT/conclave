#!/bin/bash
set -e

if [ -z "${VIDEO_TARGET_IP}" ] || [ -z "${VIDEO_TARGET_PORT}" ]; then
  echo "[Video] VIDEO_TARGET not set, video streaming disabled."
  tail -f /dev/null
fi

# Wait for Xvfb to be ready
for i in {1..30}; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "[Video] Xvfb is ready"
    break
  fi
  sleep 0.2
done

RESOLUTION="${RESOLUTION:-1280x720x24}"
WIDTH="${RESOLUTION%%x*}"
REST="${RESOLUTION#*x}"
HEIGHT="${REST%%x*}"

PAYLOAD="${VIDEO_PAYLOAD_TYPE:-96}"
SSRC="${VIDEO_SSRC:-22222222}"
FRAMERATE="${VIDEO_FRAMERATE:-30}"
BITRATE="${VIDEO_BITRATE:-2M}"
RTCP_PORT="${VIDEO_RTCP_PORT:-$((VIDEO_TARGET_PORT + 1))}"

echo "[Video] Starting capture: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps → ${VIDEO_TARGET_IP}:${VIDEO_TARGET_PORT} (RTCP: ${RTCP_PORT})"

exec ffmpeg -nostdin -hide_banner -loglevel warning \
  -f x11grab -draw_mouse 1 -video_size "${WIDTH}x${HEIGHT}" -framerate "${FRAMERATE}" -i :99.0 \
  -vf format=yuv420p \
  -c:v libvpx -deadline realtime -cpu-used 8 \
  -g "$((FRAMERATE * 2))" -keyint_min "$((FRAMERATE * 2))" \
  -b:v "${BITRATE}" -maxrate "${BITRATE}" -bufsize 4M \
  -payload_type "${PAYLOAD}" -ssrc "${SSRC}" \
  -f rtp "rtp://${VIDEO_TARGET_IP}:${VIDEO_TARGET_PORT}?rtcpport=${RTCP_PORT}&pkt_size=1200"
