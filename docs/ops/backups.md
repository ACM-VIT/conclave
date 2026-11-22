# Nightly backups

The SFU VM holds the only copy of Conclave's durable data: scheduled meetings,
booking links and webinars. A systemd timer backs it up every night at 03:00
IST to Azure Blob Storage in another region.

## What is backed up

| Data | Where it lives | How it is copied |
| --- | --- | --- |
| Scheduled meetings, scheduling, webinars | Every `*.sqlite` under the state dir (`/var/lib/conclave/recordings`, the SFU volume), at any depth | SQLite online backup (`.backup`), then `PRAGMA integrity_check`. Each keeps its path below the state dir. |
| Scheduled meetings and scheduling (Redis mode) | Host Redis, keys `conclave:sfu:persistence*` | `redis-cli --rdb`: the server forks a fresh snapshot, the same way `BGSAVE` does, and streams it |
| Anything else in the state dir | JSON stores and similar files | `tar` |

SQLite and Redis are copied at one point in time. Before either copy, the
backup asks every SFU in `CONCLAVE_SFU_HEALTH_URLS` to hold its durable
writes (`POST /admin/persistence-fence`, at most 30 s, `BACKUP_FENCE_HOLD_MS`
20 s by default); the SFUs keep serving from memory, and the held writes land
when the backup releases the fence or at its timeout. An SFU that does not
answer is not running and writes nothing. One that answers but will not hold
the fence, such as an SFU from before the fence existed, stops the backup, so
deploy the SFU before turning backups on.

Each archive also holds a `MANIFEST` (row counts per table, Redis key count,
repo commit) and `SHA256SUMS`. The archive is encrypted with
[age](https://age-encryption.org) to a public key. The VM can write backups
but cannot read them; the private key stays with the owner.

Not included: the `.env` files (keep them in the password manager) and the
in-container JSON fallback files, which only exist when SQLite fails to open.

## Layout and retention

Container `sfu-backups` in storage account `stconclavebackupsi`
(South India, so a Central India outage cannot take both):

- `daily/YYYY/MM/conclave-<host>-<stamp>.tar.gz.age`, deleted after 30 days.
- `monthly/YYYY-MM/...`, the first good backup of each month, deleted after
  365 days.

`scripts/backup/lifecycle-policy.json` holds both rules. Blob soft delete keeps
deleted blobs for 14 more days. The VM keeps its newest 3 archives in
`/var/backups/conclave` for quick restores. Expected cost is well under
$0.10 a month: archives are a few MB, at $0.024 per GB-month.

## One-time setup

Run these from an admin workstation with `az` logged in. Nothing here touches
the running SFUs.

```bash
RG=RG-CONCLAVE-SFU-PROD-CENTRALINDIA
VM=vm-conclave-sfu-prod-ci-01
BRG=rg-conclave-backups-southindia
SA=stconclavebackupsi

# 1. Give the VM a managed identity (it has none today).
az vm identity assign -g "$RG" -n "$VM"
PRINCIPAL=$(az vm show -g "$RG" -n "$VM" --query identity.principalId -o tsv)

# 2. Storage account in another region, Entra ID auth only.
az group create -n "$BRG" -l southindia --tags app=conclave environment=production surface=backups
az storage account create -n "$SA" -g "$BRG" -l southindia --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false --allow-shared-key-access false \
  --tags app=conclave environment=production surface=backups
az storage account blob-service-properties update -n "$SA" -g "$BRG" \
  --enable-delete-retention true --delete-retention-days 14 \
  --enable-container-delete-retention true --container-delete-retention-days 14
az storage container-rm create --storage-account "$SA" -g "$BRG" -n sfu-backups
az storage account management-policy create --account-name "$SA" -g "$BRG" \
  --policy @scripts/backup/lifecycle-policy.json

# 3. Let only the VM write to that one container.
SCOPE="$(az storage account show -n "$SA" -g "$BRG" --query id -o tsv)/blobServices/default/containers/sfu-backups"
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" --scope "$SCOPE"
```

Make the encryption key on your own machine, never on the VM:

```bash
age-keygen -o conclave-backup.key   # prints "Public key: age1..."
```

Store `conclave-backup.key` in the password manager. Only the public key goes
to the VM.

Install on the VM (through `az vm run-command invoke ... --scripts @file.sh`,
as root):

```bash
apt-get update && apt-get install -y age sqlite3 redis-tools psmisc
install -d -m 0700 /etc/conclave /var/backups/conclave
echo "age1...your public key..." > /etc/conclave/backup-recipients.txt
R=/home/azureuser/repos/conclave
install -m 0600 "$R/scripts/backup/backup.env.example" /etc/conclave/backup.env
install -m 0644 "$R/scripts/backup/conclave-backup.service" "$R/scripts/backup/conclave-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl start conclave-backup.service      # first run, by hand
journalctl -u conclave-backup -n 40 --no-pager
systemctl enable --now conclave-backup.timer
systemctl list-timers conclave-backup.timer
```

`CONCLAVE_SQLITE_PATH` in the repo `.env` (if set) must point inside the
state dir. A path outside the volume lives inside the container and is lost on
every deploy, so the backup fails until it is moved. The configured database
gets the online backup whatever it is named (`live.db` as much as
`conclave.sqlite`). If it is a symlink, the
file it reaches is backed up once and the link is recreated on restore; a link
to a file outside the state dir fails the backup the same way.

If the upload fails, the encrypted archive stays in `/var/backups/conclave`,
the job fails, and the heartbeat is not sent. The newest
`BACKUP_LOCAL_KEEP` (3) archives are kept either way, so failed nights cannot
fill the disk.

For alerts on a missed night, create a free healthchecks.io check with a
1-day period and put its ping URL in `BACKUP_HEARTBEAT_URL`.

## Restore

`restore.sh` downloads, decrypts and verifies first. Without `--yes` it
changes nothing.

```bash
R=/home/azureuser/repos/conclave
sudo $R/scripts/backup/restore.sh --list
# Copy the private key to the VM for the restore only (mode 0600), then:
sudo $R/scripts/backup/restore.sh --identity /root/conclave-backup.key --latest
```

To apply it:

1. Stop new work: drain both SFUs and wait for 0 rooms, as the deploy does.
2. `cd $R && docker compose -f docker-compose.sfu.yml stop sfu-a sfu-b`
3. `sudo $R/scripts/backup/restore.sh --identity /root/conclave-backup.key --latest --yes`
   It refuses while an SFU answers or any process holds a database open. The
   current databases are kept as `*.pre-restore-<stamp>`. The Redis keys
   matching `conclave:sfu:persistence*` end up exactly as in the backup: those
   it has are restored, and those it lacks are deleted, so a meeting created
   after the backup cannot outlive the restore. Other keys, such as room
   leases, are left alone. `--redis-pattern '*'` makes the whole database match
   the backup. A TLS (`rediss://`) Redis is refused before anything changes;
   use `--only sqlite,files` there.
   The restored files go to the user the SFU runs as. Without a setting,
   `restore.sh` reads it from the stopped SFU containers that mount the state
   dir and resolves its uid and gid inside their image. Today's image runs as
   root, so the files stay root's. Once the SFU image runs as `node` (#272),
   they go to `node`. If the containers are gone, pass `--owner 1000:1000`
   (`node` in the Node image) or set `BACKUP_RESTORE_OWNER` in
   `/etc/conclave/backup.env`. The owner is resolved to numeric ids and
   checked before anything is replaced: only root can give files to another
   user, and a name that does not resolve fails the restore up front.
4. `docker compose -f docker-compose.sfu.yml up -d sfu-a sfu-b`
5. Check the scheduled meetings and webinars, then `shred -u /root/conclave-backup.key`.

Use `--blob daily/2026/11/<name>` or `--file <path>` for an older backup and
`--only sqlite`, `--only redis` or `--only files` for part of one. The links on
the way to a database (`conclave.sqlite -> current -> live.db`) belong to the
SQLite part: `--only sqlite` brings back the whole chain, and `--only files`
installs none of it. `--latest` and the local retention order archives by the
timestamp in their names, so a renamed host never makes an older one look
newer.

## Restore drill

A backup that has never been restored is not a backup.

- Monthly: run `restore.sh --identity ... --latest` without `--yes`. It
  downloads, decrypts, checks every checksum and runs SQLite's integrity check,
  then prints the manifest. Compare the row counts with the previous month.
- Quarterly: restore into scratch space instead of production. Copy
  `/etc/conclave/backup.env` to `/root/drill.env`, set `CONCLAVE_STATE_DIR` to
  an empty directory and `SFU_PERSISTENCE_REDIS_URL` to a throwaway Redis
  (`docker run -d --rm --name drill-redis -p 127.0.0.1:6390:6379 redis:7.2`),
  run `BACKUP_CONFIG=/root/drill.env restore.sh ... --yes`, and count the
  restored rows and keys. Delete the scratch data afterwards: it is real user
  data.
