#if os(iOS) && !SKIP
import SwiftUI

// S20 12 (STG-8, SL13) on iOS: the webinar attendee viewer. The program feed and the speaker inset are ordinary canvas
// slots (`programFeed`, `speakerInset`; `AttendeeViewerPolicy.slots`), so the feed keeps its renderer identity when a
// share starts; the top cluster keeps the capsule (webinar title and "Live", a Button that opens Webinar Details,
// RECONCILE R44) plus the system route picker; the bar is the S30 attendee composition (Raise Hand only with the
// capability, Q&A with the unseen badge, Leave Call; CTL-1). This file adds the waiting state (a dark
// `ContentUnavailableView` with the title and the count) and the attendee copy the chrome, the slots and the
// announcements resolve. No mic, camera, chat, reactions, People or captions for attendees (12 b).

/// The waiting state (12 c, f): shown while the feed has nobody on it. A sibling layer of the canvas in the call root;
/// it reads only `stage.attendee`.
struct AttendeeWaitingLayer: View {
    let stage: StagePresenter

    var body: some View {
        if let viewer = stage.attendee, !viewer.isLive {
            AttendeeWaitingCard(count: viewer.waitingCount)
                .padding(.horizontal, 24)
                .padding(.top, StageCanvasMetrics.topReserve)
                .padding(.bottom, StageCanvasMetrics.barReserve)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .accessibilityIdentifier("stage.attendee.waiting")
        }
    }
}

/// The system empty state in the in-call theme: the broadcast glyph (pending the icon manifest, S20 SR1; the video glyph
/// stands in), the title and, when others wait too, the count. Refreshed by events, no timer (12 f).
private struct AttendeeWaitingCard: View {
    let count: Int

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(ConclaveStrings.text("The Webinar Will Begin Soon"))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            } icon: {
                Image(systemName: ConclaveSymbols.videoFill)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityHidden(true)
            }
        } description: {
            if AttendeeViewerPolicy.showsWaitingCount(count) {
                Text(AttendeeViewerCopy.waitingCount(count))
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
        }
    }
}

/// Attendee copy on iOS (Apple title case; S20 12 g). The chrome resolves the capsule through `capsuleSubtitle` and
/// `title` (HD request B5-T2 R5), the slot view the feed labels (HD request B5-T2 R7) and the announcer the two
/// announcement kinds (HD request B5-T2 R5).
enum AttendeeViewerCopy {
    /// The capsule's second line for attendees.
    static func capsuleSubtitle() -> String {
        ConclaveStrings.text("Live")
    }

    /// The webinar title, or "Webinar" while the landing title is unknown (SC22).
    static func title(_ title: String) -> String {
        title.isEmpty ? ConclaveStrings.text("Webinar") : title
    }

    static func waitingCount(_ count: Int) -> String {
        ConclaveStrings.format("Webinar Waiting Count %lld", count)
    }

    /// "Live Video from Avery" or "Shared Screen from Avery" (12 i; four-letter prepositions stay lowercase).
    static func feedLabel(isShare: Bool, name: String) -> String {
        isShare ? ConclaveStrings.format("Shared Screen from %@", name) : ConclaveStrings.format("Live Video from %@", name)
    }

    /// One-shot announcements (12 f, 12 i); nil for kinds this file does not own.
    static func announcement(kind: String) -> String? {
        switch kind {
        case AttendeeViewerPolicy.demotedAnnouncement:
            return ConclaveStrings.text("You’re now watching as an attendee.")
        case AttendeeViewerPolicy.webinarLiveAnnouncement:
            return ConclaveStrings.text("The webinar is live.")
        default:
            return nil
        }
    }
}
#endif
