#if os(iOS) && !SKIP
import SwiftUI

struct OutcomeView: View {
    let outcome: OutcomeModel
    let premeeting: PremeetingPresenter
    @AccessibilityFocusState private var isTitleFocused: Bool

    var body: some View {
        content
            .toolbar(.hidden, for: .navigationBar)
            .accessibilityIdentifier("outcome." + outcome.variant.rawValue)

            .task(id: outcome.id) {
                AccessibilityNotification.ScreenChanged().post()
                isTitleFocused = true
            }
    }

    @ViewBuilder
    private var content: some View {
        if OutcomeCopy.hasDescription(outcome) {
            ContentUnavailableView {
                Label(OutcomeCopy.title(outcome.variant), systemImage: OutcomeCopy.symbol(outcome.variant))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($isTitleFocused)
                    .accessibilityIdentifier("outcome.title")
            } description: {
                if OutcomeCopy.hasBody(outcome.variant) {
                    Text(OutcomeCopy.body(outcome))
                } else if outcome.variant == .removed && !outcome.serverDetail.isEmpty {
                    Text(OutcomeCopy.quoted(outcome.serverDetail))
                        .accessibilityIdentifier("outcome.detail")
                }
            } actions: {
                actions
            }
        } else {
            ContentUnavailableView {
                Label(OutcomeCopy.title(outcome.variant), systemImage: OutcomeCopy.symbol(outcome.variant))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($isTitleFocused)
                    .accessibilityIdentifier("outcome.title")
            } description: {
                Color.clear
                    .frame(height: 0)
            } actions: {
                actions
            }
        }
    }

    private var actions: some View {
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
}

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

    static func hasBody(_ variant: OutcomeVariant) -> Bool {
        switch variant {
        case .removed, .denied:
            return false
        case .connectionLost, .serverDisconnected, .rejoinFailed:
            return true
        }
    }

    static func hasDescription(_ outcome: OutcomeModel) -> Bool {
        hasBody(outcome.variant) || (outcome.variant == .removed && !outcome.serverDetail.isEmpty)
    }

    static func body(_ outcome: OutcomeModel) -> String {
        switch outcome.variant {
        case .removed, .denied:
            return ""
        case .connectionLost:
            return ConclaveStrings.text("Check your connection, then rejoin.")
        case .serverDisconnected:
            return ConclaveStrings.text("You can rejoin.")
        case .rejoinFailed:

            if outcome.failure == .failedServerText && !outcome.serverDetail.isEmpty {
                return outcome.serverDetail
            }
            return EntryStatusCopy.failureBody(outcome.failure)
        }
    }

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

    static func quoted(_ detail: String) -> String {
        "\u{201C}" + detail + "\u{201D}"
    }
}
#endif
