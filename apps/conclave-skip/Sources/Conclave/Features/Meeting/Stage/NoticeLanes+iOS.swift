#if os(iOS) && !SKIP
import AVFoundation
import SwiftUI
import UIKit

enum NoticeLaneMetrics {
    static let chipRow: CGFloat = 52
    static let toastGap: CGFloat = 8
    static let maxToastWidth: CGFloat = 560
}

struct NoticeLanesLayer: View {
    let stage: StagePresenter
    let forceScreenReader: Bool
    let installsSound: Bool

    var body: some View {
        ZStack {
            NoticeBannerLane(stage: stage)
                .accessibilitySortPriority(4.5)
            NoticeBottomLanes(stage: stage, forceScreenReader: forceScreenReader)
                .accessibilitySortPriority(0.4)
        }
        .ignoresSafeArea()
        .environment(\.colorScheme, .dark)
        .onAppear {
            stage.setNoticePlatform(NoticePlatform.ios)
            if installsSound {
                stage.sounds.output = { kind in NoticeSoundOutput.play(kind) }
            }
        }
        .onDisappear {
            if installsSound { stage.sounds.output = nil }
        }
    }
}

struct NoticeBannerLane: View {
    let stage: StagePresenter

    var body: some View {
        let geometry = stage.noticeGeometry
        let top = CGFloat(geometry.bannerTop) + (geometry.chipsVisible ? NoticeLaneMetrics.chipRow : 0)
        VStack(spacing: 0) {
            ConclaveBannerLane(noticeID: stage.banner?.id, identifier: "stage.banner") {
                NoticeBannerView(stage: stage)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, top)
    }
}

struct NoticeBannerView: View {
    let stage: StagePresenter
    @State private var expanded = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let notice = stage.banner {
            let banner = ConclaveBanner(kind: NoticeCopy.bannerKind(notice), text: NoticeCopy.bannerText(notice), surface: .inCall,
                                        actions: actions(notice),
                                        onDismiss: notice.isDismissible ? { stage.dismissNotice(id: notice.id) } : nil,
                                        announces: notice.announcement != NoticeAnnouncement.none,
                                        isAssertive: notice.announcement == NoticeAnnouncement.assertiveOnce,
                                        lineLimit: expanded ? nil : ConclaveBannerLaneMetrics.lineLimit,
                                        identifier: "stage.banner." + notice.kind)
            if notice.hasAction(NoticeAction.catchUp) {
                banner
                    .contentShape(Rectangle())
                    .onTapGesture { stage.performNoticeAction(noticeId: notice.id, actionId: NoticeAction.catchUp) }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { stage.performNoticeAction(noticeId: notice.id, actionId: NoticeAction.catchUp) }
            } else {
                banner
            }
        }
    }

    private func actions(_ notice: MeetingNotice) -> [ConclaveBannerAction] {
        var result: [ConclaveBannerAction] = []
        for action in notice.actions {
            if action.id == NoticeAction.catchUp { continue }
            let title = NoticeCopy.actionTitle(action.id, expanded: expanded)
            let identifier = "stage.banner." + notice.kind + "." + action.id
            result.append(ConclaveBannerAction(title: title, identifier: identifier, action: {
                perform(action.id, notice: notice)
            }, isEnabled: action.isEnabled,
               disabledHint: action.id == NoticeAction.retryRecovery ? ConclaveStrings.text("Retrying now") : ""))
        }
        return result
    }

    private func perform(_ actionId: String, notice: MeetingNotice) {
        switch actionId {
        case NoticeAction.expand:
            expanded.toggle()
        case NoticeAction.openSettings:

            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        default:
            stage.performNoticeAction(noticeId: notice.id, actionId: actionId)
        }
    }
}

struct NoticeBottomLanes: View {
    let stage: StagePresenter
    let forceScreenReader: Bool
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilitySwitchControlEnabled) private var switchControl

    var body: some View {
        let geometry = stage.noticeGeometry
        VStack(spacing: NoticeLaneMetrics.toastGap) {
            Spacer(minLength: 0)
            CaptionsStripSlot(stage: stage)
            NoticeToastLane(stage: stage, screenReader: voiceOver || switchControl || forceScreenReader)
                .frame(maxWidth: NoticeLaneMetrics.maxToastWidth)
        }
        .frame(maxWidth: .infinity)
        .padding(.leading, CGFloat(geometry.toastLeading))
        .padding(.trailing, CGFloat(geometry.toastTrailing))
        .padding(.bottom, CGFloat(geometry.toastBottom) + NoticeLaneMetrics.toastGap)
    }
}

struct NoticeToastLane: View {
    let stage: StagePresenter
    let screenReader: Bool

    var body: some View {
        let current = stage.toast
        let item = ChatPreviewPolicy.isChatPreview(current) ? nil : current.map { NoticeCopy.toastItem($0) }
        ZStack(alignment: .bottom) {
            ConclaveToastHost(item: item, isScreenReaderRunning: screenReader, identifier: "stage.toast",
                              onAction: { shown in stage.performNoticeAction(noticeId: shown.id, actionId: shown.actionId) },
                              onDismiss: { id in stage.dismissNotice(id: id) })
            ChatPreviewToastHost(stage: stage, screenReader: screenReader)
        }
    }
}

enum NoticeCopy {
    static func bannerKind(_ notice: MeetingNotice) -> ConclaveBannerKind {
        switch notice.severity {
        case .progress: return .reconnecting
        case .warning: return .warning
        case .error: return .error
        case .success: return .success
        case .info: return .info
        }
    }

    static func bannerText(_ notice: MeetingNotice) -> String {
        switch notice.kind {
        case NoticeKind.offline:
            return ConclaveStrings.text("You’re offline. We’ll reconnect when your connection is back.")
        case NoticeKind.reconnecting:
            let title = ConclaveStrings.text("Reconnecting to the meeting…")
            if notice.count > 0 {
                return title + "\n" + ConclaveStrings.format("Attempt %lld of %lld", notice.count, notice.total)
            }
            return title
        case NoticeKind.serverRestart:
            if !notice.serverText.isEmpty { return notice.serverText }
            return ConclaveStrings.text("The meeting server is restarting. You’ll be reconnected automatically.")
        case NoticeKind.recapPosting:
            return ConclaveStrings.text("Conclave is writing the recap in chat. The call ends for everyone once it lands.")
        case NoticeKind.onHold:
            return ConclaveStrings.text("Your call is on hold.")
        case NoticeKind.audioPaused:
            return ConclaveStrings.text("Your audio is paused while another call or app uses it.")
        case NoticeKind.knock:
            if notice.count == 1 && !notice.name.isEmpty {
                return ConclaveStrings.format("%@ wants to join", notice.name)
            }
            return ConclaveStrings.format("People Want To Join %lld", notice.count)
        case NoticeKind.sharing:
            return ConclaveStrings.text("You’re sharing your screen")
        case NoticeKind.shareRestoreFailed:
            return ConclaveStrings.text("Reconnected, but screen sharing stopped.")
        case NoticeKind.shareNotSending:
            return ConclaveStrings.text("Your screen share isn’t sending. Return to the shared screen or share again.")
        case NoticeKind.hostNotice:
            if notice.name.isEmpty { return notice.serverText }
            return ConclaveStrings.format("From %@:", notice.name) + " " + notice.serverText
        case NoticeKind.liveNotesStarted:
            return ConclaveStrings.text("Live notes are on for this meeting.")
        case NoticeKind.catchUp:
            return ConclaveStrings.format("Catch Up Minutes %lld", notice.count)
        case NoticeKind.audioOnly:
            return ConclaveStrings.text("Audio-only mode is on. Video is paused for you.")
        case NoticeKind.veryPoorConnection:
            return ConclaveStrings.text("Your connection is very poor. Audio may cut out.")
        case NoticeKind.permission:
            if notice.detail == MeetingNoticePolicy.permissionMicrophone {
                return ConclaveStrings.text("Microphone access is off. Turn it on in Settings.")
            }
            return ConclaveStrings.text("Camera access is off. Turn it on in Settings.")
        default:

            return ""
        }
    }

    static func actionTitle(_ actionId: String, expanded: Bool) -> String {
        switch actionId {
        case NoticeAction.view: return ConclaveStrings.text("View")
        case NoticeAction.admit: return ConclaveStrings.text("Admit")
        case NoticeAction.admitAll: return ConclaveStrings.text("Admit All")
        case NoticeAction.stopSharing: return ConclaveStrings.text("Stop Sharing")
        case NoticeAction.turnOffAudioOnly: return ConclaveStrings.text("Turn Off")
        case NoticeAction.openSettings: return ConclaveStrings.text("Open Settings")
        case NoticeAction.shareAgain: return ConclaveStrings.text("Share Again")
        case NoticeAction.retry: return ConclaveStrings.text("Retry")
        case NoticeAction.retryRecovery: return ConclaveStrings.text("Retry Now")
        case NoticeAction.resume: return ConclaveStrings.text("Resume")
        case NoticeAction.useAudioOnly: return ConclaveStrings.text("Use Audio Only")
        case NoticeAction.endNow: return ConclaveStrings.text("End Now")
        case NoticeAction.vote: return ConclaveStrings.text("Vote")
        case NoticeAction.expand: return expanded ? ConclaveStrings.text("Less") : ConclaveStrings.text("More")
        default: return ""
        }
    }

    static func toastItem(_ notice: MeetingNotice) -> ConclaveToastItem {
        var actionId = ""
        var actionTitle = ""
        if let first = notice.actions.first {
            actionId = first.id
            actionTitle = NoticeCopy.actionTitle(first.id, expanded: false)
        }
        let showsAvatar = notice.kind == NoticeKind.chatPreview || notice.kind == NoticeKind.handRaised
        return ConclaveToastItem(id: notice.id, message: toastMessage(notice), actionTitle: actionTitle, actionId: actionId,
                                 avatarName: showsAvatar ? notice.name : "", avatarId: showsAvatar ? notice.userId : "",
                                 isFailure: notice.isFailure, isProgress: notice.severity == .progress)
    }

    static func toastMessage(_ notice: MeetingNotice) -> String {
        switch notice.kind {
        case NoticeKind.joined:
            if notice.count > 1 { return ConclaveStrings.format("%@ and %lld others joined", notice.name, notice.count - 1) }
            return ConclaveStrings.format("%@ joined", notice.name)
        case NoticeKind.left:
            return ConclaveStrings.format("%@ left", notice.name)
        case NoticeKind.handRaised:
            if notice.count > 1 { return ConclaveStrings.format("%@ and %lld others raised a hand", notice.name, notice.count - 1) }
            return ConclaveStrings.format("%@ raised a hand", notice.name)
        case NoticeKind.hostMutedYou:
            return ConclaveStrings.text("A host muted your microphone.")
        case NoticeKind.hostCameraOff:
            return ConclaveStrings.text("A host turned off your camera.")
        case NoticeKind.hostLoweredHand:
            return ConclaveStrings.text("A host lowered your hand.")
        case NoticeKind.hostStoppedShare:
            return ConclaveStrings.text("A host stopped your screen share.")
        case NoticeKind.becameHost:
            return ConclaveStrings.text("You’re now a host.")
        case NoticeKind.lostHost:
            return ConclaveStrings.text("You’re no longer a host.")
        case NoticeKind.routeChanged:
            return ConclaveStrings.format("Audio switched to %@", notice.name)
        case NoticeKind.actionFailed:
            if notice.detail == "hand" { return ConclaveStrings.text("Couldn’t raise your hand. Try again.") }

            if notice.detail == "flipCamera" { return ConclaveStrings.text("Couldn’t switch cameras. Try again.") }
            return ConclaveStrings.text("That didn’t go through. Try again.")
        case NoticeKind.rateLimited:
            if notice.detail == "hand" { return ConclaveStrings.text("You’re raising your hand too quickly.") }
            return ConclaveStrings.text("You’re reacting too quickly.")
        case NoticeKind.voteOpened:
            return ConclaveStrings.format("%@ opened a game vote", notice.name)
        case NoticeKind.resumedMuted:
            return ConclaveStrings.text("Your call is back. You’re muted.")
        case NoticeKind.qualityLowered:
            return ConclaveStrings.text("Video quality is lower to keep your device cool.")
        case NoticeKind.chatPreview:

            let title = notice.senderCount > 1
                ? ConclaveStrings.format("%@ and %lld others", notice.name, notice.senderCount - 1) : notice.name
            return notice.detail.isEmpty ? title : title + ": " + notice.detail
        case NoticeKind.endingForEveryone:
            return ConclaveStrings.text("Ending the call for everyone…")
        case NoticeKind.endFailed:
            return ConclaveStrings.text("Couldn’t end the call for everyone. Try again.")
        case NoticeKind.routeFailed:
            return ConclaveStrings.text("Couldn’t switch audio. Try again.")
        case NoticeKind.lockFailed:
            return ConclaveStrings.text("Couldn’t change the meeting lock. Try again.")
        case NoticeKind.linkCopied:
            return ConclaveStrings.text("Link copied")
        case PeopleFailurePlacementPolicy.stageNoticeKind:

            return PeopleActionText.stageToast(notice)
        case NoticeKind.blockedExplanation:

            if let explanation = ControlBarPolicy.explanation(fromNotice: notice), let text = CallControlsCopy.toast(explanation) {
                return text
            }
            return ConclaveStrings.text("That didn’t go through. Try again.")
        case NoticeKind.shareFailed:

            return ConclaveStrings.text(ScreenShareFailurePolicy.iosCopyKey(detail: notice.detail))
        default:
            return ConclaveStrings.text("That didn’t go through. Try again.")
        }
    }
}

@MainActor
enum NoticeSoundOutput {
    private static var players: [String: AVAudioPlayer] = [:]

    static func play(_ kind: String) {
        let name = NoticeSoundKind.assetName(kind)
        var player = players[name]
        if player == nil {
            guard let url = Bundle.module.url(forResource: name, withExtension: "mp3"),
                  let created = try? AVAudioPlayer(contentsOf: url) else { return }
            created.volume = 0.6
            created.prepareToPlay()
            players[name] = created
            player = created
        }
        guard let ready = player else { return }
        ready.currentTime = 0
        ready.play()
    }
}
#endif
