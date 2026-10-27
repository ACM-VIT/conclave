#if os(iOS) && !SKIP
import SwiftUI

/// The four text button roles (F00 C01). Call controls are C04, not buttons.
enum ConclaveButtonRole: String, CaseIterable {
    /// The one coral action per screen: coral fill, onCoral label, never a white label (Q12).
    case primary
    /// The neutral secondary.
    case tonal
    /// A low-emphasis action or link in coralText.
    case text
    /// Removes or ends something, in system red.
    case destructive
}

/// A text button (F00 C01, TG 4.2 `button.*`). Titles are localized by the caller. A pending button keeps its
/// label, shows a spinner that accessibility never reads on its own and reports "In Progress" as its value. A
/// disabled primary button dims to 40% explicitly, because its explicit label color does not dim (R02). Labels
/// wrap; `lineLimit` defaults to none (OQ-2b-5) and is for consuming screens whose geometry needs a cap.
struct ConclaveButton: View {
    let title: String
    let role: ConclaveButtonRole
    let isEnabled: Bool
    let isPending: Bool
    let lineLimit: Int?
    let identifier: String
    let action: () -> Void

    init(_ title: String, role: ConclaveButtonRole = .primary, isEnabled: Bool = true, isPending: Bool = false,
         lineLimit: Int? = nil, identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.role = role
        self.isEnabled = isEnabled
        self.isPending = isPending
        self.lineLimit = lineLimit
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        styled
            .disabled(!isEnabled || isPending)
            .modifier(PendingValue(isPending: isPending))
            .accessibilityIdentifier(identifier)
    }

    @ViewBuilder
    private var styled: some View {
        switch role {
        case .primary:
            Button(action: action) {
                ButtonTitle(title: title, isPending: isPending, lineLimit: lineLimit, spinnerTint: HostingTheme.onCoral)
                    .foregroundStyle(HostingTheme.onCoral)
            }
            .buttonStyle(.borderedProminent)
            .tint(HostingTheme.coralFill)
            .controlSize(.large)
            .opacity(isEnabled ? 1 : ConclaveButtonMetrics.disabledOpacity)
        case .tonal:
            Button(action: action) {
                ButtonTitle(title: title, isPending: isPending, lineLimit: lineLimit, spinnerTint: nil)
            }
            .buttonStyle(.bordered)
            .tint(Color.primary)
            .controlSize(.large)
        case .text:
            Button(action: action) {
                ButtonTitle(title: title, isPending: isPending, lineLimit: lineLimit, spinnerTint: nil)
                    .frame(minHeight: ConclaveButtonMetrics.minimumHeight)
            }
            .buttonStyle(.borderless)
            .tint(HostingTheme.coralText)
        case .destructive:
            Button(role: .destructive, action: action) {
                ButtonTitle(title: title, isPending: isPending, lineLimit: lineLimit, spinnerTint: nil)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }
}

enum ConclaveButtonMetrics {
    /// R02 and F00 2.6 A6: the iOS disabled opacity.
    static let disabledOpacity = 0.4
    static let minimumHeight: CGFloat = 44
}

/// The label: a leading spinner while pending (it mirrors with the layout direction), then the title, which
/// wraps instead of truncating.
private struct ButtonTitle: View {
    let title: String
    let isPending: Bool
    let lineLimit: Int?
    /// The primary button's spinner takes the onCoral ink; other roles keep the system tint.
    let spinnerTint: Color?

    var body: some View {
        HStack(spacing: 8) {
            if isPending {
                ProgressView()
                    .tint(spinnerTint)
                    .accessibilityHidden(true)
            }
            Text(title)
                .lineLimit(lineLimit)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// "In Progress" as the value while pending, and no value otherwise.
private struct PendingValue: ViewModifier {
    let isPending: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isPending {
            content.accessibilityValue(ConclaveStrings.text("In Progress"))
        } else {
            content
        }
    }
}

// MARK: Icon buttons, Close and Back (F00 C02)

/// The foreground of an in-content icon button: `.primary` for actions, the secondary text color for quiet
/// trailing actions such as a row's More (F00 C02 e). Toolbar items take the system tint instead.
enum ConclaveIconButtonTone: String, CaseIterable {
    case primary, secondary
}

/// An icon-only action in system-appearance chrome or content: a toolbar action, a row's trailing action, a field
/// clear. The image is hidden from accessibility and the label names the action, not the glyph (AX2). Targets
/// are at least 44 pt. In-call floating chrome is `ConclaveChromeButton` (C03), not this.
struct ConclaveIconButton: View {
    let title: String
    let systemImage: String
    let tone: ConclaveIconButtonTone
    let isEnabled: Bool
    let identifier: String
    let action: () -> Void

    init(_ title: String, systemImage: String, tone: ConclaveIconButtonTone = .primary, isEnabled: Bool = true,
         identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.tone = tone
        self.isEnabled = isEnabled
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .accessibilityHidden(true)
                .frame(minWidth: ConclaveButtonMetrics.minimumHeight, minHeight: ConclaveButtonMetrics.minimumHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(tone == .primary ? AnyShapeStyle(.primary) : AnyShapeStyle(HostingTheme.secondaryText))
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityIdentifier(identifier)
    }
}

/// A two-state icon button (for example the Q&A upvote): the system button-style toggle, so it keeps the toggle
/// trait and the selected state; the label stays for accessibility while only the glyph shows.
struct ConclaveIconToggleButton: View {
    let title: String
    let systemImage: String
    let selectedSystemImage: String
    @Binding var isOn: Bool
    let identifier: String

    var body: some View {
        Toggle(isOn: $isOn) {
            Label(title, systemImage: isOn ? selectedSystemImage : systemImage)
                .labelStyle(.iconOnly)
                .frame(minWidth: ConclaveButtonMetrics.minimumHeight, minHeight: ConclaveButtonMetrics.minimumHeight)
        }
        .toggleStyle(.button)
        .accessibilityIdentifier(identifier)
    }
}

/// A panel or sheet Close (F00 C02 c; Q12): the iOS 26 system close role, or the `xmark` glyph on iOS 17 to 25,
/// labelled "Close {title}" on both. Escape closes it. Place it at `.topBarTrailing`. `title` nil keeps the
/// plain "Close" label (S10 R10: the Account sheet, where "Close Account" could be heard as deleting it).
struct ConclaveCloseButton: View {
    let title: String?
    let identifier: String
    let action: () -> Void

    init(title: String?, identifier: String = "panel.close", action: @escaping () -> Void) {
        self.title = title
        self.identifier = identifier
        self.action = action
    }

    private var label: String {
        if let title { return ConclaveStrings.format("Close %@", title) }
        return ConclaveStrings.text("Close")
    }

    var body: some View {
        closeButton
            .keyboardShortcut(.cancelAction)
            .accessibilityLabel(label)
            .accessibilityIdentifier(identifier)
    }

    @ViewBuilder
    private var closeButton: some View {
        if #available(iOS 26.0, *) {
            Button(role: .close, action: action)
        } else {
            Button(action: action) {
                Image(systemName: ConclaveSymbols.xmark)
                    .accessibilityHidden(true)
            }
        }
    }
}
#endif
