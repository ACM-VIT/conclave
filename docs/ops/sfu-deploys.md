# SFU deploys: drain, canary, rollback

`scripts/deploy-sfu.sh` deploys the SFU instances on one host without cutting
a call or leaving fewer instances serving than it found; anything it cannot
read counts as busy. One deploy runs at a time per host: it takes a lock
(`flock` on `/run/lock/conclave-sfu-deploy.lock`, or `SFU_DEPLOY_LOCK_FILE`)
for the whole run. A host job that must not overlap a deploy, such as the
nightly backup, can hold the same lock, so no deploy starts or replaces an SFU
under it. A deploy that finds the lock
taken waits up to `SFU_DEPLOY_LOCK_WAIT_SECONDS` (120) and then exits 1
without changing anything. The kernel drops the lock
when the run exits, however it exits. A host without `flock` (util-linux, on
the VM already) is refused before anything changes. If an interrupted run left
every instance drained, it first puts the healthy ones that were drained while
serving back into service. It pulls, restarts itself if the pull changed the script (bash would
otherwise keep running the old file), and runs the pulled revision's own
config-only preflight over every service, whatever `SFU_DEPLOY_SERVICES`
selects, against the rendered compose env, stopping (exit 1)
before anything is built if it fails or reports no result. The preflight runs
the same through a symlinked checkout, and a run it cannot recognize as its
own fails rather than passing. Then it builds one image for the commit
or reuses the one already built for it, and takes the instances one at a time.
The build goes under its own tag (`<project>-sfu:<commit>-candidate`), never
a service's compose image: each instance's image moves to it only after that
instance drained, right before its canary, so a deploy paused by a call
leaves nothing untested for a later `compose up` to start.
The order puts first the instances that take no new meetings anyway (one
whose container is down, then one already draining), then the serving ones,
emptiest first. An instance whose `/status` cannot be read goes last, so an
idle instance is always rebuilt before one that may carry calls. No instance
is recreated while it has rooms unless you pass `--force-drain` (its
`--force-drain-notice-ms`, 4000 by default, is at most 30000, the longest
notice the SFU gives; the drain request waits that long for the SFU's answer):

1. Check that every other instance is serving: healthy, a readable `/status`
   that says it is not draining (`/health` stays healthy while an instance
   drains, so a status that cannot be read counts as unsafe), and a public URL
   that reaches it. Every instance counts, deployed in this run or not. Every
   `/status` read checks the `instanceId` it answers with, so a management URL
   that reaches another instance is refused rather than trusted. If one
   is not, the deploy stops (exit 1) before this drain, because new meetings
   would have nowhere to go. An instance that is down is deployed
   first for that reason, and if its new container never gets healthy the
   deploy stops before anything is drained: exit 4 when the instance is back
   on the image it last served calls on, exit 5 when it has none and stays
   stopped.
2. Mark the instance draining. New meetings go to the other instance; meetings
   already on this one continue.
3. Wait until its rooms reach 0, up to `DRAIN_TIMEOUT_SECONDS` (3600), and
   for at least `PLACEMENT_SETTLE_SECONDS` (25) after the drain. A placement
   reserved just before the drain can still open a room for up to 20 s, so 0
   rooms only counts once those have expired. An unreadable `/status` counts
   as unknown, not as empty. There is no force drain unless you pass
   `--force-drain`.
4. Start the new build under its own candidate tag
   (`<project>-sfu:candidate-<service>`) with `SFU_START_DRAINING=true`, so it
   boots out of rotation and no meeting can land on an unverified build. The
   compose file names each service's image through a variable
   (`${SFU_IMAGE_SFU_A:-conclave-sfu-a}`, and so on; the deploy refuses a
   compose file that does not), and every start sets both that variable and
   `SFU_START_DRAINING` explicitly, never inherited from the shell or `.env`.
   The service's own image name (`conclave-sfu-a`) only ever names its
   last-known-good image or a build that passed its canary, so a plain
   `docker compose up`, a restart or a reboot after a crash never brings back
   an untested build. After every start the container must run that very
   image ID, or the deploy stops and rolls back.
5. Run the canary: a real two-person call against that instance
   (`packages/sfu/scripts/canary-call.ts`, bundled at image build into
   `dist/canary-call.mjs` with its dependencies inside). It always runs from
   the image of the checked-out revision, never from the image under test,
   so `--rollback` to a release built before the bundle existed still gets a
   canary. A rollback whose checkout was never built builds it under its own
   tag (`<project>-sfu-canary:<commit>`), never as a service image, so no
   SFU's compose image changes and a rerun reuses it. It takes
   its room through the secret-protected placement endpoint with
   `allowDraining`, the one placement a draining instance grants. Two clients
   join, publish Opus audio and must receive each other's RTP through the SFU,
   and the room must close when they leave.
6. Canary passed: check that no other call reached the instance while it was
   out of rotation, then tag the build as the service's own image and
   restart it serving. It must then be serving within
   `HEALTH_TIMEOUT_SECONDS` (120), by the one rule the deploy uses
   everywhere: its container runs the build and did not boot drained,
   `/health` says healthy, its own `/status` says healthy and
   `draining: false`, and its public URL reaches it. If a call did reach it,
   the deploy waits for that call like a drain, and at the deadline exits 3
   with the instance still drained on the new build and its service tag on
   the last-known-good image. Canary failed, the build would not serve, or
   compose could not start it: put it back on its last-known-good image (the
   image it was serving on when this deploy found it, else the one its journal
   recorded the last time it served) and stop. A build that only ran, never
   one that failed or never finished its canary, is ever last-known-good. A
   build that already served undrained when it failed its last check may have
   calls on it, so it is drained and waited for like any rebuild first; if
   they outlast the deadline it is left drained on the build (exit 3) and goes
   back on a rerun once they end.
   Exit 4 once it is serving again by that same rule; exit 5 when it could
   not be brought back (compose failed, it will not serve, its public URL does
   not reach it, or it has no last-known-good image and stays stopped). The
   instances not yet touched were never drained and keep serving.

Before anything changes, each service's own image name must exist: on a host
whose running images carry other names (another `COMPOSE_PROJECT_NAME`, or
images from before the compose file named them), it is tagged from the
instance's last-known-good image, so a plain `docker compose up` never builds
the checkout. Tags are checked again once the run's repair has put instances
back into service, before the first drain: on a first upgrade where an older
deploy left every instance drained, none of them serves at the first check,
so each is tagged from the image it serves on once it is back. A drain counts
only once the instance's own `/status` says `draining: true`, whatever the
reply to the drain request was; a drain that cannot be confirmed is undone,
and the instance's journal leaves the drained phase only once its `/status`
confirms the drain state it had before.

Every one of these steps is written to the instance's deploy journal
(`<state dir>/<project>.<service>.journal.json`: phase, candidate, last-known-good
image, the image it served before a promotion, whether it was draining before)
before it is taken, whole, fsynced and renamed into place; a journal write
that fails stops the run at once, before the step it records. Every deploy starts
by repairing what a run that died left behind, by the table below, before it
drains anything. An instance whose journal is still not idle after that is
never drained or rebuilt: the deploy stops with the repair's exit code, and a
rerun tries the repair again.

## Recovery: the state machine

Repair, for each instance whose journal is not idle:

| Journal phase | What the instance shows | Action |
| --- | --- | --- |
| drained | container stopped or absent, a last-known-good image on record | Roll back. |
| drained | container stopped or absent, no last-known-good image | Journal to idle; the deploy starts it fresh. |
| drained | runs an image other than its last-known-good | Left as it is (exit 5); check it by hand. |
| drained | runs its last-known-good, was already draining before the deploy | Journal to idle. |
| drained | runs its last-known-good, was serving before the deploy | Undrain it; the journal goes to idle only once `/status` confirms `draining: false`, otherwise it stays drained (exit 1) and the next run tries again. |
| candidate, rollback | serving its last-known-good image | Journal to idle. |
| candidate, rollback | anything else | Roll back. |
| passed, promoting | serving the build that passed its canary | Journal to idle; that build is its last-known-good. |
| passed, promoting | serving the image it had before the promotion | Journal to idle on that image. |
| passed, promoting | container stopped or absent, or still the passed build booted drained | Drain and wait, then promote; if the build will not serve, roll back. |
| passed, promoting | anything else (the build ran undrained and is not serving) | Roll back. |

Every rollback, in repair and after any failed step of a deploy, takes one
path: the journal goes to `rollback` first; then drain and wait; then the
last-known-good image starts serving, and the journal goes to idle once it
serves by the serving rule. An instance that takes meetings is drained for a
rollback only while another instance serves (or when it is the only one); if
none does, it keeps serving (exit 1) and the next run rolls it back once one
does. Repair takes instances whose container is not running first. With no last-known-good image the instance is
stopped instead (exit 5). A promotion also takes one path, in repair and in a
deploy: journal `promoting`, move the service tag, start it serving, then the
serving rule; any failure there is a rollback.

Drain and wait, the only wait for an instance's calls:

| Container | `/status` | Result |
| --- | --- | --- |
| stopped or absent | any | Empty at once: a container that does not run carries no calls. |
| running | unreadable for `HEALTH_TIMEOUT_SECONDS` | Unknown, even for a container that booted drained (a call can still reach a drained candidate): exit 5, left as it is with its journal kept. |
| running | `draining: false` | The drain is sent again; still not draining after `HEALTH_TIMEOUT_SECONDS` is unknown (exit 5). |
| running | `draining: true`, 0 rooms from `PLACEMENT_SETTLE_SECONDS` after the last drain | Empty. |
| running | `draining: true`, rooms left at `DRAIN_TIMEOUT_SECONDS` | Calls remain: exit 3, left drained with its journal kept. |

The rules every path keeps, checked after every run by
`scripts/deploy-sfu-fuzz.test.mjs`:

1. No call is cut, unless `--force-drain` says so.
2. Every instance has a running container on its last-known-good image or a
   build that passed its canary, unless its journal says a rollback is under
   way.
3. An instance is undrained only when it runs its last-known-good image and
   its journal is idle (or drained, undoing this deploy's own drain). The
   recovery that puts an instance back when none takes meetings follows the
   same rule.
4. No drain wait runs out its deadline on a container that is not running.
5. Every rollback is in the journal before its first step.

The fuzz test runs fixed cases (the four recovery holes found in review)
and seeded fault plans: one or two instances, a canary that passes or fails,
crashes at random steps with reruns, containers that exit at boot, `/status`
outages, public routes that answer 502, refused drains, and calls joining
undrained instances at random. After the faults it reruns the deploy until it
settles and checks that every instance serves what it should. A failure
prints its seed and plan; rerun one with `DEPLOY_FUZZ_SEED=<seed>
DEPLOY_FUZZ_RUNS=1 node --test scripts/deploy-sfu-fuzz.test.mjs`
(`DEPLOY_FUZZ_RUNS` sets how many plans, `DEPLOY_FUZZ_CONCURRENCY` how many
at once). `scripts/deploy-sfu-crash.test.mjs` kills a deploy at every step
boundary in turn, including with a hand-run `docker compose up` and a second
deploy waiting on the lock.

An instance whose public URL does not reach it is not drained or rebuilt at
all, and neither is any instance after it (exit 1, `Deploy stopped: clients
cannot reach <service> at its public URL`): it could be shown to serve neither
before a rebuild nor after one. It keeps running and serving whatever calls
reach it. To fix it:

1. See where the route goes:
   `curl -sS -H "x-sfu-secret: $SFU_SECRET" "$SFU_A_PUBLIC_URL/status"` (or
   `SFU_B_PUBLIC_URL`, or `SFU_PUBLIC_URL` in the service's env) must answer
   with that instance's own `instanceId`. No answer means the DNS record, the
   proxy in front of it or the NSG rule is wrong; another `instanceId` means
   the route lands on the other instance.
2. Fix that route (or the URL in `.env`, if the URL itself is wrong). Do not
   restart the SFU for it: the deploy refused before changing anything.
3. Run `./scripts/deploy-sfu.sh --preflight-only` until it passes, then rerun
   the deploy.

An instance whose journal shows the target passed its canary there, still on
the target image and config and serving by the rule above, is skipped, so a
rerun only does what is left; an earlier run that stopped on its public route
stops again there. An instance that answers HTTP but
whose `/status` cannot be read is left alone (exit 1), because its rooms are
unknown. So is one whose container Docker runs while nothing answers at its
URL (exit 1), however recently it started: a wrong `SFU_A_URL` or proxy can
hide calls. A silent instance is started without a drain only when Docker
affirmatively reports its container exited, dead, created or restarting
right now, or compose has no container for it. A container that crashed and
runs again counts as running, however often it restarted: it boots with the
drain state it was created with and can take a call.
When compose or `docker inspect` cannot answer, its state is unknown, so it
counts as busy and is left alone (exit 1). Fix the URL, or stop the container
if it is hung, and rerun.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Every instance is on the new commit and passed its canary. | Nothing. |
| 3 | A meeting outlasted the drain deadline. That instance was put back into service untouched; or, if the call reached it after its canary, or it needs a rollback with calls still on it, it was left drained, its journal kept. | Rerun later. Instances already deployed are skipped, and a pending rollback finishes once its calls end. |
| 4 | The canary failed. The instance runs the image it last served calls on, healthy and taking meetings. | Read the canary lines in the log, fix forward, deploy again. |
| 5 | The canary failed and the instance could not be brought back: it is down or stopped, or it could not be rolled back without risking its calls (its `/status` does not answer, or it will not stay drained) and was left as it is with its journal kept. | Act now: read the log. Fix what stopped it (its `/status`, its route), then rerun, which finishes the rollback; or start it on a known-good release (`--rollback`, or fix forward and deploy). |
| 1 | Another instance is not serving, a public URL does not reach its instance, or anything else (preflight, build, Docker). Nothing after the failing step was drained. | Read the log. For a public URL, follow the steps above: fix the route, pass `--preflight-only`, rerun. |

During an exit 3, 4 or 5 the two instances can run different commits. That is the
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

This runs the same drain and canary steps with a recorded image instead of a
build, so it needs no `git` change and takes minutes. It goes to the last
release that served on every instance: the one before the current release when
every instance runs the current one, or the current release itself when a
rollout reached only some instances. It goes back one release only. Afterwards, revert the bad commit on `main` before the next
deploy, because a normal deploy builds whatever `main` holds. A rollback of
some instances (`SFU_DEPLOY_SERVICES`) keeps its target until every instance
is back on it, so the rest can follow with another `--rollback`; likewise a
deploy is recorded as a release only once every instance runs it. The target
is recorded before the first instance changes, so a `--rollback` rerun after
an exit 3, an exit 4, an exit 5 or a killed run finishes going to that same release.

`--rollback` is available after two releases have gone out with this script.
Before that, revert and deploy.

## Running it on the VM

Before the first deploy with this script, run `./scripts/deploy-sfu.sh
--preflight-only`. It checks the same public routes the deploy now requires,
without changing anything.

Run it as before: as `azureuser` in the repo, under `nohup` with a log file.
The log ends with `SFU deploy complete`, `Deploy paused` (exit 3) or
`Deploy stopped` (exit 4, or 5 when the instance is not serving). The script
needs bash 4 or newer and says so on an older one (macOS ships 3.2).

## Test it locally

The rig used for the PR runs the real script against two instances in Docker
on spare ports. Point a scratch clone's `.env` at those ports with
`SFU_A_PORT`, `SFU_B_PORT` and `SFU_A/B_RTC_MIN/MAX_PORT`, which default to
production's values. To hold a call open during a deploy, run the canary with
`--hold-ms`:

```bash
docker run --rm --network host -e SFU_SECRET --entrypoint node <image> \
  dist/canary-call.mjs --url http://127.0.0.1:3031 --hold-ms 600000
```

It fails if either side goes more than 2 s without audio or is disconnected.

## Known limits

- A running container whose `/status` does not answer is never restarted, so
  a build that hangs at startup without exiting is left as it is (exit 5,
  rollback kept in its journal). Stop that container (`docker compose stop
  <service>`); the next run finds it not running and rolls it back.
- The canary reaches the transports on loopback, so it proves the media path
  inside the SFU, not the public UDP route. The preflight and the NSG rules
  cover that route.
- A rollback reuses the current checkout's compose file. A release that changed
  `docker-compose.sfu.yml` is rolled back to the old image with the new
  container config.
- `scripts/deploy-sfu.ps1` only runs `scripts/deploy-sfu.sh` with the same
  arguments, so a deploy started from PowerShell follows every rule above. It
  runs where PowerShell runs on Linux or macOS, with bash, flock and Docker on
  PATH. On Windows it exits 1 at once: WSL's `bash.exe` cannot open the
  script's Windows path and Git Bash has no `flock`, so open a WSL shell in
  the checkout and run `./scripts/deploy-sfu.sh` there.
