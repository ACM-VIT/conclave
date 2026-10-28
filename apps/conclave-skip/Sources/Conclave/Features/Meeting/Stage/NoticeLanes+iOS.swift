#if os(iOS) && !SKIP
import AVFoundation
import SwiftUI
import UIKit

// S20 10 c (STG-5, SL10): the iOS notice lanes over the dark stage. The banner lane sits under the top chrome slot (and
// under the status chips while they show), the toast lane above the bar slot, and the captions strip (SL11) between
// them, above the toast. Each lane observes only its own presenter property (`banner`, `toast`, `captionsActive`) plus
// the cold `noticeGeometry`; the lanes are overlays outside the tile layout, so a notice never moves a tile, and their
// anchors come from the reserved viewport insets, so they stay put while chrome hides. Banners use F00 C12
// (`ConclaveBanner`, one announcement per new banner), toasts F00 C13 (`ConclaveToastHost` times them and hands the id
// back through `dismissNotice(id:)`; an action toast persists under VoiceOver, Switch Control or the fixture
// screen-reader override). No haptics in either lane (S20 10 h).

/// Fixed lane spacing (points): the chips row under the top row is one 44 pt chip target plus the 8 pt gap.
enum NoticeLaneMetrics {
    static let chipRow: CGFloat = 52
    static let toastGap: CGFloat = 8
    static let maxToastWidth: CGFloat = 560
}

/// The layer CallRoot mounts as a sibling of the chrome. On the live route it installs the notice sound output and
/// removes it when the call root goes away; the fixture's probes never install it (no audio in a silent run).
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

/// Banner lane: reads `stage.banner` and the cold geometry only.
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

/// The one banner. Host notices longer than the lane's four lines expand in place ("More" and "Less", view-local); the
/// catch-up banner is itself a button that opens Transcript at Minutes (S20 10 f row 13).
struct NoticeBannerView: View {
    let stage: StagePresenter
    @State private var expanded = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let notice = stage.banner {
            let banner = ConclaveBanner(kind: NoticeCopy.bannerKind(notice), text: NoticeCopy.bannerText(notice), surface: .inCall,
                                        actions: actions(notice),
                                        onDismiss: notice.isDismissible ? { stage.dismissNotice(id: notice.id) } : nil,
                                        announces: true, lineLimit: expanded ? nil : ConclaveBannerLaneMetrics.lineLimit,
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
            // The app's page in Settings (camera or microphone access); iOS has no captive portal banner.
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        default:
            stage.performNoticeAction(noticeId: notice.id, actionId: actionId)
        }
    }
}

/// The bottom column: the captions strip above the toast, anchored above the bar slot and narrowed to clear a
/// bottom-corner self view.
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

/// Toast lane: reads `stage.toast` only. The hosts time the toast and report it back. CHT-8 (S40 8 c): a chat preview
/// draws the chat variant (`ChatPreviewToast+iOS.swift`); every other kind keeps the F00 C13 toast. Both hosts stay
/// mounted, so each animates its own exit; the presenter shows one toast at a time.
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

/// iOS copy for the notice catalog (S20 10 g; S70 5 g, 6 g, 7 g; S30 4 g): sentence case text, Apple title case
/// action titles. Keys are the String Catalog entries in HD/strings/B4-T4.json.
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
            // Captive portal and notifications priming are Android only.
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
                                 isFailure: notice.isFailure)
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
            // S20 6 g (STG-3, HD request B5-T8 R14): the flip failure toast with Retry.
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
            // The S40 chat variant (title line, private tag, count line) arrives with the chat slices; until then the
            // generic toast shows the sender (or the F00 grouping) and the newest text.
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
            // S50 PL14: a tile-menu People failure ("Couldn't mute Avery Lee." and the typed reasons, S50 3 g).
            return PeopleActionText.stageToast(notice)
        case NoticeKind.blockedExplanation:
            // S30 CC7 (CTL-1, HD request B4-T6 R4): the controls' explanation table names the blocked control's reason.
            if let explanation = ControlBarPolicy.explanation(fromNotice: notice), let text = CallControlsCopy.toast(explanation) {
                return text
            }
            return ConclaveStrings.text("That didn’t go through. Try again.")
        default:
            // shareFailed (S70 10 reasons) resolves through its owner's copy table (SYS-8 request); until then the
            // generic failure sentence stands in.
            return ConclaveStrings.text("That didn’t go through. Try again.")
        }
    }
}

/// SC24 on iOS: the bundled chime through `AVAudioPlayer` on the active call session (WebRTC keeps it in
/// `.playAndRecord`), so it follows the call's audio route; the category is never changed here. No vibration.
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
