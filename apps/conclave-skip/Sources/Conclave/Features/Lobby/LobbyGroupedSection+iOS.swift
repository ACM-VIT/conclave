#if os(iOS) && !SKIP
import AVKit
import SwiftUI

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

struct LobbyGroupedRow<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
    }
}

struct LobbyGroupedDivider: View {
    var body: some View {
        Divider().padding(.leading, 16)
    }
}

struct LobbyAudioRouteRow: View {
    let premeeting: PremeetingPresenter
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let audio = premeeting.lobbyAudio
        let stacked = dynamicTypeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 8))
        LobbyGroupedRow {
            HStack(spacing: 8) {
                layout {
                    Text(ConclaveStrings.text("Audio"))
                        .layoutPriority(1)
                    Text(LobbyAudioCopy.routeName(kind: audio?.routeKind ?? "", name: audio?.routeName ?? ""))
                        .foregroundStyle(HostingTheme.secondaryText)
                        .multilineTextAlignment(stacked ? .leading : .trailing)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: stacked ? .leading : .trailing)
                }
                .accessibilityElement(children: .combine)
                LobbyRoutePicker(onDismiss: { premeeting.routePickerDidDismiss() })
                    .frame(width: 44, height: 44)
                    .accessibilityIdentifier("lobby.audio.picker")
            }
        }
        .accessibilityIdentifier("lobby.audio")
    }
}

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
