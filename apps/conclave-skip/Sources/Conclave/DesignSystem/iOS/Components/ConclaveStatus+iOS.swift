#if os(iOS) && !SKIP
import SwiftUI

// Status views (F00 C14): loading, empty, error with retry, and offline. Progress is the system spinner with a
// static label (R13): no pulse, shimmer or timer, and the spinner exists only while something loads. In-call
// variants inherit the dark environment of their region.

/// A loading state: the system spinner with a static label ("Loading" when the screen names nothing better).
struct ConclaveLoadingStatus: View {
    let label: String?
    let identifier: String

    init(label: String? = nil, identifier: String) {
        self.label = label
        self.identifier = identifier
    }

    var body: some View {
        ProgressView(label ?? ConclaveStrings.text("Loading"))
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier(identifier)
    }
}

/// An empty state.
struct ConclaveEmptyStatus: View {
    let title: String
    let message: String
    let systemImage: String
    let identifier: String

    var body: some View {
        ContentUnavailableView {
            StatusTitle(title: title, systemImage: systemImage)
        } description: {
            Text(message)
        }
        .accessibilityIdentifier(identifier)
    }
}

/// An error with a retry. The retry is tonal; coral stays for the screen's primary action.
struct ConclaveErrorStatus: View {
    let title: String
    let message: String
    let systemImage: String
    let retryTitle: String?
    let identifier: String
    let onRetry: () -> Void

    init(title: String, message: String, systemImage: String, retryTitle: String? = nil, identifier: String,
         onRetry: @escaping () -> Void) {
        self.title = title
        self.message = message
        self.systemImage = systemImage
        self.retryTitle = retryTitle
        self.identifier = identifier
        self.onRetry = onRetry
    }

    var body: some View {
        ContentUnavailableView {
            StatusTitle(title: title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            StatusRetry(title: retryTitle, identifier: identifier + ".retry", action: onRetry)
        }
        .accessibilityIdentifier(identifier)
    }
}

/// Offline, with the component copy (F00 C14 g, final in S70 7 g). The offline concept is pending in the icon
/// manifest, so the glyph is the `wifi.exclamationmark` stand-in (FND-1 carry, F00 7.3).
struct ConclaveOfflineStatus: View {
    let identifier: String
    let onRetry: (() -> Void)?

    init(identifier: String, onRetry: (() -> Void)? = nil) {
        self.identifier = identifier
        self.onRetry = onRetry
    }

    var body: some View {
        ContentUnavailableView {
            StatusTitle(title: ConclaveStrings.text("You’re Offline"), systemImage: ConclaveSymbols.wifiExclamationmark)
        } description: {
            Text(ConclaveStrings.text("This will load when you’re back online."))
        } actions: {
            if let onRetry {
                StatusRetry(title: nil, identifier: identifier + ".retry", action: onRetry)
            }
        }
        .accessibilityIdentifier(identifier)
    }
}

/// The title is the state's heading.
private struct StatusTitle: View {
    let title: String
    let systemImage: String

    var body: some View {
        Label(title, systemImage: systemImage)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct StatusRetry: View {
    let title: String?
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(title ?? ConclaveStrings.text("Try Again"), action: action)
            .buttonStyle(.bordered)
            .tint(Color.primary)
            .accessibilityIdentifier(identifier)
    }
}
#endif
