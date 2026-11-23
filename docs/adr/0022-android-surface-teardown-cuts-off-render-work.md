# 0022. Android surface teardown cuts render work off instead of waiting for it

- Status: Accepted
- Date: 2026-11-23

## Context

Android's `SurfaceHolder.Callback.surfaceDestroyed` contract says nothing may touch the surface once the callback returns, so a render thread has to be done with it first. Each Android stage video tile draws into its SurfaceView from its own render thread (`VideoRenderLoop`). Every loop takes WebRTC's shared `EglBase.lock` around make-current and swap, because some drivers deadlock between one thread's swap and another thread's context creation (webrtc:5702). A swap can stall waiting on its window, and while it holds the shared lock every other tile's render thread waits behind it.

A rotation or a move to the background destroys several surfaces in a row on the main thread. Waiting for each render thread without a bound held the main thread for 12 s with four busy tiles on an emulator (PR #304, review round 1). A wait on a call blocked behind another tile's stalled swap cannot end before that tile's own `surfaceDestroyed` runs, which is after ours on the same main thread.

A bounded wait that only gave up still let render work reach the window after the callback returned (PR #304, review round 3): an attach still queued when its tile was released created an EGL surface on the old window, and a draw paused between two EGL calls drew after the callback had destroyed its surface.

## Decision

The main thread revokes the window's lease (`WindowLease`) before anything else on detach or release, waits for the render thread's detach within one allowance shared by all surface tiles (`VideoDetachWait`, 150 ms in any second), and then destroys the EGL surface itself (`abandonSurface`) if the wait ran out. Every render-thread call that touches the window surface goes through `LeasedWindowBackend`, which refuses it once the lease is revoked. The main thread never waits longer than the allowance.

## Consequences

- Nothing the render thread starts after `surfaceDestroyed` begins touches that window. A call already inside EGL when the allowance runs out is cut off by the destroy, which disconnects the window from EGL, and fails.
- The main thread's cost does not grow with the number of busy tiles.
- One call still reaches the window after the callback returns: an `eglCreateWindowSurface` already running when the allowance ran out. It finishes, and the next call destroys the surface it made without drawing into it.
- A swap stalled inside the driver, not waiting on its window, is not ended by the destroy, and every stage tile stays frozen until the driver returns. Only a phone shows whether a driver does that.
- Revisit if a phone shows `eglCreateWindowSurface` or a driver stall outlasting the allowance, or if the shared EGL lock is ever dropped.

## Alternatives considered

- **Wait without a bound, as `GLSurfaceView` and WebRTC's `SurfaceViewRenderer` do:** rejected. It held the main thread for seconds when several busy tiles were destroyed together, and a wait on a call blocked behind another tile's stalled swap cannot end before that tile's callback runs.
- **Hold a per-window lock across every render-thread call and take it in the callback:** rejected. The callback would block while a call holding it waits on its window or behind another tile's stalled swap, the same two waits as above.
- **Wait for calls already in flight after destroying the surface:** rejected. A bind blocked behind another tile's stalled swap keeps waiting until that tile's callback runs.
- **Drop WebRTC's shared EGL lock:** rejected. It guards a driver deadlock between swap and context creation.

## Code

- `apps/conclave-skip/Sources/Conclave/Skip/VideoTileRenderer.kt`: `WindowLease`, `LeasedWindowBackend`, `VideoTileRenderer.surfaceGoneAfterDetach`, `detachSurface`, `release`, `abandonSurface`
- `apps/conclave-skip/Sources/Conclave/Skip/VideoHosts.kt`: `VideoDetachWait`, `SurfaceVideoHost.surfaceDestroyed`
- `apps/conclave-skip/Sources/Conclave/Skip/VideoRenderLoop.kt`: `makeCurrent`, `swap` (the shared `EglBase.lock`)
- `apps/conclave-skip/Tests/ConclaveTests/Skip/VideoRenderingTests.kt`: assertion messages starting `ADR 0022:` in `anAttachStillQueuedWhenItsTileIsReleasedNeverTouchesTheWindowAfterItsCallbackReturns`, `aDrawPausedBetweenTwoWindowCallsStopsOnceTheCallbackHasReturned` and `aSurfaceStillBeingCreatedWhenTheWaitRunsOutIsDestroyedAsSoonAsItExists`; `aStalledSwapHoldsEveryTileOnTheSharedEglLockUntilTheCallbackDestroysItsSurfaceWithinTheWait`
