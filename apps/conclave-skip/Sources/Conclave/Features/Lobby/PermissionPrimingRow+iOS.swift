#if os(iOS) && !SKIP
import SwiftUI

// ENT-4 (S10 7 b, c, e, f, g, h, i): permission priming in context on iOS. There is no pre-alert screen: the first tap
// on a lobby toggle asks (the lobby is the context, HIG Privacy), and a refusal is explained where it matters. The
// microphone gets an issue row in the list under the card (system colors, the statusWarning glyph, a coralText Open
// Settings); the camera gets the overlay inside the dark card (the neutral bordered Open Settings, never coral, so the
// lobby keeps one coral action). Restricted shows the same places without a button. iOS has no rationale flow, so it
// never asks twice (S10 7 g). No animation and no haptic: the system prompt was the interaction (7 h).

/// The rows under the card, microphone first. Reads `premeeting.lobbyMedia` only (S10 6 k).
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

/// S10 7 c: a `Label` titled "Microphone Access Is Off" with the micSlash symbol, the body and a trailing Open Settings
/// (borderless, coralText); the button moves under the text at accessibility sizes. One container, announced once when
/// it appears (7 i).
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
        // Once per appearance of this priming (a body re-run never repeats it).
        .task(id: model.priming) {
            AccessibilityNotification.Announcement(PermissionPrimingCopy.title(model.kind)).post()
        }
    }
}

/// S10 7 c `PermissionOverlay`: camera denied (or restricted) inside the dark card's video area. Title, body and the
/// neutral bordered Open Settings (in-call text tint, never coral); restricted has no button. One container, announced
/// once when it appears.
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

/// The iOS copy (S10 7 g; Apple title case for titles and buttons, sentence case for bodies and hints).
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

    /// iOS has no rationale flow, so a denial always routes to Settings; restricted has no route.
    static func showsOpenSettings(_ priming: PermissionPrimingKind) -> Bool {
        priming == .openSettings || priming == .rationale
    }

    /// S10 7 i: the toggle's hint while it reads Off because of the permission ("" for none).
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

    /// The microphone row keeps ENT-3's identifier (silent runs read it).
    static func identifier(_ kind: LobbyMediaKind) -> String {
        kind == .camera ? "lobby.camera.permission" : "lobby.microphone.denied"
    }
}
#endif
