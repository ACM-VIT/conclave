#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// Text fields and the composer field (F00 C19). Single-line fields live in a `Form` or `List` row and keep the
// system field look; the error sits in the section footer. The composer here is the opaque bordered field (the
// R32 design); FND-3's `ConclaveComposerGlass+iOS.swift` wraps it in the iOS 26 Liquid Glass cluster (owner OQ2)
// and adds the accessory slots. Keystrokes stay in the caller's local state; nothing here reaches a presenter
// until submit (F00 C19 k).

/// What a single-line field holds, which picks its keyboard, content type and capitalization.
enum ConclaveTextFieldKind: String, CaseIterable {
    /// A person's display name: words capitalized, name content type, Done.
    case name
    /// A meeting code or link: URL keyboard, no capitalization or autocorrection, Join.
    case code
    /// Free text such as a rename: sentences capitalized, Done.
    case text
}

/// A single-line field for a Form or List row. The prompt names the field (AX); the caller shows the error as
/// `ConclaveFieldError` in the section footer right after it.
struct ConclaveTextField: View {
    let prompt: String
    @Binding var text: String
    let kind: ConclaveTextFieldKind
    let isEnabled: Bool
    let identifier: String
    let onSubmit: () -> Void

    init(_ prompt: String, text: Binding<String>, kind: ConclaveTextFieldKind, isEnabled: Bool = true,
         identifier: String, onSubmit: @escaping () -> Void = {}) {
        self.prompt = prompt
        _text = text
        self.kind = kind
        self.isEnabled = isEnabled
        self.identifier = identifier
        self.onSubmit = onSubmit
    }

    var body: some View {
        TextField(prompt, text: $text)
            .textContentType(contentType)
            .keyboardType(kind == .code ? .URL : .default)
            .textInputAutocapitalization(capitalization)
            .autocorrectionDisabled(kind == .code)
            .submitLabel(kind == .code ? .join : .done)
            .onSubmit(onSubmit)
            .disabled(!isEnabled)
            .accessibilityIdentifier(identifier)
    }

    private var contentType: UITextContentType? {
        switch kind {
        case .name: return .name
        case .code: return .URL
        case .text: return nil
        }
    }

    private var capitalization: TextInputAutocapitalization {
        switch kind {
        case .name: return .words
        case .code: return .never
        case .text: return .sentences
        }
    }
}

/// A field error for the section footer: the octagon glyph in system red with label-colored footnote text, so the
/// meaning never rests on color alone. It follows the field in reading order.
struct ConclaveFieldError: View {
    let text: String
    let identifier: String

    var body: some View {
        Label {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: ConclaveSymbols.exclamationmarkOctagonFill)
                .foregroundStyle(Color(uiColor: .systemRed))
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

/// The near-limit counter ("38/40"), visible from `visibleFrom` characters, with tabular digits and the spoken
/// value "38 of 40 Characters" (F00 C19 f; S10 `DisplayNamePolicy`: cap 40, visible from 30).
struct ConclaveCharacterCounter: View {
    let count: Int
    let limit: Int
    let visibleFrom: Int
    let identifier: String

    var body: some View {
        if count >= visibleFrom {
            Text(ConclaveStrings.format("Character Counter %lld %lld", count, limit))
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(count > limit ? Color(uiColor: .systemRed) : HostingTheme.secondaryText)
                .accessibilityLabel(ConclaveStrings.format("%lld of %lld Characters", count, limit))
                .accessibilityIdentifier(identifier)
        }
    }
}

/// The opaque bordered composer (R32; the fallback of the OQ2 glass cluster): a vertical field growing to six
/// lines beside the Send glyph in coralText (secondary while disabled). No send haptic (Q11).
struct ConclaveComposerField: View {
    let prompt: String
    @Binding var text: String
    let isSendEnabled: Bool
    let identifier: String
    let onSend: () -> Void

    init(_ prompt: String, text: Binding<String>, isSendEnabled: Bool, identifier: String, onSend: @escaping () -> Void) {
        self.prompt = prompt
        _text = text
        self.isSendEnabled = isSendEnabled
        self.identifier = identifier
        self.onSend = onSend
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(prompt, text: $text, axis: .vertical)
                .lineLimit(1...6)
                .textInputAutocapitalization(.sentences)
                .submitLabel(.send)
                .accessibilityIdentifier(identifier)
            ConclaveSendButton(isEnabled: isSendEnabled, identifier: identifier + ".send", action: onSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minHeight: ConclaveButtonMetrics.minimumHeight)
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusBubble), style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusBubble), style: .continuous)
                .strokeBorder(Color(uiColor: .separator), lineWidth: 1)
        }
    }
}

/// The Send glyph: solid coralText, never glass and never coral-tinted glass (F00 C19 c); "Send" for
/// accessibility.
struct ConclaveSendButton: View {
    let isEnabled: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: ConclaveSymbols.arrowUpCircleFill)
                .font(.title2)
                .foregroundStyle(isEnabled ? AnyShapeStyle(HostingTheme.coralText) : AnyShapeStyle(.secondary))
                .frame(minWidth: ConclaveButtonMetrics.minimumHeight, minHeight: ConclaveButtonMetrics.minimumHeight)
                .contentShape(Rectangle())
                .accessibilityHidden(true)
        }
        .buttonStyle(.borderless)
        .disabled(!isEnabled)
        .accessibilityLabel(ConclaveStrings.text("Send"))
        .accessibilityIdentifier(identifier)
    }
}
#endif
