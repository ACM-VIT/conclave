#if os(iOS) && !SKIP
import AVKit
import SwiftUI

// ENT-3 (S10 6 c, L3): the lobby's inset grouped boxes and the audio rows on iOS. Not a `List`: a lazily backed list
// could unload and recreate the preview card's representable at accessibility sizes (F00 P5), so the lobby is a plain
// `ScrollView { VStack }` and these boxes draw the inset grouped look (system list margins, 10 pt continuous corners,
// the secondary grouped background, dividers inset by 16 pt, the footnote footer below).

/// One inset grouped box with an optional footer.
struct LobbyGroupedSection<Content: View>: View {
    let footer: String
    let footerIdentifier: String
    @ViewBuilder let content: () -> Content

    init(footer: String = "", footerIdentifier: String = "", @ViewBuilder content: @escaping () -> Content) {
        self.footer = footer
        self.footerIdentifier = footerIdentifier
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(spacing: 0) {
                content()
            }
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            if !footer.isEmpty {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .accessibilityIdentifier(footerIdentifier)
            }
        }
        .padding(.horizontal, 16)
    }
}

/// A row inside a grouped box: 44 pt minimum, 16 pt leading and trailing insets.
struct LobbyGroupedRow<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
    }
}

/// The divider between rows of one box (inset by 16 pt like a grouped list).
struct LobbyGroupedDivider: View {
    var body: some View {
        Divider().padding(.leading, 16)
    }
}

/// S10 6 c `AudioRouteRow`: "Audio", the route name and the system route picker (`AVRoutePickerView`, coralText tint,
/// 44 pt). The system owns the glyph, the route list and its label; the row records the chosen route as the prejoin
/// intent when the picker closes (S10 0.8 C2), never applying it early.
struct LobbyAudioRouteRow: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        let audio = premeeting.lobbyAudio
        LobbyGroupedRow {
            LabeledContent {
                HStack(spacing: 8) {
                    Text(LobbyAudioCopy.routeName(kind: audio?.routeKind ?? "", name: audio?.routeName ?? ""))
                        .foregroundStyle(HostingTheme.secondaryText)
                        .lineLimit(1)
                    LobbyRoutePicker(onDismiss: { premeeting.routePickerDidDismiss() })
                        .frame(width: 44, height: 44)
                        .accessibilityIdentifier("lobby.audio.picker")
                }
            } label: {
                Text(ConclaveStrings.text("Audio"))
            }
        }
        .accessibilityIdentifier("lobby.audio")
    }
}

/// S10 6 c `MicrophoneInputRow` (iOS 17 and later): a menu `Picker` over the inputs the inactive session lists,
/// shown only when more than one is listed (Q14). The choice is intent only (C2); `setAudioInput` is never called.
struct LobbyMicrophoneInputRow: View {
    let premeeting: PremeetingPresenter

    private var selection: Binding<String> {
        Binding(get: { premeeting.lobbyAudio?.currentInputId ?? "" },
                set: { premeeting.selectAudioInput(id: $0) })
    }

    var body: some View {
        let inputs = premeeting.lobbyAudio?.inputs ?? []
        LobbyGroupedRow {
            Picker(ConclaveStrings.text("Microphone"), selection: selection) {
                ForEach(inputs) { input in
                    Text(input.name).tag(input.id)
                }
            }
            .pickerStyle(.menu)
            .tint(HostingTheme.coralText)
        }
        .accessibilityIdentifier("lobby.microphone")
    }
}

enum LobbyAudioCopy {
    /// The platform's route name, or a name for the kind when the system gives none (receiver, speaker).
    static func routeName(kind: String, name: String) -> String {
        if !name.isEmpty { return name }
        switch AudioRouteKind(rawValue: kind) ?? AudioRouteKind.unknown {
        case .receiver:
            return ConclaveStrings.text("iPhone")
        case .speaker:
            return ConclaveStrings.text("Speaker")
        default:
            return ""
        }
    }
}

/// `AVRoutePickerView` in a system-appearance row: coralText tint, no glass (the picker is the system's control).
private struct LobbyRoutePicker: UIViewRepresentable {
    let onDismiss: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onDismiss: onDismiss)
    }

    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.tintColor = UIColor(HostingTheme.coralText)
        view.activeTintColor = UIColor(HostingTheme.coralText)
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {
        context.coordinator.onDismiss = onDismiss
    }

    final class Coordinator: NSObject, AVRoutePickerViewDelegate {
        var onDismiss: () -> Void

        init(onDismiss: @escaping () -> Void) {
            self.onDismiss = onDismiss
        }

        func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
            onDismiss()
        }
    }
}
#endif
