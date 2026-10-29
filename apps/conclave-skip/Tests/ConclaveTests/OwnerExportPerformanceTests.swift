#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct OwnerExportPerformanceTests {
    @Test func backgroundExportKeepsAnImmutableFinalsOnlySnapshot() async {
        let driver = TranscriptFixtureDriver(fixture: .liveController)
        driver.runsFollowUps = false
        let presenter = driver.presenter
        let labels = TranscriptExportLabels(title: "Meeting", summary: "Summary", topics: "Topics", decisions: "Decisions",
                                            actionItems: "Actions", openQuestions: "Questions", followUps: "Follow-Ups",
                                            transcript: "Transcript", speaker: "Speaker")
        let expected = presenter.exportFile(labels: labels, timeLabel: { _ in "10:41" })
        let snapshot = presenter.exportSnapshot(labels: labels)
        let oldSession = presenter.inputs.callSession
        presenter.reset()
        presenter.recordExport(byteCount: 7, callSession: presenter.inputs.callSession)
        let result = await Task.detached {
            #expect(!Thread.isMainThread)
            return snapshot.data(timeLabel: { _ in "10:41" })
        }.value
        #expect(result == Data(expected.content.utf8))
        #expect(result.count == expected.byteCount)
        presenter.recordExport(byteCount: result.count, callSession: oldSession)
        #expect(presenter.exportBytes == 7)
    }
}
#endif
