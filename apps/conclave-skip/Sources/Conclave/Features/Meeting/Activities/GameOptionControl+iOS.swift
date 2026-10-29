#if os(iOS) && !SKIP
import SwiftUI

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
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .frame(minHeight: 44)
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
