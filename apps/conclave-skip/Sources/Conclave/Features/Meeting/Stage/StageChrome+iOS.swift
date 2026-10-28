#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

// S20 7 and 8 (STG-4): the top chrome (meeting capsule plus the system route picker in one glass cluster through the
// single glass entry; CTL-3 routes the picker's report through the controls presenter), the flat status chips (never
// glass, they stay while chrome hides), the bar slot (the S30 control bar, CTL-1) and chrome visibility.
// `StageChromeLayer` is the only view that reads `chrome.state.isHidden`; it owns `.persistentSystemOverlays` and the
// status bar. The one timer is a view-local one-shot keyed on the arm serial:
// nothing ticks while chrome is hidden or blocked (RR8).

/// View-local chrome visibility (SL8): the pure `ChromeAutoHidePolicy` state machine plus whether hiding is allowed,
/// which the chrome layer refreshes from the blocker and the assistive-technology state.
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

/// The one-shot timer's identity: a new serial or a change in eligibility cancels the running sleep.
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
        let canAutoHide = ChromeAutoHidePolicy.canAutoHide(blocker: blocker, voiceOver: screenReader, switchControl: switchControl,
                                                           focusInChrome: false)
        let state = chrome.state
        let hidden = state.isHidden
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
                .opacity(ChromeAutoHidePolicy.chromeOpacity(state))
                .allowsHitTesting(!hidden)
                .accessibilityHidden(hidden)
                .accessibilitySortPriority(0.5)
                .padding(CGFloat(DesignTokens.space12))
                // The compact-height column sits below the route control (S30 1 b, S20 7).
                .padding(.top, compactHeight ? CGFloat(ControlBarPolicy.iosRouteSlot) : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: compactHeight ? .trailing : .bottom)
        }
        // Any interaction with visible chrome re-arms the timer; empty areas pass taps to the canvas below.
        .simultaneousGesture(TapGesture().onEnded { chrome.send(ChromeVisibilityEvent.interaction) })
        .animation(ConclaveMotion.fade(ConclaveMotion.chromeFade, reduceMotion: reduceMotion, instantWhenReduced: true), value: hidden)
        .persistentSystemOverlays(hidden ? .hidden : .automatic)
        // The status bar hides with chrome only in compact-height landscape (S20 1 c).
        .statusBarHidden(hidden && compactHeight)
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

/// Reveal triggers from the S1 snapshots (S20 8 f): your mute state changing for any reason and a panel closing. A
/// zero-size leaf, so control-row churn never re-evaluates the chrome layer.
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

/// One-shot announcements through one channel (S20 1 i): stage entry and later the pin, presenting and activity
/// announcements STG-2, STG-3 and STG-9 add.
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
        // CTL-6 (S30 CC7, 6 i; HD request B6-T3 R3): your own hand change, once the server confirms it.
        case StageAnnouncement.handRaisedKind:
            return ConclaveStrings.text("Hand raised")
        case StageAnnouncement.handLoweredKind:
            return ConclaveStrings.text("Hand lowered")
        // STG-5 (S70 R70-1): recovery starts and ends on the same one-shot channel (HD request B4-T4 R4).
        case StageNoticeAnnouncementKind.reconnecting:
            return ConclaveStrings.text("Reconnecting")
        case StageNoticeAnnouncementKind.reconnected:
            return ConclaveStrings.text("Reconnected")
        // STG-9 (S20 11 g, i; HD request B4-T8 R7): activity start and end, with the app's localized name.
        case ActivityStagePolicy.startedAnnouncement, ActivityStagePolicy.endedAnnouncement:
            return ActivityStageCopy.announcement(kind: announcement.kind, name: announcement.name) ?? announcement.name
        // STG-8 (S20 12 f, i): "You're now watching as an attendee." and "The webinar is live." (B5-T2 R5).
        case AttendeeViewerPolicy.demotedAnnouncement, AttendeeViewerPolicy.webinarLiveAnnouncement:
            return AttendeeViewerCopy.announcement(kind: announcement.kind) ?? announcement.name
        default:
            // STG-2 pin announcements (TileMenu+iOS.swift; HD request B4-T5 R8), then STG-3's "%@ started presenting"
            // (ShareZoom+iOS.swift; HD request B5-T8 R12).
            return TileAnnouncementText.text(announcement) ?? ShareZoomText.announcement(announcement) ?? announcement.name
        }
    }
}

/// Capsule plus the system route picker in one `GlassEffectContainer` on iOS 26 (the single glass entry's cluster);
/// no minimize on iOS (system PiP covers it). The route picker is created once per stage (C03 k). CTL-3 (S30 3 c): with
/// the call's controls presenter in the environment (the native call route and the controls fixture) the route button
/// reports through it (`CallRoutePickerButton`: the auto-hide blocker plus the route owner's picker window, S70 5 c);
/// the stage fixtures without one keep the stage-only report.
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

/// Observes only `stage.capsule` (S20 7 k).
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

/// Capsule subtitle copy (S20 7 g).
enum StageCapsuleText {
    static func subtitle(_ model: StageCapsuleModel) -> String {
        switch model.subtitleKind {
        case StageCapsuleModel.youPresentingKind:
            return ConclaveStrings.text("You’re presenting")
        case StageCapsuleModel.presentingKind:
            return ConclaveStrings.format("%@ is presenting", model.subtitleName)
        case AttendeeViewerPolicy.capsuleLiveKind:
            // S20 12 c (STG-8): attendees see the webinar title and "Live", never a count.
            return AttendeeViewerCopy.capsuleSubtitle()
        case StageCapsuleModel.aloneKind:
            return ConclaveStrings.text("Just you")
        default:
            return ConclaveStrings.format("Participants Count %lld", model.count)
        }
    }
}

/// Status chips: flat label-scrim capsules with a 1 pt border, outside the glass cluster, visible while chrome hides
/// (S20 SR3). Each chip observes only its own property.
struct StageStatusChips: View {
    let stage: StagePresenter

    var body: some View {
        HStack(spacing: CGFloat(DesignTokens.space8)) {
            StageHandChip(stage: stage)
            StageNowPlayingChip(stage: stage)
            StageShareInviteChip(stage: stage)
        }
    }
}

/// Your raised hand (SC12): "Raising Hand…" while the ticket is pending, then "Hand Raised" with Lower.
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

/// A hidden activity keeps running behind Show Video (S20 7, 11).
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

/// Solo with your camera on: the card collapses to a Share Invite chip under the capsule so your face stays visible
/// (S20 2 c). The chip look is the flat stage chip; the action is the system share sheet.
struct StageShareInviteChip: View {
    let stage: StagePresenter

    var body: some View {
        let layout = stage.layout
        if layout.kind == .solo && layout.isAloneConfirmed, let localId = layout.slots.first?.userId,
           let url = URL(string: layout.meetingLink), !layout.meetingLink.isEmpty {
            StageShareInviteChipGate(entry: stage.tileChrome.entry(for: localId), url: url, roomLabel: stage.capsule.title)
        }
    }
}

private struct StageShareInviteChipGate: View {
    let entry: TileChromeEntry
    let url: URL
    let roomLabel: String

    var body: some View {
        if !entry.model.isCameraOff {
            ShareLink(item: url, subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                      message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                      preview: SharePreview(Text(roomLabel))) {
                Label(ConclaveStrings.text("Share Invite"), systemImage: ConclaveSymbols.squareAndArrowUp)
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(.horizontal, 12)
                    .frame(minHeight: ConclaveStageChipMetrics.targetHeight)
                    .background(HostingTheme.inCallLabelScrim, in: Capsule())
                    .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
            }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .accessibilityIdentifier("stage.chip.shareInvite")
        }
    }
}

/// The control bar slot (S30 1, CTL-1). The controls presenter arrives through the environment from whoever mounts the
/// call root (the native call route and the controls fixture), so the call root's signature stays the stage owner's;
/// without one the slot reserves no pixels (the canvas already reserves the bar's space) and draws nothing. The bar is
/// an overlay sibling of the canvas: showing, hiding or recomposing it never relayouts tiles (S30 1 k).
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
