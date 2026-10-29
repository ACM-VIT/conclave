#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

@MainActor
@Observable
final class StageChromeVisibility {
    private(set) var state = ChromeVisibilityState.initial
    @ObservationIgnored private(set) var canAutoHide = false

    func send(_ event: ChromeVisibilityEvent) {
        let next = ChromeAutoHidePolicy.reduce(state, event: event, canAutoHide: canAutoHide)
        if next != state { state = next }
    }

    func setCanAutoHide(_ value: Bool) {
        if canAutoHide == value { return }
        canAutoHide = value
        send(ChromeVisibilityEvent.blockerChanged)
    }
}

struct StageChromeArmKey: Equatable {
    let serial: Int
    let armed: Bool
}

struct StageChromeLayer: View {
    let shell: MeetingShellPresenter
    let stage: StagePresenter
    let chrome: StageChromeVisibility
    let forceScreenReader: Bool
    @State private var layerSize: CGSize = .zero
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilitySwitchControlEnabled) private var switchControl
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        let screenReader = voiceOver || forceScreenReader
        let blocker = ChromeAutoHidePolicy.effectiveBlocker(presenter: stage.autoHideBlocker, screenReader: screenReader,
                                                            focusInChrome: false)
        let canAutoHide = ChromeAutoHidePolicy.canAutoHideHeader(blocker: blocker, voiceOver: screenReader, switchControl: switchControl,
                                                           focusInChrome: false)
        let state = chrome.state
        let hidden = state.isHidden
        let controlsHidden = ChromeAutoHidePolicy.controlsHidden(state, canAutoHide:
            ChromeAutoHidePolicy.canAutoHide(blocker: blocker, voiceOver: screenReader, switchControl: switchControl, focusInChrome: false))
        let compactHeight = verticalSizeClass == .compact
        let capsuleMax = horizontalSizeClass == .regular ? 360 : max(120, layerSize.width * ConclaveChromeMetrics.capsuleMaxWidthFraction)
        ZStack {
            VStack(alignment: .leading, spacing: 8) {
                StageTopRow(stage: stage, capsuleMaxWidth: capsuleMax)
                    .opacity(ChromeAutoHidePolicy.chromeOpacity(state))
                    .allowsHitTesting(!hidden)
                    .accessibilityHidden(hidden)
                    .accessibilitySortPriority(6)
                StageStatusChips(stage: stage)
                    .accessibilitySortPriority(5)
            }
            .padding(.horizontal, CGFloat(DesignTokens.space12))
            .padding(.top, CGFloat(DesignTokens.space12))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            StageBarSlot(shell: shell, stage: stage, available: layerSize)
                .opacity(controlsHidden ? 0 : 1)
                .allowsHitTesting(!controlsHidden)
                .accessibilityHidden(controlsHidden)
                .accessibilitySortPriority(0.5)
                .padding(CGFloat(DesignTokens.space12))

                .padding(.top, compactHeight ? CGFloat(ControlBarPolicy.iosRouteSlot) : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: compactHeight ? .trailing : .bottom)
        }

        .simultaneousGesture(TapGesture().onEnded { chrome.send(ChromeVisibilityEvent.interaction) })
        .animation(ConclaveMotion.fade(ConclaveMotion.chromeFade, reduceMotion: reduceMotion, instantWhenReduced: true), value: hidden)
        .persistentSystemOverlays(controlsHidden ? .hidden : .automatic)

        .statusBarHidden(controlsHidden && compactHeight)
        .onGeometryChange(for: CGSize.self) { proxy in proxy.size } action: { size in layerSize = size }
        .onChange(of: canAutoHide, initial: true) { _, value in chrome.setCanAutoHide(value) }
        .onChange(of: screenReader) { _, on in
            if on { chrome.send(ChromeVisibilityEvent.screenReaderOn) }
        }
        .onChange(of: verticalSizeClass) { _, _ in chrome.send(ChromeVisibilityEvent.rotation) }
        .task(id: StageChromeArmKey(serial: state.armSerial, armed: ChromeAutoHidePolicy.shouldArm(state, canAutoHide: canAutoHide))) {
            guard ChromeAutoHidePolicy.shouldArm(chrome.state, canAutoHide: chrome.canAutoHide) else { return }
            let delay = ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis: ChromeAutoHidePolicy.baseTimeoutMillis,
                                                             holdUntilMillis: stage.recentJoinHoldUntilMillis,
                                                             nowMillis: Date().timeIntervalSince1970 * 1000.0)
            try? await Task.sleep(for: .milliseconds(Int(delay)))
            if Task.isCancelled { return }
            chrome.send(ChromeVisibilityEvent.timerFired)
        }
        .background { StageChromeRevealObserver(shell: shell, chrome: chrome) }
        .modifier(StageAnnouncer(stage: stage))
    }
}

private struct StageChromeRevealObserver: View {
    let shell: MeetingShellPresenter
    let chrome: StageChromeVisibility

    private var microphoneOn: Bool {
        for row in shell.controls.rows {
            if row.id == MeetingControlID.microphone.rawValue { return row.isOn }
        }
        return false
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: microphoneOn) { _, _ in chrome.send(ChromeVisibilityEvent.muteChanged) }
            .onChange(of: shell.panels.snapshot.current == nil) { _, closed in
                if closed { chrome.send(ChromeVisibilityEvent.panelClosed) }
            }
    }
}

private struct StageAnnouncer: ViewModifier {
    let stage: StagePresenter

    func body(content: Content) -> some View {
        content.onChange(of: stage.announcement?.id ?? 0, initial: true) { _, _ in
            guard let announcement = stage.announcement else { return }
            AccessibilityNotification.Announcement(StageAnnouncementText.text(announcement)).post()
        }
    }
}

enum StageAnnouncementText {
    static func text(_ announcement: StageAnnouncement) -> String {
        switch announcement.kind {
        case StageAnnouncement.joinedKind:
            return ConclaveStrings.format("Joined %@", announcement.name)

        case StageAnnouncement.handRaisedKind:
            return ConclaveStrings.text("Hand raised")
        case StageAnnouncement.handLoweredKind:
            return ConclaveStrings.text("Hand lowered")

        case StageNoticeAnnouncementKind.reconnecting:
            return ConclaveStrings.text("Reconnecting")
        case StageNoticeAnnouncementKind.reconnected:
            return ConclaveStrings.text("Reconnected")

        case ActivityStagePolicy.startedAnnouncement, ActivityStagePolicy.endedAnnouncement:
            return ActivityStageCopy.announcement(kind: announcement.kind, name: announcement.name) ?? announcement.name

        case AttendeeViewerPolicy.demotedAnnouncement, AttendeeViewerPolicy.webinarLiveAnnouncement:
            return AttendeeViewerCopy.announcement(kind: announcement.kind) ?? announcement.name
        default:

            return TileAnnouncementText.text(announcement) ?? ShareZoomText.announcement(announcement) ?? announcement.name
        }
    }
}

struct StageTopRow: View {
    let stage: StagePresenter
    let capsuleMaxWidth: CGFloat
    @Environment(CallControlsPresenter.self) private var routeControls: CallControlsPresenter?

    var body: some View {
        ConclaveTopChromeCluster(spacing: CGFloat(DesignTokens.space12)) {
            StageCapsuleButton(stage: stage, maxWidth: capsuleMaxWidth)
            Spacer(minLength: CGFloat(DesignTokens.space8))
            if let routeControls {
                CallRoutePickerButton(controls: routeControls)
            } else {
                ConclaveRoutePickerButton(identifier: "stage.route", onPresentingChange: { open in
                    stage.setTransientChrome(id: ChromeAutoHidePolicy.routePicker, open: open)
                })
            }
        }
    }
}

struct StageCapsuleButton: View {
    let stage: StagePresenter
    let maxWidth: CGFloat

    var body: some View {
        let model = stage.capsule
        let isAttendee = model.subtitleKind == AttendeeViewerPolicy.capsuleLiveKind
        ConclaveMeetingCapsule(title: isAttendee ? AttendeeViewerCopy.title(model.title) : model.title,
                               subtitle: StageCapsuleText.subtitle(model), isLocked: model.isLocked,
                               captionsOn: model.captionsOn, isLive: isAttendee, maxWidth: maxWidth, identifier: "stage.capsule") {
            stage.openMeetingInfo()
        }
        .accessibilityHint(ConclaveStrings.text("Shows meeting details."))
    }
}

enum StageCapsuleText {
    static func subtitle(_ model: StageCapsuleModel) -> String {
        switch model.subtitleKind {
        case StageCapsuleModel.youPresentingKind:
            return ConclaveStrings.text("You’re presenting")
        case StageCapsuleModel.presentingKind:
            return ConclaveStrings.format("%@ is presenting", model.subtitleName)
        case AttendeeViewerPolicy.capsuleLiveKind:

            return AttendeeViewerCopy.capsuleSubtitle()
        case StageCapsuleModel.aloneKind:
            return ConclaveStrings.text("Just you")
        default:
            return ConclaveStrings.format("Participants Count %lld", model.count)
        }
    }
}

struct StageStatusChips: View {
    let stage: StagePresenter

    var body: some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            StageHandChip(stage: stage)
            StageNowPlayingChip(stage: stage)
        }
    }
}

struct StageHandChip: View {
    let stage: StagePresenter
    @State private var lowers = 0

    var body: some View {
        switch stage.localHand {
        case .raised:
            ConclaveStageChip(title: ConclaveStrings.text("Hand Raised"), systemImage: ConclaveSymbols.handRaisedFill,
                              actionTitle: ConclaveStrings.text("Lower"), identifier: "stage.chip.hand",
                              onAction: {
                                  stage.lowerHand()
                                  lowers += 1
                              },
                              actionAccessibilityLabel: ConclaveStrings.text("Lower Hand"))
                .conclaveGestureFeedback(.handLowered, trigger: lowers)
        case .raising:
            ConclaveStageChip(title: ConclaveStrings.text("Raising Hand…"), systemImage: ConclaveSymbols.handRaisedFill,
                              identifier: "stage.chip.hand")
        case .lowering:
            ConclaveStageChip(title: ConclaveStrings.text("Hand Raised"), systemImage: ConclaveSymbols.handRaisedFill,
                              identifier: "stage.chip.hand")
        case .lowered:
            EmptyView()
        }
    }
}

struct StageNowPlayingChip: View {
    let stage: StagePresenter

    var body: some View {
        if let chip = stage.chrome.nowPlaying {
            let name = ActivityStageCopy.displayName(kind: chip.kind, name: chip.name)
            ConclaveStageChip(title: ConclaveStrings.format("%@ Is Running", name), systemImage: StageNowPlayingChip.symbol(chip.kind),
                              actionTitle: ConclaveStrings.text("Show"), identifier: "stage.chip.nowPlaying",
                              onAction: { stage.showHiddenActivity() },
                              actionAccessibilityLabel: ConclaveStrings.format("Show %@", name))
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "app": return ConclaveSymbols.squareGrid2x2
        case "browser": return ConclaveSymbols.globe
        default: return ConclaveSymbols.gamecontrollerFill
        }
    }
}

struct StageBarSlot: View {
    let shell: MeetingShellPresenter
    let stage: StagePresenter
    let available: CGSize
    @Environment(CallControlsPresenter.self) private var controls: CallControlsPresenter?

    var body: some View {
        if let controls {
            CallControlBar(controls: controls, available: available)
        } else {
            Color.clear
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }
}
#endif
