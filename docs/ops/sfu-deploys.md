# SFU deploys: drain, canary, rollback

`scripts/deploy-sfu.sh` deploys the SFU instances on one host without cutting
a call. It builds one image for the pulled commit, then takes the instances one
at a time, emptiest first:

1. Mark the instance draining. New meetings go to the other instance; meetings
   already on this one continue.
2. Wait until its rooms reach 0, up to `DRAIN_TIMEOUT_SECONDS` (3600). There is
   no force drain unless you pass `--force-drain`.
3. Recreate it from the new image, and drain it again as soon as it answers, so
   no new meeting lands on it yet.
4. Run the canary: a real two-person call against that instance
   (`packages/sfu/scripts/canary-call.ts`, run from the new image). Two clients
   join a room, publish Opus audio and must receive each other's RTP through
   the SFU, and the room must close when they leave.
5. Canary passed: put the instance back into rotation and move to the next one.
   Canary failed: recreate the instance from the image it ran before, stop,
   and exit 4. The instances not yet touched were never drained and keep
   serving.

An instance already running the target image and config is skipped, so a
rerun only does what is left.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Every instance is on the new commit and passed its canary. | Nothing. |
| 3 | A meeting outlasted the drain deadline. That instance was put back into service untouched. | Rerun later. Instances already deployed are skipped. |
| 4 | The canary failed. The instance is back on its previous image. | Read the canary lines in the log, fix forward, deploy again. |
| 1 | Anything else (preflight, build, Docker). | Read the log. |

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

- The new container answers for about a second before the script drains it, so
  a meeting created in that second can land on an unverified build. If the
  canary then fails, that meeting is cut by the rollback.
- The canary reaches the transports on loopback, so it proves the media path
  inside the SFU, not the public UDP route. The preflight and the NSG rules
  cover that route.
- A rollback reuses the current checkout's compose file. A release that changed
  `docker-compose.sfu.yml` is rolled back to the old image with the new
  container config.
- `scripts/deploy-sfu.ps1` does not have the canary; the VM runs the bash
  script.
