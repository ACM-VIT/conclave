#if os(iOS) && !SKIP
import SwiftUI

struct PermissionPrimingSection: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        let models = rows
        if !models.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(models, id: \.kind) { model in
                    if model.placement == .card {
                        VStack(alignment: .leading, spacing: 0) {
                            PermissionPrimingRow(model: model, onOpenSettings: { premeeting.openSystemSettings() })
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("lobby.camera.denied")
                    } else {
                        PermissionPrimingRow(model: model, onOpenSettings: { premeeting.openSystemSettings() })
                    }
                }
            }
            .padding(.horizontal, 32)
        }
    }

    private var rows: [PermissionPrimingModel] {
        guard let media = premeeting.lobbyMedia else { return [] }
        var models = PermissionPrimingPolicy.rows(media: media, supportsRationale: PermissionPrimingPolicy.platformSupportsRationale,
                                                  microphoneRationaleDismissed: false, cameraRationaleDismissed: false)
        let camera = PermissionPrimingPolicy.model(kind: .camera, permission: media.cameraPermission,
                                                   canAskAgain: media.canAskAgainCamera,
                                                   supportsRationale: PermissionPrimingPolicy.platformSupportsRationale,
                                                   rationaleDismissed: false)
        if camera.placement == .card { models.append(camera) }
        return models
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
            Label {
                Text(model.priming == .restricted
                     ? PermissionPrimingCopy.body(model.kind, priming: model.priming)
                     : PermissionPrimingCopy.title(model.kind))
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHint(PermissionPrimingCopy.body(model.kind, priming: model.priming))
            } icon: {
                Image(systemName: PermissionPrimingCopy.symbol(model.kind))
                    .font(.footnote)
                    .accessibilityHidden(true)
            }
            .foregroundStyle(HostingTheme.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            if PermissionPrimingCopy.showsOpenSettings(model.priming) {
                Button(ConclaveStrings.text("Open Settings"), action: onOpenSettings)
                    .buttonStyle(.borderless)
                    .tint(HostingTheme.coralText)
                    .font(.footnote)
                    .frame(minHeight: 44)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(model.placement == .card ? "lobby.camera.openSettings"
                                             : PermissionPrimingCopy.identifier(model.kind) + ".openSettings")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PermissionPrimingCopy.identifier(model.kind))

        .task(id: model.priming) {
            AccessibilityNotification.Announcement(PermissionPrimingCopy.title(model.kind)).post()
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
