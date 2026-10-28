import Foundation

enum EntryJoinRetry {

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

    static func nanoseconds(forSeconds seconds: Int) -> UInt64 {
        UInt64(max(0, seconds)) * UInt64(1_000_000_000)
    }
}
