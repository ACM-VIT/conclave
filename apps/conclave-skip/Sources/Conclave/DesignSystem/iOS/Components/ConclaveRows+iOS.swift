#if os(iOS) && !SKIP
import SwiftUI

struct ConclaveValueRow: View {
    let title: String
    let value: String
    let identifier: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                    Text(value)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
                .accessibilityElement(children: .combine)
            } else {
                LabeledContent(title, value: value)
            }
        }
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveNavigationRow<Destination: View>: View {
    let title: String
    let identifier: String
    @ViewBuilder let destination: () -> Destination

    var body: some View {
        NavigationLink {
            destination()
        } label: {
            Text(title)
        }
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveToggleRow: View {
    let title: String
    @Binding var isOn: Bool
    let identifier: String

    var body: some View {
        Toggle(title, isOn: $isOn)
            .accessibilityIdentifier(identifier)
    }
}

struct ConclaveDestructiveRow: View {
    let title: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(role: .destructive, action: action) {
            Text(title)
        }
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveSelectableRow: View {
    let title: String
    let isSelected: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isSelected {
                    Image(systemName: ConclaveSymbols.checkmark)
                        .foregroundStyle(HostingTheme.coralText)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(minHeight: ConclaveRowMetrics.minimumHeight)
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : [.isButton])
        .accessibilityIdentifier(identifier)
    }
}

enum ConclaveRowMetrics {
    static let minimumHeight: CGFloat = 44
    static let avatarDiameter: CGFloat = 40
}

struct ConclaveAvatarStandIn: View {
    let paletteIndex: Int
    @ScaledMetric(relativeTo: .body) private var diameter = ConclaveRowMetrics.avatarDiameter

    var body: some View {
        let palette = DesignTokens.avatarPalette
        Circle()
            .fill(HostingTheme.token(palette[((paletteIndex % palette.count) + palette.count) % palette.count]))
            .frame(width: diameter, height: diameter)
            .accessibilityHidden(true)
    }
}

struct ConclavePersonRow<Leading: View>: View {
    let name: String
    let detail: String?
    let statusValue: String?
    let statusSymbols: [String]
    let lineLimit: Int?
    let identifier: String
    @ViewBuilder let leading: () -> Leading

    init(name: String, detail: String? = nil, statusValue: String? = nil, statusSymbols: [String] = [],
         lineLimit: Int? = nil, identifier: String, @ViewBuilder leading: @escaping () -> Leading) {
        self.name = name
        self.detail = detail
        self.statusValue = statusValue
        self.statusSymbols = statusSymbols
        self.lineLimit = lineLimit
        self.identifier = identifier
        self.leading = leading
    }

    var body: some View {
        HStack(spacing: 12) {
            leading()
            PersonText(name: name, detail: detail, lineLimit: lineLimit)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                ForEach(statusSymbols, id: \.self) { symbol in
                    Image(systemName: symbol)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
            }
            .accessibilityHidden(true)
        }
        .frame(minHeight: ConclaveRowMetrics.minimumHeight)
        .accessibilityElement(children: .combine)
        .modifier(PersonStatusValue(text: statusValue))
        .accessibilityIdentifier(identifier)
    }
}

extension ConclavePersonRow where Leading == ConclaveAvatarStandIn {
    init(name: String, detail: String? = nil, statusValue: String? = nil, statusSymbols: [String] = [],
         avatarPaletteIndex: Int, lineLimit: Int? = nil, identifier: String) {
        self.init(name: name, detail: detail, statusValue: statusValue, statusSymbols: statusSymbols,
                  lineLimit: lineLimit, identifier: identifier) {
            ConclaveAvatarStandIn(paletteIndex: avatarPaletteIndex)
        }
    }
}

struct ConclaveWaitingPersonRow: View {
    let name: String
    let avatarPaletteIndex: Int
    let lineLimit: Int?
    let identifier: String
    let onDeny: () -> Void
    let onAdmit: () -> Void

    init(name: String, avatarPaletteIndex: Int, lineLimit: Int? = nil, identifier: String,
         onDeny: @escaping () -> Void, onAdmit: @escaping () -> Void) {
        self.name = name
        self.avatarPaletteIndex = avatarPaletteIndex
        self.lineLimit = lineLimit
        self.identifier = identifier
        self.onDeny = onDeny
        self.onAdmit = onAdmit
    }

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 12) {
                ConclaveAvatarStandIn(paletteIndex: avatarPaletteIndex)
                PersonText(name: name, detail: nil, lineLimit: lineLimit)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button(action: onDeny) {
                Text(ConclaveStrings.text("Deny"))
                    .frame(minHeight: ConclaveRowMetrics.minimumHeight)
            }
            .buttonStyle(.borderless)
            .tint(HostingTheme.coralText)
            .accessibilityLabel(ConclaveStrings.format("Deny %@", name))
            .accessibilityIdentifier(identifier + ".deny")
            Button(action: onAdmit) {
                Text(ConclaveStrings.text("Admit"))
            }
            .buttonStyle(.bordered)
            .tint(Color.primary)
            .controlSize(.large)
            .accessibilityLabel(ConclaveStrings.format("Admit %@", name))
            .accessibilityIdentifier(identifier + ".admit")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

private struct PersonText: View {
    let name: String
    let detail: String?
    let lineLimit: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
                .font(.body)
                .lineLimit(lineLimit)
                .fixedSize(horizontal: false, vertical: true)
            if let detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct PersonStatusValue: ViewModifier {
    let text: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let text {
            content.accessibilityValue(text)
        } else {
            content
        }
    }
}

struct ConclaveSectionHeader: View {
    let title: String
    let count: Int?
    let identifier: String

    init(_ title: String, count: Int? = nil, identifier: String) {
        self.title = title
        self.count = count
        self.identifier = identifier
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let count {
                Text(count, format: .number)
                    .monospacedDigit()
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier(identifier)
    }
}

struct ConclaveSectionFooter: View {
    let text: String
    let identifier: String

    init(_ text: String, identifier: String) {
        self.text = text
        self.identifier = identifier
    }

    var body: some View {
        Text(text)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(identifier)
    }
}
#endif
