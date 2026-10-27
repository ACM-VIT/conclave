#if os(iOS) && !SKIP
import SwiftUI

/// S60 L6-10 (ACT-1) on iOS: one setup option. The server label sits on its own line with the control under it
/// (inside the Form row), so segments get the full row width. Up to four choices or presets render as
/// `ViewThatFits(in: .horizontal) { segmented; menu }`, so labels that overflow at any text size become a menu (Chess
/// "Rapid fire" segments need about 70 pt each); more than four are always a menu (Time control 11, Category 7, the
/// five-preset Time limit). Text keeps what was typed (trimmed only on Start, fixing per-keystroke trimming, INM G2),
/// shows a counter 20 characters before the limit, and promotes a medium sheet to large on focus (F00 C15).
struct GameOptionControl: View {
    let option: GameOptionModel
    let initialText: String
    let isEnabled: Bool
    let onSelect: (String) -> Void
    let onText: (String) -> Void
    @State private var text: String
    @FocusState private var focused: Bool
    @Environment(\.panelPromoteToLargeDetent) private var promoteToLarge

    init(option: GameOptionModel, initialText: String, isEnabled: Bool, onSelect: @escaping (String) -> Void,
         onText: @escaping (String) -> Void) {
        self.option = option
        self.initialText = initialText
        self.isEnabled = isEnabled
        self.onSelect = onSelect
        self.onText = onText
        _text = State(initialValue: initialText)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(option.label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            control
        }
        .padding(.vertical, 2)
        .disabled(!isEnabled)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activities.option." + option.id)
    }

    @ViewBuilder
    private var control: some View {
        if option.kind == GameOptionModel.textKind {
            VStack(alignment: .leading, spacing: 4) {
                TextField(option.label, text: $text, prompt: option.placeholder.isEmpty ? nil : Text(option.placeholder))
                    .focused($focused)
                    .submitLabel(.done)
                    .onChange(of: text) { _, value in
                        var next = value
                        if option.maxLength > 0 && next.count > option.maxLength { next = String(next.prefix(option.maxLength)) }
                        if next != value { text = next }
                        onText(next)
                    }
                    .onChange(of: focused) { _, isFocused in
                        if isFocused { promoteToLarge() }
                    }
                    .accessibilityLabel(option.label)
                if option.maxLength > 0 && text.count >= max(0, option.maxLength - ActivitiesCatalogPolicy.counterLead) {
                    Text(ActivitiesCopy.characterCount(text.count, limit: option.maxLength))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        } else if option.choices.count <= ActivitiesCatalogPolicy.maxSegments {
            ViewThatFits(in: .horizontal) {
                picker.pickerStyle(.segmented)
                picker.pickerStyle(.menu)
            }
        } else {
            picker.pickerStyle(.menu)
        }
    }

    private var picker: some View {
        Picker(option.label, selection: Binding(get: { option.value }, set: { onSelect($0) })) {
            ForEach(option.choices) { choice in
                Text(choice.label).tag(choice.id)
            }
        }
        .labelsHidden()
    }
}
#endif
