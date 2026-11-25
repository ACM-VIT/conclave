# Nightly backups

The SFU VM holds the only copy of Conclave's durable data: scheduled meetings,
booking links and webinars. A systemd timer backs it up every night at 03:00
IST to Azure Blob Storage in another region.

## What is backed up

| Data | Where it lives | How it is copied |
| --- | --- | --- |
| Scheduled meetings, scheduling, webinars | Every `*.sqlite` under the state dir (`/var/lib/conclave/recordings`, the SFU volume), at any depth, and each store's own database: `SCHEDULING_SQLITE_PATH`, `SCHEDULED_MEETINGS_SQLITE_PATH` or `SCHEDULED_WEBINARS_SQLITE_PATH`, else `CONCLAVE_SQLITE_PATH`, else the compose default `conclave.sqlite`, as the host config and every SFU container's env set them | SQLite's online backup API (from Python, so no path passes through a shell), then `PRAGMA integrity_check`. Each keeps its path below the state dir. |
| Scheduled meetings and scheduling (Redis mode) | Host Redis, keys `conclave:sfu:persistence:*` | `redis-cli --rdb`: the server forks a fresh snapshot, the same way `BGSAVE` does, and streams it. The host's `redis-check-rdb` checks it when installed; when that rejects it (an older package than the live Redis), `redis:<live major.minor>` checks it in Docker, and only a rejection there fails the backup |
| Anything else in the state dir | JSON stores and similar files | A tar written in Python while the fence still holds |

SQLite and Redis are copied at one point in time. Before either copy, the
backup asks every SFU in `CONCLAVE_SFU_HEALTH_URLS` to hold its durable
writes (`POST /admin/persistence-fence`, `BACKUP_FENCE_HOLD_MS` 20 s by
default). Every persistence call on the SFU passes one gate. While it is
open, calls run side by side as they always did, so a slow Redis never holds
up a SQLite save. A hold closes it and answers once every call already under
way has finished; calls made during the hold queue and start in the order
they were made when it lifts, and each caller gets its own result or error.
The SFUs keep serving from memory, and media and signalling never wait on
it. The hold belongs to
the backup's random owner token: only that token renews or releases it, and
the SFU lifts it at its deadline, never later than 30 s after it was taken,
if the backup dies. The backup renews after the SQLite copies and again after
the Redis copy and the other files, which fails once an SFU restarted or its
hold lapsed, and
each copy must finish with at least 2 s of the hold left, compared in
milliseconds; such a night archives nothing.

Silence is not proof that an SFU writes nothing. Every SFU in the list must
hold the fence, or Docker must report the container on that URL's port
exited, dead or created; and every running container that can write the state
dir (a writable mount of it, of a dir above it or of one inside it) must be an
SFU that holds it: one with an `SFU_INSTANCE_ID`, the only running container
under that ID, listening on the port whose answer named it. Mounts are
matched on real paths, so a `CONCLAVE_STATE_DIR` that is a symlink to the
mounted directory works, and an SFU container with a mount that does not
resolve counts as running. When Docker cannot answer, or an SFU answers but will not
hold the fence (one from before the fence existed), the backup stops, so
deploy the SFU before turning backups on, and keep the health URLs on the
SFUs' local ports (`http://127.0.0.1:3031/health`). One backup or restore
runs at a time on the host (`flock` on `BACKUP_LOCAL_DIR/.backup.lock`); a
second one exits at once. Both also hold the host's deploy lock
(`/run/lock/conclave-sfu-deploy.lock`, the one `deploy-sfu.sh` takes) for
their whole run, so no deploy starts or replaces an SFU mid-copy; they wait
up to `BACKUP_DEPLOY_LOCK_WAIT_SECONDS` (900) for a deploy already under way,
then fail, and a deploy waits for them the same way. The deploy lock is a
regular file no other user can open (0640, group `docker`), made and checked
by `scripts/host_lock.py` for all three scripts: one that is a link, or owned
by anyone but root, the running user or a `docker` member, is refused, and
one an older script made for every user is given the `docker` group
(`SFU_DEPLOY_LOCK_GROUP` overrides the name) and narrowed by its owner. The Docker
check runs again after every copy, even when no SFU holds the fence.

A backup is complete or it fails, with no archive and no heartbeat: a
missing state dir fails it, and so does a missing database a store opens, a
directory it cannot list, or a database whose name leaves no room for
SQLite's `-wal`, `-shm` and `-journal` files, even when Redis alone could be
copied. Each expected source (that
database, and Redis when configured) must be in the payload before it is
encrypted, and the encrypted file is checked before the job keeps it. The
other files go in as files and directories only, hard links stored whole (as
`tar --hard-dereference` does), with any other link, special file, database or
SQLite side file left out (the first two logged). A side file is one beside a
database file itself: SQLite resolves links when it opens a database and keeps
its `-wal`, `-shm` and `-journal` beside the real file, so a file named after a
link (`current-journal` beside a `current -> data` link) is an ordinary file
and is backed up like one; and the restore's own
checks run over the payload, so a
backup that would not restore fails and the previous archives stay. Only
then are older local archives rotated, and the newest is always kept, so a
bad night never pushes out the last complete backup.

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
apt-get update && apt-get install -y age redis-tools psmisc util-linux python3
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

Every store's database (`CONCLAVE_SQLITE_PATH`, or a store's own
`SCHEDULING_SQLITE_PATH`, `SCHEDULED_MEETINGS_SQLITE_PATH` or
`SCHEDULED_WEBINARS_SQLITE_PATH`, in the repo `.env` or an SFU container's
env, each store's precedence applied) must point inside the state dir. A
store whose `SCHEDULING_PERSISTENCE`, `SCHEDULED_MEETINGS_PERSISTENCE` or
`SCHEDULED_WEBINARS_PERSISTENCE` is `json` or `file` (trimmed, any case, as
the SFU reads it) opens no database, so none is required for it. It keeps
its records in one file, `SCHEDULING_PATH`, `SCHEDULED_MEETINGS_PATH` or
`SCHEDULED_WEBINARS_PATH`, which must be set and lie inside the state dir: the
SFU's default (`data/<store>.json` under its working directory) is inside the
container, not on the volume, so the backup and the restore refuse it. The
file is backed up with the rest of the state dir. An SFU
container is one whose env sets `SFU_INSTANCE_ID`, the rule the deploy uses to
pick its SFU services; another container on the state dir (a maintenance one,
say) neither chooses the stores nor stops a backup, though any running
container that can write the state dir still does. A
container's path is read through that container's own mounts, so a store
kept under a mount of a dir above the state dir (`/srv/conclave` at
`/var/lib/conclave`, the state dir `/srv/conclave/recordings`) counts too. An
SFU container that mounts another host dir inside its view of the state dir
(say `/srv/other` at `/var/lib/conclave/recordings/data`) opens files the
backup cannot see there, so the backup and the restore refuse that layout. A path outside the volume lives inside
the container and is lost on every deploy, so the backup fails until it is
moved. Each gets the online backup whatever it is named (`live.db` as much as
`conclave.sqlite`). If it is reached through links, the file they reach is
backed up once, and every link on the way is recorded relative
(`conclave.sqlite -> data/live.db`, whether it was written with the
container's path, the host's or `..` steps) with the directories it passes,
so a restore into any dir rebuilds the same chain; a link to a file outside
the state dir fails the backup.

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
   `restore.sh` only downloads and decrypts the archive and takes the locks.
   Everything that touches what is inside it runs in
   `scripts/backup/restore_state.py`, and nothing from the archive passes
   through a shell:
   - It reads the archive into a private work dir (root's, 0700, outside the
     state dir): plain relative names only (no absolute name, no `..`, no
     control characters), regular files and directories only, nothing
     followed, and a `SHA256SUMS` that names every other file exactly once
     and nothing else. Then it checks the payload with the rules the backup
     ran: every database listed once, nothing under a recorded link, no SQLite
     side file among the other files, no path twice or under two spellings
     that differ only in case, and every recorded chain, rebuilt from the
     archive alone, reaching its database.
   - It checks the live state dir: every directory on the way to a write is a
     real directory on the state dir's file system (a link, a file or a mount
     point there refuses the restore), nothing it replaces is a directory, and
     every chain still reaches its database with the restore laid over what
     is there. It refuses while an SFU answers, while any running container
     mounts the state dir or a dir above or inside it, or while a process
     holds a database open.
   - Every store's database, by its own precedence (its own variable, else
     `CONCLAVE_SQLITE_PATH`, else the compose default, from this host's config
     and every SFU container's env), must be in the archive; one it lacks
     would come back empty, so the restore refuses unless `--only` leaves
     SQLite out. With Redis configured, the archive must hold a Redis
     snapshot (or `--only sqlite,files` leaves Redis out), the live Redis
     must answer and take the URL's credentials, and the snapshot must load
     into a throwaway server: this host's `redis-server`, else the live
     server's version in Docker when the host's cannot read it. The snapshot
     is read from the database it was taken from, which the backup records,
     and written into the one the target URL names, so a drill into another
     database restores the same keys. All of this is settled before the first rename,
     so a Redis that is down, refuses the password or cannot load the dump
     changes nothing.
   - It builds the whole restored tree in a root-only staging dir beside the
     state dir, on the same file system, then moves each entry in by rename
     between open directories. What an entry replaces moves into
     `<state dir>.pre-restore-<stamp>` beside the state dir, under its own
     name, together with a live database's `-wal`, `-shm` and `-journal`, so a
     stale journal never replays onto the restored copy. Any failure from the
     first rename on undoes every rename. So does a SIGTERM, SIGHUP or SIGINT
     (a closed SSH session, a stopped command): during the renames it is held
     until the next safe point, then every rename is undone and the restore
     exits with an error; one that comes after the last rename leaves the
     restored files and stops the restore there. A populated dir restores the same as
     an empty one, and a lost state dir is the staging tree renamed into place.
   - The state dir's parent must be writable by its owner alone, and the state
     dir must not be a mount point of its own: the restore keeps its staging
     copy in that parent and renames from it. Put a dedicated volume one level
     up (`/var/lib/conclave` rather than `.../recordings`), or restore into a
     new dir and move it.
   The Redis is the one the SFU uses, picked by the SFU's own rule:
   `SFU_PERSISTENCE_REDIS_URL`, else `SFU_REDIS_URL`, else `REDIS_URL`, each
   trimmed first, so a blank value falls through to the next as it does for
   the SFU (the backup suite checks both rules agree over a table of settings).
   Every SFU container that mounts the state dir and names a Redis of its own
   (staging builds its URL in its compose file) must name the same Redis and
   key prefix as the backup config, or the backup and the restore both stop
   before anything is read or written; set `SFU_PERSISTENCE_REDIS_URL` (and
   the prefix) in the backup config to that Redis as this host reaches it.
   The Redis keys
   under the SFU's persistence prefix (`conclave:sfu:persistence:*`, or the
   `SFU_PERSISTENCE_REDIS_KEY_PREFIX` the SFU reads, trimmed and without
   trailing colons as the SFU makes it) end up exactly as in the backup: those
   it has are restored, and those it lacks are deleted, so a meeting created
   after the backup cannot outlive the restore. Other keys, such as room
   leases, are left alone. `--redis-pattern '*'` makes the whole database match
   the backup. A TLS (`rediss://`) Redis is refused before anything changes;
   use `--only sqlite,files` there.
   The entries the restore creates, and only those, go to the user the SFU
   runs as, each through its own fd as it is made (a file that gains a second
   name is refused); what was already in the state dir keeps its owner.
   Without a setting, `restore.sh` reads that user from the stopped SFU
   containers that mount the state dir (then those that mount a dir above or
   inside it) and resolves its uid and gid inside their image; a lost state
   dir is matched by its path. Today's image runs as
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
the way to a database (`conclave.sqlite -> current -> live.db`), and the
directories they pass, belong to the SQLite part: `--only sqlite` brings back
the whole chain, and `--only files` installs none of it. `--latest` and the local retention order archives by the
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
