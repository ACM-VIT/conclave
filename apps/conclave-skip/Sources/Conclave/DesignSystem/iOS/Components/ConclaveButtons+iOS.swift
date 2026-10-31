#if os(iOS) && !SKIP
import SwiftUI

enum ConclaveButtonRole: String, CaseIterable {

    case primary

    case tonal

    case text

    case destructive
}

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
                ButtonTitle(title: title, isPending: isPending, lineLimit: lineLimit, neutralWhenDisabled: true,
                            spinnerTint: HostingTheme.onCoral)
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

    static let disabledOpacity = 0.4
    static let minimumHeight: CGFloat = 44
}

private struct ButtonTitle: View {
    let title: String
    let isPending: Bool
    let lineLimit: Int?
    var neutralWhenDisabled = false

    let spinnerTint: Color?
    @Environment(\.isEnabled) private var isEnabled

    private var usesNeutralLabel: Bool { neutralWhenDisabled && !isEnabled }

    var body: some View {
        HStack(spacing: 8) {
            if isPending {
                ProgressView()
                    .tint(usesNeutralLabel ? Color.primary : spinnerTint)
                    .accessibilityHidden(true)
            }
            Text(title)
                .lineLimit(lineLimit)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .modifier(NeutralLabel(isActive: usesNeutralLabel))
    }
}

private struct NeutralLabel: ViewModifier {
    let isActive: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isActive {
            content.foregroundStyle(Color.primary)
        } else {
            content
        }
    }
}

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

enum ConclaveIconButtonTone: String, CaseIterable {
    case primary, secondary
}

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
