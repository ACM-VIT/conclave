#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.browser.yml"
BUILD_RUNTIME_IMAGE="true"
CHECK_CONFIG_ONLY="false"

for arg in "$@"; do
  case "$arg" in
    --skip-runtime-image)
      BUILD_RUNTIME_IMAGE="false"
      ;;
    --check-config)
      CHECK_CONFIG_ONLY="true"
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      echo "Usage: $0 [--skip-runtime-image] [--check-config]" >&2
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

BROWSER_PROVIDER="${BROWSER_PROVIDER:-chromium}"
if [[ "$BROWSER_PROVIDER" == "kitesurf" ]]; then
  BUILD_RUNTIME_IMAGE="false"
  export BROWSER_DOCKER_SOCKET="${BROWSER_DOCKER_SOCKET:-/dev/null}"
fi

RUNTIME_IMAGE_NAME="${BROWSER_IMAGE_NAME:-conclave-browser:latest}"
CHECK_IMAGE_NAME="$RUNTIME_IMAGE_NAME"
CANDIDATE_IMAGE_NAME=""
if [[ "$BUILD_RUNTIME_IMAGE" == "true" ]]; then
  BROWSER_DOCKER_DIR="${ROOT_DIR}/packages/shared-browser/docker"
  if [[ ! -d "$BROWSER_DOCKER_DIR" ]]; then
    echo "Missing browser runtime Docker context at ${BROWSER_DOCKER_DIR}" >&2
    exit 1
  fi
  CANDIDATE_IMAGE_NAME="conclave-browser-candidate:$$"
  trap 'docker image rm "$CANDIDATE_IMAGE_NAME" >/dev/null 2>&1 || true' EXIT
  echo "Building browser runtime image (${RUNTIME_IMAGE_NAME})..."
  docker build -t "$CANDIDATE_IMAGE_NAME" "$BROWSER_DOCKER_DIR"
  CHECK_IMAGE_NAME="$CANDIDATE_IMAGE_NAME"
fi

# Run the service's own startup checks in the new image, against the runtime
# image it would launch, before anything is replaced or retagged.
echo "Checking the shared browser service configuration..."
PREVIOUS_CONTAINER="$("${COMPOSE[@]}" ps -q browser-service 2>/dev/null | head -n 1 || true)"
if [[ -n "$PREVIOUS_CONTAINER" && "$(docker inspect --format '{{.State.Running}}' "$PREVIOUS_CONTAINER" 2>/dev/null || true)" != "true" ]]; then
  PREVIOUS_CONTAINER=""
fi
PREVIOUS_PORTS=""
PREVIOUS_DEPLOY_ID=""
if [[ -n "$PREVIOUS_CONTAINER" ]]; then
  previous_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PREVIOUS_CONTAINER" 2>/dev/null || true)"
  PREVIOUS_DEPLOY_ID="$(sed -n 's/^BROWSER_SERVICE_DEPLOY_ID=//p' <<<"$previous_env" | tail -n 1)"
  if [[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$PREVIOUS_CONTAINER" 2>/dev/null || true)" == "host" ]]; then
    PREVIOUS_PORTS="$(sed -n 's/^BROWSER_SERVICE_PORT=//p' <<<"$previous_env" | tail -n 1)"
    PREVIOUS_PORTS="${PREVIOUS_PORTS:-3040}"
  else
    PREVIOUS_PORTS="$(docker inspect --format '{{range $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{.HostPort}},{{end}}{{end}}' "$PREVIOUS_CONTAINER" 2>/dev/null || true)"
    PREVIOUS_PORTS="${PREVIOUS_PORTS%,}"
  fi
fi
"${COMPOSE[@]}" build browser-service
"${COMPOSE[@]}" run --rm --no-deps -e "BROWSER_IMAGE_NAME=${CHECK_IMAGE_NAME}" -e "BROWSER_SERVICE_PREVIOUS_CONTAINER=${PREVIOUS_CONTAINER}" -e "BROWSER_SERVICE_PREVIOUS_PORTS=${PREVIOUS_PORTS}" -e "BROWSER_SERVICE_PREVIOUS_DEPLOY_ID=${PREVIOUS_DEPLOY_ID}" browser-service node packages/shared-browser/dist/server.js --check-config
if [[ "$CHECK_CONFIG_ONLY" == "true" ]]; then
  exit 0
fi

if [[ -n "$CANDIDATE_IMAGE_NAME" ]]; then
  docker tag "$CANDIDATE_IMAGE_NAME" "$RUNTIME_IMAGE_NAME"
fi

BROWSER_SERVICE_DEPLOY_ID="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
export BROWSER_SERVICE_DEPLOY_ID
echo "Deploying shared browser service (deploy ${BROWSER_SERVICE_DEPLOY_ID})..."
"${COMPOSE[@]}" up -d --build browser-service

SERVICE_HOST="${BROWSER_SERVICE_HOST:-127.0.0.1}"
[[ "$SERVICE_HOST" == *:* ]] && SERVICE_HOST="[${SERVICE_HOST}]"
HEALTH_URL="http://${SERVICE_HOST}:${BROWSER_SERVICE_PORT:-3040}/health"

# `up -d` returns once the container starts, before the service has checked
# its configuration, so wait for the API to answer.
echo "Waiting for ${HEALTH_URL}..."
healthy="false"
deadline=$(( $(date +%s) + ${BROWSER_SERVICE_HEALTH_TIMEOUT_SECONDS:-120} ))
while (( $(date +%s) < deadline )); do
  body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  if [[ "$body" == *'"service":"conclave-shared-browser"'* && "$body" == *"\"deployId\":\"${BROWSER_SERVICE_DEPLOY_ID}\""* && "$body" == *'"status":"ok"'* ]]; then
    healthy="true"
    break
  fi
  sleep 2
done
if [[ "$healthy" != "true" ]]; then
  echo "The shared browser service from this deploy (${BROWSER_SERVICE_DEPLOY_ID}) did not answer healthy at ${HEALTH_URL}." >&2
  echo "See: docker compose -f ${COMPOSE_FILE} logs browser-service" >&2
  exit 1
fi

echo ""
echo "Shared browser service deployed."
echo "Control API: ${HEALTH_URL}"
echo "Provider: ${BROWSER_PROVIDER}"
if [[ "$BROWSER_PROVIDER" == "chromium" ]]; then
  echo "noVNC ports: ${NOVNC_PORT_START:-6080}-${NOVNC_PORT_END:-6100}"
fi

if [[ "$BROWSER_PROVIDER" == "chromium" && -z "${BROWSER_PUBLIC_BASE_URL:-}" && "${BROWSER_HOST_ADDRESS:-localhost}" == "localhost" ]]; then
  echo ""
  echo "Warning: BROWSER_PUBLIC_BASE_URL is unset and BROWSER_HOST_ADDRESS=localhost."
  echo "Clients will receive localhost noVNC URLs unless you set one of these values."
fi

if [[ "$BROWSER_PROVIDER" == "chromium" && -z "${BROWSER_RTP_TARGET_HOST:-}" && -z "${BROWSER_AUDIO_TARGET_HOST:-}" && -z "${BROWSER_VIDEO_TARGET_HOST:-}" && -z "${SFU_HOST:-}" ]]; then
  echo ""
  echo "Note: No explicit RTP target host override is set."
  echo "Ensure SFU sets PLAIN_TRANSPORT_ANNOUNCED_IP to a browser-host-reachable IP."
fi
