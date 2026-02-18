# Shared Browser Service

This service launches per-room Chromium containers and exposes noVNC URLs for the Conclave shared browser feature.

## Deploy On A Separate VM

Run this on the browser VM:

```bash
cd /path/to/conclave
./scripts/deploy-browser-service.sh
```

The script builds:
- `conclave-browser:latest` (runtime image for session containers)
- `browser-service` (control plane API from `packages/shared-browser`)

and starts `browser-service` using `docker-compose.browser.yml`.

## Required SFU Configuration (on SFU host)

Set these environment variables for each SFU instance:

- `BROWSER_SERVICE_URL=http://<browser-vm-ip>:3040`
- `PLAIN_TRANSPORT_ANNOUNCED_IP=<public-or-routable-sfu-ip>`
- `BROWSER_SERVICE_TOKEN=<shared-secret>` (recommended)

`PLAIN_TRANSPORT_ANNOUNCED_IP` must be reachable from the browser VM so RTP from Chromium containers can reach the SFU.

## Browser VM Environment

These are read from root `.env` (or current shell env):

- `BROWSER_SERVICE_PORT` (default `3040`)
- `NOVNC_PORT_START` / `NOVNC_PORT_END` (defaults `6080`-`6100`)
- `BROWSER_PUBLIC_BASE_URL` (recommended for public/proxied noVNC URLs)
- `BROWSER_HOST_ADDRESS` (used if `BROWSER_PUBLIC_BASE_URL` is unset)
- `BROWSER_SERVICE_TOKEN` (token expected by control endpoints)
- `BROWSER_RTP_TARGET_HOST` (optional override for RTP destination host)
- `BROWSER_AUDIO_TARGET_HOST` / `BROWSER_VIDEO_TARGET_HOST` (optional per-media overrides)
- `SFU_HOST` (legacy alias for RTP target host)

If `BROWSER_PUBLIC_BASE_URL` is unset and `BROWSER_HOST_ADDRESS=localhost`, clients will receive localhost noVNC links.

## Network / Firewall Checklist

Open between Browser VM and SFU VM:

- SFU RTP/RTCP UDP range: `RTC_MIN_PORT`-`RTC_MAX_PORT` (from SFU env)

Open to clients for browser access:

- Browser service API: `BROWSER_SERVICE_PORT` (default `3040`) from SFU host(s)
- noVNC TCP range: `NOVNC_PORT_START`-`NOVNC_PORT_END` (default `6080`-`6100`)

## Local Single-Host Mode

If you still want colocated deployment:

```bash
./scripts/deploy-sfu.sh --with-browser-local
```
