#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.browser.yml"
BUILD_RUNTIME_IMAGE="true"

for arg in "$@"; do
  case "$arg" in
    --skip-runtime-image)
      BUILD_RUNTIME_IMAGE="false"
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      echo "Usage: $0 [--skip-runtime-image]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing ${COMPOSE_FILE}" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
else
  COMPOSE=(docker compose -f "$COMPOSE_FILE")
fi

RUNTIME_IMAGE_NAME="${BROWSER_IMAGE_NAME:-conclave-browser:latest}"

if [[ "$BUILD_RUNTIME_IMAGE" == "true" ]]; then
  BROWSER_DOCKER_DIR="${ROOT_DIR}/packages/shared-browser/docker"
  if [[ ! -d "$BROWSER_DOCKER_DIR" ]]; then
    echo "Missing browser runtime Docker context at ${BROWSER_DOCKER_DIR}" >&2
    exit 1
  fi

  echo "Building browser runtime image (${RUNTIME_IMAGE_NAME})..."
  docker build -t "$RUNTIME_IMAGE_NAME" "$BROWSER_DOCKER_DIR"
fi

echo "Deploying shared browser service..."
"${COMPOSE[@]}" up -d --build browser-service

echo ""
echo "Shared browser service deployed."
echo "Control API: http://<browser-host>:${BROWSER_SERVICE_PORT:-3040}/health"
echo "noVNC ports: ${NOVNC_PORT_START:-6080}-${NOVNC_PORT_END:-6100}"

if [[ -z "${BROWSER_PUBLIC_BASE_URL:-}" && "${BROWSER_HOST_ADDRESS:-localhost}" == "localhost" ]]; then
  echo ""
  echo "Warning: BROWSER_PUBLIC_BASE_URL is unset and BROWSER_HOST_ADDRESS=localhost."
  echo "Clients will receive localhost noVNC URLs unless you set one of these values."
fi

if [[ -z "${BROWSER_RTP_TARGET_HOST:-}" && -z "${BROWSER_AUDIO_TARGET_HOST:-}" && -z "${BROWSER_VIDEO_TARGET_HOST:-}" && -z "${SFU_HOST:-}" ]]; then
  echo ""
  echo "Note: No explicit RTP target host override is set."
  echo "Ensure SFU sets PLAIN_TRANSPORT_ANNOUNCED_IP to a browser-host-reachable IP."
fi
