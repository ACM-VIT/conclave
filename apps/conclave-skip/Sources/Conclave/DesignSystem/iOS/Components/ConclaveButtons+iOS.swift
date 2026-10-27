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
#endif
