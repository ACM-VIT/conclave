#if os(iOS) && !SKIP
import Foundation

enum TranscriptCopy {
    static var title: String { ConclaveStrings.text("Transcript") }
    static var viewSwitchLabel: String { ConclaveStrings.text("Transcript View") }

    static func tab(_ tab: TranscriptTab) -> String {
        switch tab {
        case .transcript: return ConclaveStrings.text("Transcript")
        case .ask: return ConclaveStrings.text("Ask")
        case .minutes: return ConclaveStrings.text("Minutes")
        }
    }

    static var moreActions: String { ConclaveStrings.text("More Transcript Actions") }
    static var export: String { ConclaveStrings.text("Export Transcript") }
    static var copy: String { ConclaveStrings.text("Copy Transcript") }
    static var postRecap: String { ConclaveStrings.text("Post Recap to Chat") }
    static var stopMenu: String { ConclaveStrings.text("Stop Live Notes\u{2026}") }
    static var shareTitle: String { ConclaveStrings.text("Conclave Transcript") }

    static var kicker: String { ConclaveStrings.text("Live Notes") }
    static var beta: String { ConclaveStrings.text("Beta") }
    static var viewOnly: String { ConclaveStrings.text("View Only") }

    static func startTitle(_ kind: TranscriptStartKind) -> String {
        switch kind {
        case .start: return ConclaveStrings.text("Capture the conversation")
        case .takeover: return ConclaveStrings.text("Continue the transcript")
        }
    }

    static func startButton(_ kind: TranscriptStartKind) -> String {
        switch kind {
        case .start: return ConclaveStrings.text("Start Notes")
        case .takeover: return ConclaveStrings.text("Resume Notes")
        }
    }

    static func blurb(_ blurb: TranscriptBlurb) -> String {
        switch blurb {
        case .turnOn: return ConclaveStrings.text("Live transcript, answers, and meeting notes.")
        case .takeoverCovered: return ConclaveStrings.text("Resume with Conclave\u{2019}s shared key.")
        case .takeoverBringKey: return ConclaveStrings.text("Add your key to continue.")
        case .viewOnly: return ConclaveStrings.text("The transcript will appear when the host starts it.")
        }
    }

    static var options: String { ConclaveStrings.text("Advanced") }
    static var provider: String { ConclaveStrings.text("Provider") }
    static var assistant: String { ConclaveStrings.text("Assistant") }

    static func providerName(_ provider: TranscriptProvider) -> String {
        provider.label
    }

    static func providerKey(_ provider: TranscriptProvider) -> String {
        ConclaveStrings.format("%@ API Key", providerName(provider))
    }

    static var assistantKey: String { ConclaveStrings.text("OpenAI Key for Ask and Minutes") }

    static func coverage(_ coverage: KeyCoverage) -> String {
        switch coverage {
        case .unknown: return ConclaveStrings.text("Checking key coverage")
        case .covered: return ConclaveStrings.text("Covered by Conclave. No key needed.")
        case .sarvamNeedsOpenAI: return ConclaveStrings.text("Add an OpenAI key for answers and notes.")
        case .needsKeys: return ConclaveStrings.text("Your key is only used for this meeting.")
        }
    }

    static func status(_ status: TranscriptStatusKind) -> String {
        switch status {
        case .none: return ""
        case .starting: return ConclaveStrings.text("Starting")
        case .live: return ConclaveStrings.text("Live")
        case .paused: return ConclaveStrings.text("Paused")
        case .stopping: return ConclaveStrings.text("Stopping")
        case .reconnecting: return ConclaveStrings.text("Reconnecting")
        case .ended: return ConclaveStrings.text("Ended")
        }
    }

    static func host(_ host: TranscriptHostKind, name: String) -> String {
        switch host {
        case .none: return ""
        case .you: return ConclaveStrings.text("Hosted by you")
        case .named: return ConclaveStrings.format("Hosted by %@", name)
        case .following: return ConclaveStrings.text("Following live")
        }
    }

    static var pause: String { ConclaveStrings.text("Pause") }
    static var resume: String { ConclaveStrings.text("Resume") }
    static var stop: String { ConclaveStrings.text("Stop\u{2026}") }
    static var copied: String { ConclaveStrings.text("Copied") }

    static var stopTitle: String { ConclaveStrings.text("Stop Live Notes for Everyone?") }
    static var stopMessage: String { ConclaveStrings.text("The transcript and minutes so far stay available to export.") }
    static var stopConfirm: String { ConclaveStrings.text("Stop Live Notes") }
    static var cancel: String { ConclaveStrings.text("Cancel") }
    static var tryAgain: String { ConclaveStrings.text("Try Again") }

    static func issue(_ issue: TranscriptIssue, serverText: String) -> String {
        switch issue {
        case .none: return ""
        case .noPermission: return ConclaveStrings.text("You don\u{2019}t have permission to control live notes.")
        case .controlsReconnecting: return ConclaveStrings.text("Live notes controls are reconnecting. Try again in a moment.")
        case .relayFailed: return ConclaveStrings.text("Live notes couldn\u{2019}t hear the room. Try again.")
        case .server: return serverText
        }
    }

    static var stopFailed: String { ConclaveStrings.text("Couldn\u{2019}t stop live notes. Try again.") }

    static var loading: String { ConclaveStrings.text("Loading Live Notes") }
    static var unavailableTitle: String { ConclaveStrings.text("Live Notes Are Unavailable") }
    static var unavailableBody: String { ConclaveStrings.text("Couldn\u{2019}t reach live notes.") }
    static var relayUnavailableTitle: String { ConclaveStrings.text("Live Notes Aren\u{2019}t Available") }
    static var relayUnavailableBody: String { ConclaveStrings.text("Live notes aren\u{2019}t available in this meeting.") }

    static var listeningTitle: String { ConclaveStrings.text("Listening for the Room") }
    static var listeningBody: String { ConclaveStrings.text("As people speak, their words appear here live, captioned for everyone.") }
    static var jumpToLatest: String { ConclaveStrings.text("Jump to Latest") }
    static var stillSpeaking: String { ConclaveStrings.text("Still speaking") }

    static func resumedAt(_ millis: Double) -> String {
        ConclaveStrings.format("Resumed at %@", clock(millis))
    }

    static func speaker(_ name: String, isYou: Bool) -> String {
        if isYou { return ConclaveStrings.text("You") }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? ConclaveStrings.text("Speaker") : trimmed
    }

    static func clock(_ millis: Double) -> String {
        Date(timeIntervalSince1970: millis / 1000.0).formatted(Date.FormatStyle.dateTime.hour().minute())
    }

    static var askEmptyTitle: String { ConclaveStrings.text("Ask the Meeting") }
    static var askEmptyBody: String { ConclaveStrings.text("Get a private answer drawn from everything that\u{2019}s been said. Only you see it.") }
    static var askSuggestions: [String] {
        [ConclaveStrings.text("What decisions have we made?"), ConclaveStrings.text("Summarize the discussion"),
         ConclaveStrings.text("What are the action items?")]
    }
    static var askPlaceholder: String { ConclaveStrings.text("Ask about the meeting") }
    static var askSend: String { ConclaveStrings.text("Ask") }
    static var askPrivate: String { ConclaveStrings.text("Only you see your questions and answers.") }
    static var thinking: String { ConclaveStrings.text("Thinking") }
    static var copyAnswer: String { ConclaveStrings.text("Copy Answer") }
    static var youAsked: String { ConclaveStrings.text("You asked") }
    static var conclaveAnswered: String { ConclaveStrings.text("Conclave answered") }

    static func askState(_ state: AskRowState, errorText: String) -> String {
        switch state {
        case .thinking: return ConclaveStrings.text("Thinking")
        case .streaming, .done: return ""
        case .error: return errorText.isEmpty ? ConclaveStrings.text("Conclave couldn\u{2019}t answer right now.") : errorText
        case .notSent: return ConclaveStrings.text("Question couldn\u{2019}t be sent.")
        case .timedOut: return ConclaveStrings.text("No answer yet.")
        }
    }

    static func section(_ section: MinutesSection) -> String {
        switch section {
        case .summary: return ConclaveStrings.text("Summary")
        case .topics: return ConclaveStrings.text("Topics")
        case .decisions: return ConclaveStrings.text("Decisions")
        case .actionItems: return ConclaveStrings.text("Action Items")
        case .openQuestions: return ConclaveStrings.text("Open Questions")
        case .followUps: return ConclaveStrings.text("Follow-Ups")
        }
    }

    static func emptyTitle(_ kind: MinutesEmptyKind) -> String {
        switch kind {
        case .none: return ""
        case .buildAsYouTalk: return ConclaveStrings.text("Minutes Build as You Talk")
        case .cooking: return ConclaveStrings.text("Cooking Up Minutes")
        }
    }

    static func emptyBody(_ kind: MinutesEmptyKind) -> String {
        switch kind {
        case .none: return ""
        case .buildAsYouTalk: return ConclaveStrings.text("Topics, decisions, action items, and open questions fill in on their own.")
        case .cooking:
            return ConclaveStrings.text("We\u{2019}ll lay out topics, decisions, and action items once there\u{2019}s enough of the conversation to summarize.")
        }
    }

    static func minutesStatus(_ kind: MinutesStatusKind, updatedAtMillis: Double, nowMillis: Double) -> String {
        switch kind {
        case .automatic: return ConclaveStrings.text("Minutes build automatically")
        case .updating: return ConclaveStrings.text("Updating Minutes")
        case .updated:
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .short
            let relative = formatter.localizedString(for: Date(timeIntervalSince1970: updatedAtMillis / 1000.0),
                                                     relativeTo: Date(timeIntervalSince1970: nowMillis / 1000.0))
            return ConclaveStrings.format("Updated %@", relative)
        }
    }

    static var refreshMinutes: String { ConclaveStrings.text("Refresh Minutes") }
    static var recapDetail: String { ConclaveStrings.text("Conclave writes a short recap in the room chat for everyone.") }

    static func owner(_ name: String) -> String { ConclaveStrings.format("Owner: %@", name) }
    static func due(_ text: String) -> String { ConclaveStrings.format("Due: %@", text) }

    static func recapValue(_ phase: RecapPhase) -> String {
        switch phase {
        case .idle: return ""
        case .posting: return ConclaveStrings.text("Posting")
        case .posted: return ConclaveStrings.text("Posted")
        case .failed: return ConclaveStrings.text("Couldn\u{2019}t post the recap.")
        }
    }

    static func announcement(_ kind: TranscriptAnnouncementKind) -> String {
        switch kind {
        case .started: return ConclaveStrings.text("Live notes started")
        case .paused: return ConclaveStrings.text("Live notes paused")
        case .stopped: return ConclaveStrings.text("Live notes stopped")
        case .copied: return ConclaveStrings.text("Copied")
        case .recapPosting: return ConclaveStrings.text("Posting recap")
        case .recapPosted: return ConclaveStrings.text("Recap posted to chat")
        case .recapFailed: return ConclaveStrings.text("Couldn\u{2019}t post the recap.")
        case .answerReady: return ConclaveStrings.text("Answer ready")
        }
    }

    static func exportLabels(roomId: String) -> TranscriptExportLabels {
        TranscriptExportLabels(
            title: ConclaveStrings.format("Meeting Transcript - %@", roomId),
            summary: section(MinutesSection.summary), topics: section(MinutesSection.topics),
            decisions: section(MinutesSection.decisions), actionItems: section(MinutesSection.actionItems),
            openQuestions: section(MinutesSection.openQuestions), followUps: section(MinutesSection.followUps),
            transcript: ConclaveStrings.text("Transcript"), speaker: ConclaveStrings.text("Speaker"))
    }

    static var endRecapMessage: String { ConclaveStrings.text("Conclave can post a recap of the meeting to chat before the call ends.") }
    static var endPostRecap: String { ConclaveStrings.text("Post Recap and End") }
    static var endWithoutRecap: String { ConclaveStrings.text("End Without Recap") }
    static var endTitle: String { ConclaveStrings.text("End Call for Everyone?") }
}
#endif
