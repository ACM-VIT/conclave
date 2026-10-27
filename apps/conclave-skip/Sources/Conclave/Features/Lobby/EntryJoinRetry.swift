import Foundation

// ENT-5 (S10 0.8 C18, 8 f, 8 l7b; RECONCILE R48): the one automatic join retry. `POST /api/sfu/join` answers 503
// with `Retry-After: 5` while servers drain and `2` while placement is unavailable
// (`apps/web/src/app/api/sfu/join/route.ts:740-748`). An initial join that fails that way waits
// `min(Retry-After, 10)` s while the lobby stays in Connecting (the attempt and its phase do not change), then asks
// once more; a second failure, or any other failure, reaches the failed block with a manual Try Again. The view
// model's `joinRoom` calls this around `SfuJoinService.fetchJoinInfo` (HD request B5-T5 R2); the transport, the wait
// and the currency check are closures, so tests drive it with a stub and no clock.

enum EntryJoinRetry {
    /// Fetches the join info with at most one automatic retry. Returns nil when the attempt was replaced (Cancel, a
    /// newer join) during the wait; rethrows the last failure otherwise. Recovery joins pass `allowsRetry: false`:
    /// they keep their own reconnect schedule.
    @MainActor
    static func fetchJoinInfo(
        allowsRetry: Bool,
        isNetworkOffline: () -> Bool,
        isCurrent: () -> Bool,
        wait: (Int) async -> Void,
        onRetryScheduled: (Int) -> Void,
        fetch: () async throws -> SfuJoinInfo
    ) async throws -> SfuJoinInfo? {
        do {
            return try await fetch()
        } catch {
            guard allowsRetry else { throw error }
            let classified = MeetingErrorClassifier.classify(error, context: MeetingErrorContext.join,
                                                             isNetworkOffline: isNetworkOffline())
            guard let delaySeconds = MeetingJoinRetryPolicy.automaticRetryDelaySeconds(classified, retriesSoFar: 0) else {
                throw error
            }
            onRetryScheduled(delaySeconds)
            await wait(delaySeconds)
            guard isCurrent() else { return nil }
            return try await fetch()
        }
    }

    /// The wait in nanoseconds for a delay in seconds (the view model's `Task.sleep`).
    static func nanoseconds(forSeconds seconds: Int) -> UInt64 {
        UInt64(max(0, seconds)) * 1_000_000_000
    }
}
