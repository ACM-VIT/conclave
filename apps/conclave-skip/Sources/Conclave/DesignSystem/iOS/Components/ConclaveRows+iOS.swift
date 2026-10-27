#if os(iOS) && !SKIP
import SwiftUI

// List rows (F00 C09) and the person row (F00 C10) for `List(.insetGrouped)` and the dark panels. Rows use the
// native controls, so they keep the system semantics, chevrons and haptics: the toggle row is the green system
// switch, never tinted (R06), and adds no haptic of its own (F00 8). Titles wrap; `lineLimit` defaults to none
// (OQ-2b-5) for screens whose geometry needs a cap.

/// A title with a value (C09). At accessibility text sizes the value moves under the title.
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

/// A navigation row with the system chevron and traits; never a hand-drawn chevron (C09).
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

/// A settings switch row: the native green `Toggle`, untinted (R06).
struct ConclaveToggleRow: View {
    let title: String
    @Binding var isOn: Bool
    let identifier: String

    var body: some View {
        Toggle(title, isOn: $isOn)
            .accessibilityIdentifier(identifier)
    }
}

/// A destructive row: the destructive role, so the system draws it red.
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

/// One choice of a single-choice group: a checkmark row with the selected trait (C09). It plays nothing on iOS
/// (F00 C09 e).
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

// MARK: Person row (F00 C10, OQ-2b-8)

/// The leading avatar stand-in until FND-1's C07 avatar: a flat circle from the avatar palette at a stated index,
/// hidden from accessibility, with no text and no contrast pair.
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

/// A person: a leading slot, the name and an optional detail, and status glyphs that accessibility never reads on
/// their own. The name and detail are one element; `statusValue` carries the status ("Muted, Hand Raised").
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

/// The C10 waiting variant: Deny (text) and Admit (tonal, never coral) are separate focusable elements labelled
/// with the name, after the combined name element.
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
#endif
