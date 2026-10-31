#if os(iOS) && !SKIP
import SwiftUI

struct LobbyStatusSection: View {
    let premeeting: PremeetingPresenter
    let nameFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var settled = false

    private static let settleMillis = 300

    var body: some View {
        let status = premeeting.lobbyStatus
        let rows = LobbyStatusPolicy.rows(status: status, media: routedMedia(status),
                                          supportsRationale: PermissionPrimingPolicy.platformSupportsRationale,
                                          offersAppInfo: LobbyStatusPolicy.platformOffersAppInfo)
        let inSlot = dynamicTypeSize.isAccessibilitySize
        let current = inSlot ? LobbyStatusCopy.line(status: status, isSignedIn: isSignedIn(status)) : nil
        let nameReason = status?.intent == .newMeeting ? LobbyPrimaryReason.nameMissingStart : LobbyPrimaryReason.nameMissingJoin
        let reserved = inSlot && nameFocused ? LobbyPrimaryCopy.reason(nameReason.rawValue) : nil
        let slotLine = current ?? LobbyStatusCopy.reservedLine(reserved)
        VStack(alignment: .leading, spacing: 4) {
            if let line = slotLine {
                LobbyStatusLineLabel(line: line)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .opacity(current == nil ? 0 : 1)
                    .accessibilityHidden(current == nil)
                    .accessibilityIdentifier(line.identifier)
            }
            ForEach(rows, id: \.kind) { model in
                if model.kind == .camera {
                    VStack(alignment: .leading, spacing: 0) {
                        LobbyStatusRow(model: model, onAction: { perform(model) })
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("lobby.camera.denied")
                } else {
                    LobbyStatusRow(model: model, onAction: { perform(model) })
                }
            }
        }
        .padding(.horizontal, 32)
        .padding(.bottom, rows.isEmpty && slotLine == nil ? 0 : 16)
        .onChange(of: rows) { previous, next in
            guard settled else { return }
            for row in next where !previous.contains(row) {
                EntryStatusAnnouncer.announce(LobbyStatusCopy.text(row))
            }
        }
        .task {
            try? await Task.sleep(for: .milliseconds(Self.settleMillis))
            if Task.isCancelled { return }
            settled = true
        }
    }

    private func routedMedia(_ status: LobbyStatusSnapshot?) -> LobbyMediaSnapshot? {
        guard let media = premeeting.lobbyMedia else { return nil }
        guard let status else { return media }
        return media.routeId == status.routeId ? media : nil
    }

    private func isSignedIn(_ status: LobbyStatusSnapshot?) -> Bool {
        guard let status, let identity = premeeting.lobbyIdentity, identity.routeId == status.routeId else { return false }
        return identity.isSignedIn
    }

    private func perform(_ model: LobbyStatusRowModel) {
        switch model.action {
        case .openSettings:
            premeeting.openSystemSettings()
        case .allow:
            if model.mediaKind == .camera {
                premeeting.setCameraIntent(true)
            } else {
                premeeting.setMicIntent(true)
            }
        case .none:
            break
        }
    }
}

struct LobbyStatusRow: View {
    let model: LobbyStatusRowModel
    let onAction: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        layout {
            Label {
                Text(LobbyStatusCopy.text(model))
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: LobbyStatusCopy.symbol(model))
                    .font(.footnote)
                    .accessibilityHidden(true)
            }
            .foregroundStyle(HostingTheme.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            if model.action != LobbyStatusRowAction.none {
                Button(action: onAction) {
                    Text(LobbyStatusCopy.actionTitle(model.action))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .tint(HostingTheme.coralText)
                .font(.footnote)
                .accessibilityHint(LobbyStatusCopy.hint(model))
                .accessibilityIdentifier(LobbyStatusCopy.actionIdentifier(model))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(LobbyStatusCopy.identifier(model))
    }
}

struct LobbyStatusLineText: Equatable {
    let kind: LobbyStatusLineKind
    let text: String
    let symbol: String
    let identifier: String
}

struct LobbyStatusLineLabel: View {
    let line: LobbyStatusLineText

    var body: some View {
        if line.symbol.isEmpty {
            Text(line.text)
        } else {
            Label(line.text, systemImage: line.symbol)
                .labelStyle(.titleAndIcon)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(line.text)
                .accessibilityAddTraits(.isStaticText)
        }
    }
}

enum LobbyStatusCopy {
    static func text(_ model: LobbyStatusRowModel) -> String {
        switch model.kind {
        case .issue:
            return ConclaveStrings.text("Your Phone Paused Conclave")
        case .media:
            return model.restricted ? ConclaveStrings.text("Microphone and Camera Restricted")
                : ConclaveStrings.text("No Microphone or Camera Access")
        case .microphone:
            return model.restricted ? ConclaveStrings.text("Microphone Access Is Restricted") : PermissionPrimingCopy.title(.microphone)
        case .camera:
            return model.restricted ? ConclaveStrings.text("Camera Access Is Restricted") : PermissionPrimingCopy.title(.camera)
        }
    }

    static func symbol(_ model: LobbyStatusRowModel) -> String {
        switch model.kind {
        case .issue:
            return ConclaveSymbols.infoCircle
        case .camera:
            return PermissionPrimingCopy.symbol(.camera)
        case .microphone, .media:
            return PermissionPrimingCopy.symbol(.microphone)
        }
    }

    static func identifier(_ model: LobbyStatusRowModel) -> String {
        switch model.kind {
        case .issue:
            return "lobby.issue"
        case .media:
            return "lobby.media.permission"
        case .microphone:
            return PermissionPrimingCopy.identifier(.microphone)
        case .camera:
            return PermissionPrimingCopy.identifier(.camera)
        }
    }

    static func actionIdentifier(_ model: LobbyStatusRowModel) -> String {
        let base: String
        switch model.kind {
        case .issue:
            base = "lobby.issue"
        case .media:
            base = "lobby.media"
        case .microphone:
            base = "lobby.microphone"
        case .camera:
            base = "lobby.camera"
        }
        return base + "." + model.action.rawValue
    }

    static func actionTitle(_ action: LobbyStatusRowAction) -> String {
        switch action {
        case .openSettings:
            return ConclaveStrings.text("Open Settings")
        case .allow:
            return ConclaveStrings.text("Allow")
        case .none:
            return ""
        }
    }

    static func hint(_ model: LobbyStatusRowModel) -> String {
        switch model.kind {
        case .media:
            return ConclaveStrings.text("Allow microphone and camera access in Settings.")
        case .microphone:
            return PermissionPrimingCopy.body(.microphone, priming: .openSettings)
        case .camera:
            return PermissionPrimingCopy.body(.camera, priming: .openSettings)
        case .issue:
            return ""
        }
    }

    static func line(status: LobbyStatusSnapshot?, isSignedIn: Bool) -> LobbyStatusLineText? {
        guard let status else { return nil }
        let kind = LobbyStatusPolicy.line(status: status, isSignedIn: isSignedIn)
        let text = lineText(kind, status: status)
        guard !text.isEmpty else { return nil }
        return LobbyStatusLineText(kind: kind, text: text, symbol: lineSymbol(kind), identifier: lineIdentifier(kind, mode: status.mode))
    }

    static func lineIdentifier(_ kind: LobbyStatusLineKind, mode: LobbyMode) -> String {
        mode == .editing && kind == .failedServerText ? "lobby.primary.reason" : LobbyStatusPolicy.lineIdentifier(kind)
    }

    static func announcesLine(_ kind: LobbyStatusLineKind, mode: LobbyMode) -> Bool {
        LobbyStatusPolicy.announcesLine(kind) && (kind != .failedServerText || mode == .editing)
    }

    static func reservedLine(_ text: String?) -> LobbyStatusLineText? {
        guard let text, !text.isEmpty else { return nil }
        return LobbyStatusLineText(kind: .nameMissing, text: text, symbol: "",
                                   identifier: LobbyStatusPolicy.lineIdentifier(.nameMissing))
    }

    static func lineText(_ kind: LobbyStatusLineKind, status: LobbyStatusSnapshot) -> String {
        switch kind {
        case .none:
            return ""
        case .nameMissing:
            return LobbyPrimaryCopy.reason(status.primaryReason) ?? ""
        case .offline:
            return LobbyPrimaryCopy.reason(LobbyPrimaryReason.offline.rawValue) ?? ""
        case .updateRequired:
            return ConclaveStrings.text("Update Conclave to join")
        case .signInRequired:
            return ConclaveStrings.text("Sign in to join")
        case .roomNotFound:
            return ConclaveStrings.text("Meeting not found")
        case .stillConnecting:
            return ConclaveStrings.text("Still connecting")
        case .failedNetwork:
            return ConclaveStrings.text("Couldn\u{2019}t reach Conclave")
        case .failedMedia:
            return ConclaveStrings.text("Audio and video didn\u{2019}t connect")
        case .failedServerBusy:
            return ConclaveStrings.text("Server is busy")
        case .failedServerText:
            return LobbyStatusPolicy.serverLine(status.issueServerText)
        case .failedUnknown:
            return status.intent == .newMeeting ? ConclaveStrings.text("Couldn\u{2019}t start") : ConclaveStrings.text("Couldn\u{2019}t join")
        case .waitingStandard:
            return ConclaveStrings.text("Hang tight.")
        case .waitingLocked:
            return ConclaveStrings.text("This meeting is locked")
        case .waitingNoHost:
            return ConclaveStrings.text("No one can let you in yet")
        case .waitingHostAvailable:
            return ConclaveStrings.text("A host is here")
        case .waitingReconnecting:
            return ConclaveStrings.text("Reconnecting, you\u{2019}ll keep your place")
        case .waitingOffline:
            return ConclaveStrings.text("You\u{2019}re offline, you\u{2019}ll keep your place")
        case .waitingServerRestarting:
            return status.waitingText.isEmpty ? ConclaveStrings.text("Server is restarting")
                : LobbyStatusPolicy.serverLine(status.waitingText)
        }
    }

    static func lineSymbol(_ kind: LobbyStatusLineKind) -> String {
        switch kind {
        case .offline, .waitingOffline:
            return ConclaveSymbols.wifiSlash
        case .stillConnecting, .failedNetwork:
            return ConclaveSymbols.wifiExclamationmark
        case .updateRequired, .roomNotFound, .failedMedia, .failedServerBusy, .failedServerText, .failedUnknown:
            return ConclaveSymbols.infoCircle
        case .none, .nameMissing, .signInRequired, .waitingStandard, .waitingLocked, .waitingNoHost, .waitingHostAvailable,
             .waitingReconnecting, .waitingServerRestarting:
            return ""
        }
    }
}
#endif
