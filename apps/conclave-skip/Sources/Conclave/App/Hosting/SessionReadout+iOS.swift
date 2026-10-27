#if os(iOS) && !SKIP
import SwiftUI

/// WP2-S2b Debug session readout (S1C Q8, OWNER-DEFAULTS Q16; S70 0.6 Debug readouts) for the Debug hosting preview
/// list (`PlatformRoot+iOS.swift`, mounted by HD request B2-T1). It shows the live `MeetingViewModel.shared.shell`
/// snapshots and `sys.feedbackRecords`; each row is its own leaf that reads one snapshot, so a controls publish never
/// re-evaluates the identity row. Values are ASCII (`MeetingSessionReadout`); the row label is localized, the
/// `accessibilityIdentifier` is the readout key. Opening the readout is a fixture start, so the records reset once.
struct SessionReadoutSection: View {
    let shell: MeetingShellPresenter
    let records: FeedbackDeliveryRecords
    @State private var didReset = false

    var body: some View {
        Section(ConclaveStrings.text("Session Readout")) {
            SessionReadoutRow(labelKey: "Identity", key: MeetingSessionReadout.identityKey) {
                MeetingSessionReadout.identity(shell.session)
            }
            SessionReadoutRow(labelKey: "Phase", key: MeetingSessionReadout.phaseKey) {
                MeetingSessionReadout.phase(shell.session)
            }
            SessionReadoutRow(labelKey: "Outcome", key: MeetingSessionReadout.outcomeKey) {
                MeetingSessionReadout.outcome(shell.session)
            }
            SessionReadoutRow(labelKey: "Controls", key: MeetingSessionReadout.controlsKey) {
                MeetingSessionReadout.controls(shell.controls)
            }
            SessionReadoutRow(labelKey: "Ledger", key: MeetingSessionReadout.ledgerKey) {
                // The ledger is not observable; the rows publish its pending state, so this refreshes with them.
                _ = shell.controls.revision
                return MeetingSessionReadout.ledger(shell.ledger)
            }
            SessionReadoutRow(labelKey: "Feedback", key: MeetingSessionReadout.feedbackKey) {
                MeetingSessionReadout.feedback(shell.feedbackState)
            }
            SessionReadoutRow(labelKey: "Feedback Records", key: MeetingSessionReadout.feedbackRecordsKey) {
                MeetingSessionReadout.feedbackRecords(count: records.count, lastKind: records.lastKind)
            }
        }
        .task {
            guard !didReset else { return }
            didReset = true
            records.reset()
        }
    }
}

private struct SessionReadoutRow: View {
    let labelKey: String
    let key: String
    let value: () -> String

    var body: some View {
        LabeledContent(ConclaveStrings.text(labelKey), value: value())
            .accessibilityIdentifier(key)
    }
}
#endif
