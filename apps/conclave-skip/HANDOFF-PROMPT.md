# Kickoff prompt — Conclave native polish & performance

You are picking up the Conclave **native** app at `apps/conclave-skip` (a Skip app: one Swift codebase transpiled to Kotlin/Compose for Android and compiled natively for iOS). Your job is to finish the meeting-entry experience, fix the outstanding correctness bugs, and make the Android app **buttery smooth** — it currently feels laggy and sluggish (join screen, sheets especially, and in-meeting), and native apps should feel instant.

## First, read the handoff
`apps/conclave-skip/HANDOFF.md` is the source of truth. **Read it completely before writing any code.** It contains the exact build/install/test commands, the non-obvious gotchas (Skip transpile traps, the SkipUI `onChange` null-crash pattern, R8/minify constraints, adb/device-testing quirks), the file index, and the detailed bug write-ups. Do not rediscover what's already documented there.

## Scope, in priority order
Work these in order; don't move on until the current one is verified on a real device.

1. **P0 — Entry overlay reveal (HANDOFF §4.1).** The branded Lottie+audio takeover must stay up until the meeting is fully ready, then reliably fade to a settled meeting. It was seen **stuck black over a fully-joined meeting**, and neither the reveal task nor the 12 s safety timeout cleared it. Make overlay visibility a **pure function of observable state with a hard ceiling** — not a fire-and-forget `Task` that view churn can silently cancel. Handle every exit: joined, waiting (→ WaitingRoomView), error (→ branded error → setup), disconnected. Nothing may ever sit on black longer than the safety cap.
2. **P0 — Lottie renders black on Android (§4.2).** The Conclave lockup shows as solid black via lottie-compose. Diagnose (dotLottie decode vs asset packaging vs invisible layer), fix, and confirm it actually animates on device. Confirm iOS renders it too.
3. **P0 — Confirm the onChange NPE fix + guest New-meeting path (§4.3, §4.4).** The zero-param `onChange` conversion is in; confirm no `checkNotNullParameter` crash across a full meeting entry and chat/sheet/transcript toggles. Verify the guest "New meeting" tap actually starts a join (it no-opped in one clean retest).
4. **P1 — Performance / "buttery" (§5).** This is the headline ask. The sluggishness is **over-broad recomposition**, not CPU work: reading big `@Observable` state (`MeetingViewModel.shared` / `state`) inside large view bodies recomposes huge subtrees on unrelated changes. Split large bodies into narrow-reading leaf views, pass primitives not the whole view model, isolate high-frequency state (active speaker / audio levels / stats), lighten and lazy-load the sheets, and remove animation/redraw churn. **Start with the sheets** — the user called them out specifically. Measure before/after with the Compose draw cadence (idle should be quiet, not 60fps).
5. **P2 — Polish/parity smoke tests (§6).** Entry sound, and device-validate parity phases 1–6 (privacy policy, connection banners, GIF picker, game cards, Wordle, transcription), which compile but were never fully device-tested.

## Non-negotiable constraints
- **No gradients. Anywhere.** Flat solid surfaces + 1px borders + the single coral accent. The web app has zero gradients; native must match. This is a hard design law.
- **Keep iOS green.** Every change must keep `swift build` compiling and `swift test` passing — you're editing one Swift source for both platforms.
- **Do not re-enable R8/minification.** The release build is intentionally un-minified because R8 breaks SkipUI two ways (onChange NPE + Preference NPE). This is explained in the handoff; don't "fix" it.
- **Verify on the real device, not just by building.** A green build is necessary, not sufficient. Install the release APK and confirm behavior with screenshots + uiautomator dumps (dump to a file — see the handoff; screenshots can lie about what's actually on screen). App logs are NO-OP on Android, so trace via the UI tree or a temporary on-screen debug readout.

## Working method
- After each change: `swift build` (must say "Build complete!") → `gradle :Conclave:compileDebugKotlin` for a fast Kotlin gate → then the release APK when you're ready to test on device. Don't pipe builds through `tail`/`grep` in a way that hides the exit code.
- Keep changes tight and idiomatic to the surrounding code. When you hit a Skip transpile error, consult the gotcha list before guessing.
- Run your work through the codex CLI review loop the way this project prefers: implement → `codex exec -s read-only … < /dev/null` review → fix real findings → re-confirm → build. Fold caught bugs back in before moving on.
- Don't commit or push unless asked. When P0 is verified, propose a focused commit.

## Reporting / honesty
Be precise about what you actually verified versus what you assume. If a build fails, show the error. If a device test is flaky or you couldn't reproduce, say so plainly — don't declare the overlay "fixed" because it compiled. Distinguish "confirmed on device" from "should work." Surface anything in the handoff that turns out to be wrong.

## Definition of done
Every box in HANDOFF.md §7 is checked on a real device: clean cold start renders JoinView; New meeting (guest) shows a **visible** Lottie + sound overlay that **reveals a settled meeting within ~2 s of ready** with no device-init hiccup and no crash; join-by-code, bad code, and locked-room paths all behave; chat/sheets/transcript open without NPE and **feel smooth**; idle in-meeting draw cadence is quiet; the share sheet opens; and there are no gradients. Both platforms build green and `swift test` passes.
