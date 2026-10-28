#if os(iOS) && !SKIP
import SwiftUI

// ENT-6 (S10 10 c, e, g, i; 0.6 L5): the iOS outcome screen, the premeeting root content when the 0.4 table selects it
// (the presenter sets `path = []`). System appearance, `ContentUnavailableView` (iOS 17) with the variant's glyph,
// title and body, the one coral primary (Rejoin, Try Again, or Back to Home when it is the only action) and a
// borderless coralText secondary. The navigation bar is hidden. It reads one `OutcomeModel` value; the copy and glyphs
// come from `OutcomeCopy`, never from the model.

struct OutcomeView: View {
    let outcome: OutcomeModel
    let premeeting: PremeetingPresenter
    @AccessibilityFocusState private var isTitleFocused: Bool

    var body: some View {
        ContentUnavailableView {
            Label(OutcomeCopy.title(outcome.variant), systemImage: OutcomeCopy.symbol(outcome.variant))
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($isTitleFocused)
                .accessibilityIdentifier("outcome.title")
        } description: {
            VStack(spacing: 8) {
                Text(OutcomeCopy.body(outcome))
                if !outcome.serverDetail.isEmpty && outcome.variant == .removed {
                    // S10 10 f: a host-provided reason is a second paragraph in quotes.
                    Text(OutcomeCopy.quoted(outcome.serverDetail))
                        .accessibilityIdentifier("outcome.detail")
                }
            }
        } actions: {
            VStack(spacing: 8) {
                if outcome.primary != .none {
                    ConclaveButton(OutcomeCopy.action(outcome.primary), role: .primary, identifier: "outcome.primary") {
                        premeeting.performOutcomeAction(outcome.primary)
                    }
                    .frame(maxWidth: 440)
                }
                if outcome.secondary != .none {
                    ConclaveButton(OutcomeCopy.action(outcome.secondary), role: .text, identifier: "outcome.secondary") {
                        premeeting.performOutcomeAction(outcome.secondary)
                    }
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityIdentifier("outcome." + outcome.variant.rawValue)
        // S10 10 i: the screen change lands on the title, once per outcome (a body re-run never repeats it).
        .task(id: outcome.id) {
            AccessibilityNotification.ScreenChanged().post()
            isTitleFocused = true
        }
    }
}

/// The variant, action and failure copy of the outcome screen (S10 10 g, 8 g); catalog keys in Apple title case for
/// titles and actions, sentence case for bodies.
enum OutcomeCopy {
    static func title(_ variant: OutcomeVariant) -> String {
        switch variant {
        case .removed:
            return ConclaveStrings.text("Removed From Meeting")
        case .denied:
            return ConclaveStrings.text("Request Declined")
        case .connectionLost:
            return ConclaveStrings.text("Connection Lost")
        case .serverDisconnected:
            return ConclaveStrings.text("You Were Disconnected")
        case .rejoinFailed:
            return ConclaveStrings.text("Couldn\u{2019}t Rejoin")
        }
    }

    static func body(_ outcome: OutcomeModel) -> String {
        switch outcome.variant {
        case .removed:
            return ConclaveStrings.text("The host removed you from this meeting.")
        case .denied:
            return ConclaveStrings.text("Someone in the meeting declined your request to join.")
        case .connectionLost:
            return ConclaveStrings.text("Check your connection, then rejoin.")
        case .serverDisconnected:
            return ConclaveStrings.text("The meeting server ended your connection. You can rejoin.")
        case .rejoinFailed:
            // S10 10 f: the S10 8 g body of the failure class; a clean server sentence is shown as is.
            if outcome.failure == .failedServerText && !outcome.serverDetail.isEmpty {
                return outcome.serverDetail
            }
            return EntryStatusCopy.failureBody(outcome.failure)
        }
    }

    /// Canonical outcome concepts (S10 R1).
    static func symbol(_ variant: OutcomeVariant) -> String {
        switch variant {
        case .removed:
            return ConclaveSymbols.personFillXmark
        case .denied:
            return ConclaveSymbols.handRaisedSlash
        case .connectionLost:
            return ConclaveSymbols.wifiSlash
        case .serverDisconnected, .rejoinFailed:
            return ConclaveSymbols.exclamationmarkTriangleFill
        }
    }

    static func action(_ action: OutcomeAction) -> String {
        switch action {
        case .rejoin:
            return ConclaveStrings.text("Rejoin")
        case .tryAgain:
            return ConclaveStrings.text("Try Again")
        case .backHome, .none:
            return ConclaveStrings.text("Back to Home")
        }
    }

    /// A host-provided reason in curly quotes (not a localized sentence: the reason is the host's own words).
    static func quoted(_ detail: String) -> String {
        "\u{201C}" + detail + "\u{201D}"
    }
}
#endif
