# SFU deploys: drain, canary, rollback

`scripts/deploy-sfu.sh` deploys the SFU instances on one host without cutting
a call. It pulls, restarts itself if the pull changed the script (bash would
otherwise keep running the old file), and runs the pulled revision's own
config-only preflight against the rendered compose env, stopping (exit 1)
before anything is built if it fails or reports no result. The preflight runs
the same through a symlinked checkout, and a run it cannot recognize as its
own fails rather than passing. Then it builds one image for the commit
or reuses the one already built for it, and takes the instances one at a time.
The order puts first the instances that take no new meetings anyway (one
whose container is down, then one already draining), then the serving ones,
emptiest first. An instance whose `/status` cannot be read goes last, so an
idle instance is always rebuilt before one that may carry calls. No instance
is recreated while it has rooms unless you pass `--force-drain`:

1. Check that every other instance is serving: healthy and not draining. If
   one is not, the deploy stops (exit 1) before this drain, because new
   meetings would have nowhere to go. An instance that is down is deployed
   first for that reason, and if its new container never gets healthy the
   deploy stops with exit 4 before anything is drained.
2. Mark the instance draining. New meetings go to the other instance; meetings
   already on this one continue.
3. Wait until its rooms reach 0, up to `DRAIN_TIMEOUT_SECONDS` (3600), and
   for at least `PLACEMENT_SETTLE_SECONDS` (25) after the drain. A placement
   reserved just before the drain can still open a room for up to 20 s, so 0
   rooms only counts once those have expired. An unreadable `/status` counts
   as unknown, not as empty. There is no force drain unless you pass
   `--force-drain`.
4. Recreate it from the new image with `SFU_START_DRAINING=true`, so it boots
   out of rotation and no meeting can land on an unverified build.
5. Run the canary: a real two-person call against that instance
   (`packages/sfu/scripts/canary-call.ts`, run from the new image). It takes
   its room through the secret-protected placement endpoint with
   `allowDraining`, the one placement a draining instance grants. Two clients
   join, publish Opus audio and must receive each other's RTP through the SFU,
   and the room must close when they leave.
6. Canary passed: check that no other call reached the instance while it was
   out of rotation, then recreate it once more from the same image with the
   normal config, so it serves undrained and stays that way across restarts.
   Its public URL must then reach it within `HEALTH_TIMEOUT_SECONDS` (120);
   if not, the deploy stops (exit 1) before the next drain. If a call did
   reach it, the deploy waits for that
   call like a drain, and at the deadline exits 3 with the instance still
   drained on the new image. Canary failed: recreate the instance from the
   image it ran before, stop, and exit 4. The instances not yet touched were
   never drained and keep serving.

An instance that is serving, undrained, on the target image and config is
skipped, so a rerun only does what is left. An instance that answers HTTP but
whose `/status` cannot be read is left alone (exit 1), because its rooms are
unknown. So is one whose container is running while nothing answers at its
URL (exit 1): a wrong `SFU_A_URL` or proxy can hide calls. Fix the URL, or stop
the container if it is hung, and rerun.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Every instance is on the new commit and passed its canary. | Nothing. |
| 3 | A meeting outlasted the drain deadline. That instance was put back into service untouched, or, if the call reached it after its canary, left drained on the new image. | Rerun later. Instances already deployed are skipped. |
| 4 | The canary failed. The instance is back on its previous image. | Read the canary lines in the log, fix forward, deploy again. |
| 1 | Another instance is not serving, a public URL does not reach its instance, or anything else (preflight, build, Docker). Nothing after the failing step was drained. | Read the log. |

During an exit 3 or 4 the two instances can run different commits. That is the
same mixed state every blue-green deploy passes through, and the SFU tolerates
it.

## Rollback of a released version

Each fully deployed release is recorded in
`~/.local/state/conclave-sfu-deploy/<project>.env` and tagged
`<project>-sfu:last-good`. The release before it is tagged
`<project>-sfu:previous-good`. When a bug gets past the canary:

```bash
./scripts/deploy-sfu.sh --rollback
```

This runs the same drain and canary steps with the previous good image instead
of a build, so it needs no `git` change and takes minutes. It goes back one
release only. Afterwards, revert the bad commit on `main` before the next
deploy, because a normal deploy builds whatever `main` holds.

`--rollback` is available after two releases have gone out with this script.
Before that, revert and deploy.

## Running it on the VM

Before the first deploy with this script, run `./scripts/deploy-sfu.sh
--preflight-only`. It checks the same public routes the deploy now requires,
without changing anything.

Run it as before: as `azureuser` in the repo, under `nohup` with a log file.
The log ends with `SFU deploy complete`, `Deploy paused` (exit 3) or
`Deploy stopped` (exit 4).

## Test it locally

The rig used for the PR runs the real script against two instances in Docker
on spare ports. Point a scratch clone's `.env` at those ports with
`SFU_A_PORT`, `SFU_B_PORT` and `SFU_A/B_RTC_MIN/MAX_PORT`, which default to
production's values. To hold a call open during a deploy, run the canary with
`--hold-ms`:

```bash
docker run --rm --network host -e SFU_SECRET --entrypoint node <image> \
  --import tsx scripts/canary-call.ts --url http://127.0.0.1:3031 --hold-ms 600000
```

It fails if either side goes more than 2 s without audio or is disconnected.

## Known limits

- The canary reaches the transports on loopback, so it proves the media path
  inside the SFU, not the public UDP route. The preflight and the NSG rules
  cover that route.
- A rollback reuses the current checkout's compose file. A release that changed
  `docker-compose.sfu.yml` is rolled back to the old image with the new
  container config.
- `scripts/deploy-sfu.ps1` does not have the canary; the VM runs the bash
  script.
