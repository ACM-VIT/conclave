# Staging stack

The `staging` branch gets its own copy of Conclave, so a change meets real
infrastructure before production:

- Web: Worker `conclave-web-staging` at `https://staging.conclave.acmvit.in`
  (`env.staging` in `apps/web/wrangler.jsonc`).
- SFU: one instance `sfu-staging` at `https://sfu-staging.acmvit.in`
  (`docker-compose.sfu-staging.yml`), with its own Redis, secret and state.

Deploys stay manual and script-driven. There is no GitHub Actions workflow.

## Where the staging SFU runs

| Option | Monthly cost (list price, USD) | Isolation |
| --- | --- | --- |
| **A. Third instance on the production VM** (recommended now) | $0 extra | Shares the D2als_v6 (2 vCPU, 4 GiB). Capped at 0.75 CPU and 768 MB, own Redis on :6380, own state dir and ports. |
| B. Second small VM, B2als_v2 (2 vCPU, 4 GiB) in Central India | about $24: VM $17.96, static IP $3.65, 32 GiB Standard SSD $2.64 | Full: nothing staging does can reach production. |
| C. Same as B with B1ms (1 vCPU, 2 GiB) | about $23 | Full, but too small to build the SFU image quickly. |

Prices are Azure pay-as-you-go rates for Central India from the Azure Retail
Prices API on 2026-11-22 (730 hours a month). Production's D2als_v6 costs
about $38 a month for comparison.

Start with A. Calls on production are few today, the caps keep a runaway
staging build from starving them, and it needs no new VM, IP or disk. Move to B
when staging is used for load tests or when the owner wants staging bugs
fully walled off. B uses the same compose file and runbook with a different
host.

What A shares, and why it is still safe:

- **CPU and memory**: capped by `cpus` and `mem_limit`. Building the staging
  image does use the host CPU for a few minutes, as production deploys
  already do.
- **Redis**: not shared. Redis pub/sub ignores the database number, so a
  staging SFU on production's Redis would join production's socket.io
  channels. Staging runs its own Redis container on 127.0.0.1:6380.
- **Disk**: `/var/lib/conclave-staging`, never the production state dir.
- **Ports**: HTTP 3033, RTC 42001-42200 (production uses 3031, 3032 and
  40000-42000). The WebRTC port budget is pinned to 4 in
  `docker-compose.sfu-staging.yml` and staging runs one worker, so WebRTC uses
  42001-42004 and 42005-42200 carries plain RTP from relay sources only. This
  is the firewall policy in `packages/sfu/README.md`; change the rules below,
  the compose file and that README together.
- **CPU**: staging pins one worker. Set `SFU_WORKER_HOST_INSTANCES=3` in
  production's `.env`, so `sfu-a` and `sfu-b` size their worker pools for three
  SFUs on the VM (`packages/sfu/README.md`).

## One-time setup (option A)

### 1. Azure network rules

```bash
RG=RG-CONCLAVE-SFU-PROD-CENTRALINDIA
NSG=nsg-conclave-sfu-prod-ci
# Set to the hosts that send plain RTP to the SFU, such as the shared
# browser. Never Internet or *. The relay rule refuses to run while it is empty.
RELAY_SOURCES=
# WebRTC: public UDP and TCP on the first SFU_WEBRTC_PORT_BUDGET ports only.
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-sfu-staging-webrtc-udp \
  --priority 150 --direction Inbound --access Allow --protocol Udp \
  --source-address-prefixes Internet --destination-port-ranges 42001-42004
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-sfu-staging-webrtc-tcp \
  --priority 155 --direction Inbound --access Allow --protocol Tcp \
  --source-address-prefixes Internet --destination-port-ranges 42001-42004
# Plain RTP: UDP from the relay sources only.
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-sfu-staging-relay-rtp \
  --priority 156 --direction Inbound --access Allow --protocol Udp \
  --source-address-prefixes "${RELAY_SOURCES:?set RELAY_SOURCES to the relay hosts}" \
  --destination-port-ranges 42005-42200
# Then deny the rest, before Azure's defaults: AllowVNetInBound (65000) would
# otherwise let any VNet host reach the relay range and the SFU's HTTP port,
# which only Caddy on this VM needs.
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n deny-sfu-staging-relay-others \
  --priority 157 --direction Inbound --access Deny --protocol '*' \
  --source-address-prefixes '*' --destination-port-ranges 42005-42200
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n deny-sfu-staging-http \
  --priority 158 --direction Inbound --access Deny --protocol Tcp \
  --source-address-prefixes '*' --destination-port-ranges 3033
```

### 2. DNS (Cloudflare, zone acmvit.in)

Add `sfu-staging` as an A record to 57.159.28.54, proxied, the same as
`sfu-a`. `staging.conclave.acmvit.in` is created by the Worker's custom domain
on its first deploy.

### 3. The staging checkout on the VM (as root, through run-command)

```bash
S=/home/azureuser/repos/conclave-staging
sudo -u azureuser -H git clone --branch staging https://github.com/ACM-VIT/conclave.git "$S"
# Redis's data sits beside the SFU's state dir, never inside it, so nothing
# that walks the state dir (a restore's ownership fix, a backup) touches it.
install -d -m 0755 /var/lib/conclave-staging /var/lib/conclave-staging-redis
STAGING_SFU_SECRET=$(openssl rand -hex 32)
STAGING_REDIS_PASSWORD=$(openssl rand -hex 24)
cat > "$S/.env" <<EOF
SFU_SECRET=${STAGING_SFU_SECRET}
ANNOUNCED_IP=57.159.28.54
STAGING_REDIS_PASSWORD=${STAGING_REDIS_PASSWORD}
REDIS_URL=redis://:${STAGING_REDIS_PASSWORD}@127.0.0.1:6380/0
SFU_REQUIRE_REDIS_ADAPTER=1
SFU_REGION=staging
SFU_STAGING_PUBLIC_URL=https://sfu-staging.acmvit.in
STAGING_STATE_DIR=/var/lib/conclave-staging
STAGING_REDIS_DIR=/var/lib/conclave-staging-redis
EOF
chown azureuser:azureuser "$S/.env" && chmod 0600 "$S/.env"
echo "staging SFU secret: ${STAGING_SFU_SECRET}"   # needed for the Worker secret below
# The reserved ports must cover staging's range too (packages/sfu/README.md
# reserves 40000-42200 for production and staging).
sysctl net.ipv4.ip_local_reserved_ports
```

Leave the AI, email and transcription keys out at first; those features stay
off on staging until their keys are added to this file.

### 4. Reverse proxy

Port 443 on the VM forwards `sfu-a.acmvit.in` to 127.0.0.1:3031. Find that
rule (`grep -rln 3031 /etc/caddy /etc/nginx 2>/dev/null`) and add the same
rule for `sfu-staging.acmvit.in` to 127.0.0.1:3033, including the WebSocket
upgrade, then reload the proxy. For Caddy that is:

```
sfu-staging.acmvit.in {
	reverse_proxy 127.0.0.1:3033
}
```

### 5. First SFU deploy

```bash
cd /home/azureuser/repos/conclave-staging
sudo -u azureuser -H bash -c 'SFU_COMPOSE_FILE=docker-compose.sfu-staging.yml ./scripts/deploy-sfu.sh'
curl -s https://sfu-staging.acmvit.in/health
```

The script starts staging's Redis, builds the image, and runs the canary call
against the new instance before it serves.

### 6. The staging Worker (from a workstation logged in to Cloudflare)

```bash
cd apps/web
pnpm exec wrangler r2 bucket create conclave-web-staging-opennext-cache
openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET --config wrangler.jsonc --env staging
pnpm exec wrangler secret put SFU_SECRET --config wrangler.jsonc --env staging   # paste the staging SFU secret
pnpm exec wrangler secret list --config wrangler.jsonc                           # production's secret names
```

Copy over only the production secrets staging needs (for example the Google
sign-in client). For sign-in, add
`https://staging.conclave.acmvit.in/api/auth/callback/google` to the OAuth
client's redirect URIs. Then deploy from the root of a clean `staging`
checkout:

```bash
cd ../..
./scripts/deploy-web-staging.sh
```

## Day to day

After pushing to `staging`:

- SFU, on the VM: `cd /home/azureuser/repos/conclave-staging && SFU_COMPOSE_FILE=docker-compose.sfu-staging.yml ./scripts/deploy-sfu.sh`
  (it pulls `staging`).
- Web, from the repo root on a workstation: `./scripts/deploy-web-staging.sh`.

When staging looks right, merge `staging` into `main` and deploy production as
usual. Staging data is disposable and is not backed up.

The native apps still talk to production; pointing a native build at staging
is follow-up work.
