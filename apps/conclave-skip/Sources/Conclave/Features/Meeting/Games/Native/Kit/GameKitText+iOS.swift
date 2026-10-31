#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

struct GameKitPrompt: View {
    let kicker: String
    let title: String
    var subtitle: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !kicker.isEmpty {
                Text(kicker)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
            if !title.isEmpty {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .lineLimit(5)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct GameKitTag: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(HostingTheme.token(DesignTokens.iosInCallSurfaceHigh), in: Capsule())
            .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
    }
}

struct GameKitSeatControl: View {
    let seat: SeatState
    let onJoin: () -> Void

    var body: some View {
        switch seat {
        case .canJoin:
            Button(action: onJoin) {
                Text(ConclaveStrings.text("Join"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HostingTheme.inCallOnCoral)
            }
            .buttonStyle(.borderedProminent)
            .tint(HostingTheme.coralFill)
            .controlSize(.small)
            .frame(minHeight: 44)
            .accessibilityLabel(ConclaveStrings.text("Join the Game"))
            .accessibilityIdentifier("game.seat.join")
        case .joiningNextRound, .watching:
            if let tag = GameCopy.seatTag(seat) {
                GameKitTag(title: tag)
                    .accessibilityIdentifier("game.seat.tag")
            }
        case .player:
            EmptyView()
        }
    }
}

struct GameKitNotice: View {
    let kind: GameKitNoticeKind
    let message: String
    var buttonTitle: String = ""
    var onButton: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                glyph
                VStack(alignment: .leading, spacing: 4) {
                    if let title = GameCopy.noticeTitle(kind) {
                        Text(title)
                            .font(.headline)
                            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !message.isEmpty {
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if let onButton = onButton, !buttonTitle.isEmpty {
                Button(buttonTitle, action: onButton)
                    .buttonStyle(.bordered)
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("game.notice.action")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                    in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("game.notice." + kind.rawValue)
        .task(id: announcement) {
            if announcement.isEmpty { return }
            AccessibilityNotification.Announcement(announcement).post()
        }
    }

    private var announcement: String {
        let title = GameCopy.noticeTitle(kind) ?? ""
        if title.isEmpty { return message }
        return message.isEmpty ? title : title + ". " + message
    }

    @ViewBuilder
    private var glyph: some View {
        switch kind {
        case .privateView, .reconnecting:
            ProgressView()
                .tint(HostingTheme.token(DesignTokens.iosInCallText))
        case .failure:
            Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallWarning))
                .accessibilityHidden(true)
        case .unsupported:
            Image(systemName: ConclaveSymbols.exclamationmarkOctagonFill)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .accessibilityHidden(true)
        case .spectator, .info:
            Image(systemName: ConclaveSymbols.infoCircle)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .accessibilityHidden(true)
        }
    }
}
#endif
