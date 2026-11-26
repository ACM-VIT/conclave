# Shared Browser Service

This service provides per-room shared browser sessions. It supports the existing
self-hosted Chromium/noVNC runtime and Cloudflare Kitesurf Browser Run sessions.

## Kitesurf + @Conclave Browser Tool

Kitesurf normally runs directly inside each SFU process. It calls Cloudflare
Browser Run over HTTPS, so no `browser-service` process, browser VM, Docker
socket, noVNC port, or locally running browser is required. Configure the SFU
with:

```bash
SFU_BROWSER_BACKEND=kitesurf
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_BROWSER_RUN_TOKEN=<browser-run-edit-token>
```

`SFU_BROWSER_BACKEND=auto` is the default: the SFU selects embedded Kitesurf
when both Cloudflare credentials are present and otherwise falls back to
`BROWSER_SERVICE_URL`. Set `SFU_BROWSER_BACKEND=chromium` (or `service`) to
explicitly use the standalone Chromium service.

The service creates a Browser Run CDP session, returns a signed interactive Live
View URL to meeting clients, and keeps it alive through the existing 30-second
meeting activity heartbeat. API credentials remain server-side.

The existing `@Conclave` chat assistant can inspect and control this shared
browser through the SFU's authenticated internal endpoints. Tool selection is
automatic, and browser work stays in the meeting chat instead of creating a
second agent panel or command surface. The assistant's normal web runtime owns
its model configuration; the SFU does not run a separate browser-agent loop.

Kitesurf does not provide browser audio/video playback or full Chromium site
compatibility. Keep `BROWSER_PROVIDER=chromium` for media, WebGL, persistent
authenticated sessions, and sites that reject automated browsers.

## Deploy Chromium On A Separate VM

Run this on the browser VM:

```bash
cd /path/to/conclave
./scripts/deploy-browser-service.sh
```

The script builds `browser-service` and `conclave-browser:latest`. This
deployment is only needed for full Chromium compatibility, media, and noVNC.
Before it replaces the running service, it runs the new image with
`--check-config`, which runs the same startup path as the service (settings,
provider setup and a bind check on `BROWSER_SERVICE_HOST`) short of listening
on the real port; `--check-config` on the script stops there.

and starts `browser-service` using `docker-compose.browser.yml`.

## Chromium SFU Configuration (on SFU host)

Set these environment variables for each SFU instance:

- `BROWSER_SERVICE_URL=http://<browser-vm-private-ip>:3040`
- `PLAIN_TRANSPORT_ANNOUNCED_IP=<public-or-routable-sfu-ip>`
- `BROWSER_SERVICE_TOKEN=<shared-secret>` (required, the same value as the browser VM)

`PLAIN_TRANSPORT_ANNOUNCED_IP` is only needed in Chromium mode and must be
reachable from the browser VM so RTP can reach the SFU.

## Chromium Browser VM Environment

These are read from root `.env` (or current shell env):

- `BROWSER_SERVICE_TOKEN` (required; at least 32 random characters, for example
  `openssl rand -hex 32`. The service refuses to start without it.)
- `BROWSER_SERVICE_HOST` (default `127.0.0.1`; set the private address the SFU
  reaches when the SFU runs on another VM. Public and wildcard addresses are
  refused.)
- `BROWSER_SERVICE_CORS_ORIGINS` (optional comma-separated web origins allowed
  to call the control API from a browser; none by default because the SFU calls
  it server to server)
- `BROWSER_SERVICE_PORT` (default `3040`; a bare number, the service refuses padding or other text)
- `BROWSER_PROVIDER` (`chromium` by default; standalone Kitesurf remains
  supported for backwards compatibility)
- `NOVNC_PORT_START` / `NOVNC_PORT_END` (defaults `6080`-`6100`)
- `NOVNC_BIND_ADDRESS` (default `0.0.0.0`; use `127.0.0.1` when a reverse proxy
  on the same host serves `BROWSER_PUBLIC_BASE_URL`)
- `BROWSER_PUBLIC_BASE_URL` (recommended for public/proxied noVNC URLs)
- `BROWSER_HOST_ADDRESS` (used if `BROWSER_PUBLIC_BASE_URL` is unset)
- `BROWSER_RTP_TARGET_HOST` (optional override for RTP destination host)
- `BROWSER_AUDIO_TARGET_HOST` / `BROWSER_VIDEO_TARGET_HOST` (optional per-media overrides)
- `SFU_HOST` (legacy alias for RTP target host)
- `CLOUDFLARE_ACCOUNT_ID` (required for Kitesurf)
- `CLOUDFLARE_BROWSER_RUN_TOKEN` (required for Kitesurf)
- `KITESURF_KEEP_ALIVE_MS` (defaults to Cloudflare's maximum `600000`)
- `KITESURF_VIEWPORT_WIDTH` / `KITESURF_VIEWPORT_HEIGHT` (default `1920x1080`)

If `BROWSER_PUBLIC_BASE_URL` is unset and `BROWSER_HOST_ADDRESS=localhost`, clients will receive localhost noVNC links.

Each Chromium session gets a random VNC password. The service puts it in the
URL fragment of the noVNC link it returns to the SFU, so only that room's
participants receive it and it never reaches proxy logs. The runtime image
refuses to start a display without a password, so rebuild
`conclave-browser:latest` (the default in `deploy-browser-service.sh`) whenever
you update the service.

The fragment keeps the password out of requests, not out of reach of whoever
can rewrite the noVNC page in transit. For access from the internet, serve noVNC
through an HTTPS reverse proxy and set `BROWSER_PUBLIC_BASE_URL` to it. Without
it the service hands out plain `http://` links. When the proxy runs on the same
host, set `NOVNC_BIND_ADDRESS=127.0.0.1` so the noVNC ports are reachable only
through it.

## Network / Firewall Checklist

In Chromium mode, open between Browser VM and SFU VM:

- SFU RTP/RTCP UDP range: `RTC_MIN_PORT`-`RTC_MAX_PORT` (from SFU env)

Open to clients for browser access in Chromium mode:

- Browser service API: `BROWSER_SERVICE_PORT` (default `3040`) from SFU host(s)
  only, over a private network
- noVNC TCP range: `NOVNC_PORT_START`-`NOVNC_PORT_END` (default `6080`-`6100`),
  only when no HTTPS proxy fronts noVNC. Public deployments should open the
  proxy's HTTPS port instead.

Kitesurf Live View is hosted by Cloudflare over HTTPS, so clients do not need
access to a noVNC port range.

## Local Single-Host Mode

If you still want colocated deployment:

```bash
./scripts/deploy-sfu.sh --with-browser-local
```
