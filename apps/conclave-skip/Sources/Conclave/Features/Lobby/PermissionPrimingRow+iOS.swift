#if os(iOS) && !SKIP
import SwiftUI

struct PermissionPrimingSection: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        ForEach(rows, id: \.kind) { model in
            LobbyGroupedSection {
                LobbyGroupedRow {
                    PermissionPrimingRow(model: model, onOpenSettings: { premeeting.openSystemSettings() })
                }
            }
        }
    }

    private var rows: [PermissionPrimingModel] {
        guard let media = premeeting.lobbyMedia else { return [] }
        return PermissionPrimingPolicy.rows(media: media, supportsRationale: PermissionPrimingPolicy.platformSupportsRationale,
                                            microphoneRationaleDismissed: false, cameraRationaleDismissed: false)
    }
}

struct PermissionPrimingRow: View {
    let model: PermissionPrimingModel
    let onOpenSettings: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 4) {
                Label {
                    Text(PermissionPrimingCopy.title(model.kind))
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: PermissionPrimingCopy.symbol(model.kind))
                        .foregroundStyle(HostingTheme.statusWarning)
                        .accessibilityHidden(true)
                }
                Text(PermissionPrimingCopy.body(model.kind, priming: model.priming))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if PermissionPrimingCopy.showsOpenSettings(model.priming) {
                Button(ConclaveStrings.text("Open Settings"), action: onOpenSettings)
                    .buttonStyle(.borderless)
                    .tint(HostingTheme.coralText)
                    .fixedSize()
                    .accessibilityIdentifier(PermissionPrimingCopy.identifier(model.kind) + ".openSettings")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PermissionPrimingCopy.identifier(model.kind))

        .task(id: model.priming) {
            AccessibilityNotification.Announcement(PermissionPrimingCopy.title(model.kind)).post()
        }
    }
}

struct PermissionPrimingCardOverlay: View {
    let priming: PermissionPrimingKind
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: ConclaveSymbols.videoSlash)
                .font(.title2)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .accessibilityHidden(true)
            Text(PermissionPrimingCopy.title(.camera))
                .font(.headline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .multilineTextAlignment(.center)
            Text(PermissionPrimingCopy.body(.camera, priming: priming))
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if PermissionPrimingCopy.showsOpenSettings(priming) {
                Button(ConclaveStrings.text("Open Settings"), action: onOpenSettings)
                    .buttonStyle(.bordered)
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                    .accessibilityIdentifier("lobby.camera.openSettings")
            }
        }
        .padding(20)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lobby.camera.denied")
        .task(id: priming) {
            AccessibilityNotification.Announcement(PermissionPrimingCopy.title(.camera)).post()
        }
    }
}

enum PermissionPrimingCopy {
    static func title(_ kind: LobbyMediaKind) -> String {
        kind == .camera ? ConclaveStrings.text("Camera Access Is Off") : ConclaveStrings.text("Microphone Access Is Off")
    }

    static func body(_ kind: LobbyMediaKind, priming: PermissionPrimingKind) -> String {
        switch priming {
        case .restricted:
            return kind == .camera
                ? ConclaveStrings.text("Camera access is restricted on this device.")
                : ConclaveStrings.text("Microphone access is restricted on this device.")
        case .none, .rationale, .openSettings:
            return kind == .camera
                ? ConclaveStrings.text("Allow camera access in Settings to use video in meetings.")
                : ConclaveStrings.text("Allow microphone access in Settings so people can hear you.")
        }
    }

    static func showsOpenSettings(_ priming: PermissionPrimingKind) -> Bool {
        priming == .openSettings || priming == .rationale
    }

    static func hint(_ kind: LobbyMediaKind, reason: PermissionPrimingKind) -> String {
        switch reason {
        case .openSettings:
            return kind == .camera
                ? ConclaveStrings.text("Camera access is off in Settings.")
                : ConclaveStrings.text("Microphone access is off in Settings.")
        case .restricted:
            return kind == .camera
                ? ConclaveStrings.text("Camera access is restricted on this device.")
                : ConclaveStrings.text("Microphone access is restricted on this device.")
        case .none, .rationale:
            return ""
        }
    }

    static func symbol(_ kind: LobbyMediaKind) -> String {
        kind == .camera ? ConclaveSymbols.videoSlash : ConclaveSymbols.micSlash
    }

    static func identifier(_ kind: LobbyMediaKind) -> String {
        kind == .camera ? "lobby.camera.permission" : "lobby.microphone.denied"
    }
}
#endif
