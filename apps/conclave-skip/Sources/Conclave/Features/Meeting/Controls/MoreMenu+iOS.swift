#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct MoreControl: View {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let diameter: CGFloat

    let textSize: DynamicTypeSize

    let menuSpace: CGFloat
    let isVerticalBar: Bool
    @State private var showsSheet = false
    @State private var showsTray = false

    @State private var deferred: MoreItemID? = nil
    @State private var reactionCounter = 0
    @State private var handCounter = 0
    @State private var handKind = FeedbackKind.handRaised
    @State private var copyCounter = 0
    @State private var flipCounter = 0
    @State private var endPromptCounter = 0
    @State private var lastPromptedId = 0

    @State private var closedConfirmationId = 0

    private var isEngaged: Bool { showsSheet || showsTray }

    var body: some View {
        let metrics = controls.moreMetrics
        let estimate = MoreMenuPolicy.estimatedHeight(metrics, textScale: MoreTextScale.of(textSize))
        let usesSheet = MoreMenuPolicy.usesSheet(estimate: estimate, menuSpace: Double(menuSpace),
                                                 isAccessibilitySize: textSize.isAccessibilitySize, isVerticalBar: isVerticalBar)
        let confirmationId = controls.leaveState.confirmationId
        let visual = isEngaged ? CallControlVisual.engaged : CallControlVisual.on
        Group {
            if usesSheet {
                Button {
                    _ = controls.tap(CallControlKind.more)
                    showsSheet = true
                } label: {
                    CallControlGlyph(systemImage: ConclaveSymbols.ellipsis, showsSpinner: false, visual: visual)
                }
                .buttonStyle(CallControlSurfaceStyle(visual: visual, isBlocked: model.isBlocked, diameter: diameter))
            } else {
                Menu {
                    MoreMenuContent(controls: controls, actions: actions(inSheet: false))
                } label: {
                    CallControlSurfaceBody(label: CallControlGlyph(systemImage: ConclaveSymbols.ellipsis, showsSpinner: false, visual: visual),
                                           isPressed: false, visual: visual, isBlocked: model.isBlocked, diameter: diameter)
                }
                .menuOrder(.priority)
                .menuIndicator(.hidden)
            }
        }
        .disabled(model.reason == ControlBlockedReason.leaving)
        .overlay(alignment: .topTrailing) { MoreBadge(model: model) }
        .accessibilityLabel(CallControlsCopy.title(CallControlKind.more))
        .modifier(CallControlValue(text: CallControlsCopy.invokerValue(model)))
        .accessibilityAddTraits(isEngaged ? [.isSelected] : [])
        .accessibilityShowsLargeContentViewer {
            Label(CallControlsCopy.title(CallControlKind.more), systemImage: ConclaveSymbols.ellipsis)
        }
        .help(CallControlsCopy.title(CallControlKind.more))
        .accessibilityIdentifier("control.more")
        .sheet(isPresented: $showsSheet, onDismiss: performDeferred) {
            MoreSheet(controls: controls, actions: actions(inSheet: true), onClose: { showsSheet = false })
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)

                .preferredColorScheme(.dark)
                .dynamicTypeSize(textSize)
        }
        .reactionsTray(isPresented: $showsTray, controls: controls, onSent: { reactionCounter += 1 })
        .conclaveDialog(
            LeaveControlCopy.endDialog(),
            isPresented: Binding(
                get: { confirmationId != closedConfirmationId && MoreMenuPolicy.presentsEndDialog(controls.leaveState)
                    && !controls.leaveState.offersRecap },
                set: { shown in
                    if shown || confirmationId == 0 { return }
                    closedConfirmationId = confirmationId

                    Task { @MainActor in
                        if controls.leaveState.confirmationId == confirmationId {
                            controls.cancelEnd(id: confirmationId)
                        }
                    }
                }
            ),
            identifier: "control.more.endDialog",
            onConfirm: { _ = controls.confirmEndForEveryone(id: confirmationId, postRecap: false) },
            onCancel: { controls.cancelEnd(id: confirmationId) }
        )

        .recapEndDialog(
            controls: controls,
            confirmationId: confirmationId,
            isPresented: Binding(
                get: { confirmationId != closedConfirmationId && MoreMenuPolicy.presentsEndDialog(controls.leaveState)
                    && controls.leaveState.offersRecap },
                set: { shown in
                    if shown || confirmationId == 0 { return }
                    closedConfirmationId = confirmationId
                    Task { @MainActor in
                        if controls.leaveState.confirmationId == confirmationId {
                            controls.cancelEnd(id: confirmationId)
                        }
                    }
                }
            ),
            identifier: "control.more.endDialog.recap",
            onCancel: { controls.cancelEnd(id: confirmationId) }
        )
        .onChange(of: confirmationId) { _, _ in

            let current = controls.leaveState
            if MoreMenuPolicy.playsEndPrompt(previousId: lastPromptedId, leave: current) {
                endPromptCounter += 1
            }
            lastPromptedId = current.confirmationId
        }
        .onChange(of: showsSheet) { _, open in

            controls.stage.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: open)
        }
        .onChange(of: MoreMenuHeightKey(estimate: estimate, space: Double(menuSpace), usesSheet: usesSheet), initial: true) { _, key in

            controls.reportMenuHeight(MoreMenuPolicy.menuHeightReadout(estimate: key.estimate, space: key.space, usesSheet: key.usesSheet))
        }
        .onDisappear {
            if showsSheet { controls.stage.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: false) }
        }
        .conclaveGestureFeedback(.reactionSent, trigger: reactionCounter)
        .conclaveGestureFeedback(handKind, trigger: handCounter)
        .conclaveGestureFeedback(.linkCopied, trigger: copyCounter)
        .conclaveGestureFeedback(.selectionChanged, trigger: flipCounter)
        .conclaveGestureFeedback(.endForEveryonePrompted, trigger: endPromptCounter)
    }

    private func actions(inSheet: Bool) -> MoreActions {
        MoreActions(
            inSheet: inSheet,
            onReaction: { reactionCounter += 1 },
            onHand: { raising in
                handKind = raising ? FeedbackKind.handRaised : FeedbackKind.handLowered
                handCounter += 1
            },
            onCopy: { copyCounter += 1 },
            onFlip: { flipCounter += 1 },
            onMoreReactions: {

                Task { @MainActor in showsTray = true }
            },
            selectAfterDismiss: { id in
                deferred = id
                showsSheet = false
            }
        )
    }

    private func performDeferred() {
        guard let id = deferred else { return }
        deferred = nil
        _ = controls.select(id)
    }
}

private struct MoreBadge: View {
    let model: CallControlModel
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        Group {
            if model.badgeCount > 0 {
                ConclaveCountBadge(count: model.badgeCount)
            } else if model.showsDot {
                ConclaveDotBadge()
            }
        }
        .offset(x: layoutDirection == .rightToLeft ? -4 : 4, y: -4)
    }
}

struct MoreMenuHeightKey: Equatable {
    let estimate: Double
    let space: Double
    let usesSheet: Bool
}

struct MoreActions {

    let inSheet: Bool
    let onReaction: () -> Void
    let onHand: (Bool) -> Void
    let onCopy: () -> Void
    let onFlip: () -> Void
    let onMoreReactions: () -> Void
    let selectAfterDismiss: (MoreItemID) -> Void

    @MainActor
    func choose(_ item: MoreItem, controls: CallControlsPresenter) {
        if inSheet && MoreMenuPolicy.actsAfterDismiss(item) {
            selectAfterDismiss(item.kind)
            return
        }
        switch item.kind {
        case .hand:
            let raising = !item.isOn
            if controls.select(MoreItemID.hand) == ControlTapResult.dispatched { onHand(raising) }
        case .flipCamera:
            if controls.select(MoreItemID.flipCamera) == ControlTapResult.dispatched { onFlip() }
        case .moreReactions:
            if controls.select(MoreItemID.moreReactions) == ControlTapResult.dispatched { onMoreReactions() }
        default:
            _ = controls.select(item.kind)
        }
    }

    @MainActor
    func copyLink(_ link: String, controls: CallControlsPresenter) {
        if let url = URL(string: link) {
            UIPasteboard.general.url = url
        } else {
            UIPasteboard.general.string = link
        }
        if controls.copyLink(postsToast: true) == ControlTapResult.dispatched { onCopy() }
    }

    @MainActor
    func sendReaction(_ id: String, controls: CallControlsPresenter) {
        if controls.sendReaction(id: id) == ControlTapResult.dispatched { onReaction() }
    }
}

struct MoreMenuContent: View {
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        let more = controls.more
        ForEach(more.sections) { section in
            switch section.id {
            case MoreSectionID.reactions:
                Section {
                    MoreMenuReactions(section: section, controls: controls, actions: actions)
                }
            case MoreSectionID.share:
                Section {
                    MoreShareGroup(section: section, more: more, controls: controls, actions: actions)
                }
            case MoreSectionID.host:
                Section {
                    Menu {
                        MoreHostItems(section: section, controls: controls, actions: actions)
                    } label: {
                        Label(ConclaveStrings.text("Host"), systemImage: ConclaveSymbols.crownFill)
                    }
                }
            default:
                Section {
                    ForEach(section.items) { item in
                        MoreMenuRow(item: item, more: more, controls: controls, actions: actions)
                    }
                }
            }
        }
    }
}

private struct MoreMenuReactions: View {
    let section: MoreSection
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        let reactions = controls.reactions
        if reactions.isAvailable {
            ConclaveReactionPalette(options: MoreCopy.paletteOptions(reactions), identifier: "control.more.reactions") { option in
                actions.sendReaction(option.id, controls: controls)
            }
        } else if let item = section.items.first {
            Button {} label: {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(true)
        }
        if let art = section.items.first(where: { $0.kind == MoreItemID.moreReactions }) {
            Button {
                actions.choose(art, controls: controls)
            } label: {
                MoreRowLabel(title: MoreCopy.title(art), subtitle: nil, systemImage: MoreCopy.glyph(art))
            }
            .disabled(!art.isEnabled)
        }
    }
}

struct MoreMenuRow: View {
    let item: MoreItem
    let more: MoreSnapshot
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        switch item.kind {
        case .captions:
            Button {
                _ = controls.setCaptions(!item.isOn)
            } label: {
                Label(MoreCopy.captionsStateTitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(!item.isEnabled)
            .accessibilityLabel(MoreCopy.captionsStateTitle(item))
            .accessibilityHint(MoreCopy.subtitle(item) ?? "")
            .accessibilityAddTraits(.isToggle)
            .accessibilityIdentifier("control.more." + item.id)
        case .layout:
            Menu {
                Picker(selection: Binding(get: { more.layoutMode }, set: { raw in _ = controls.setLayoutMode(raw) })) {
                    ForEach(more.layoutModes, id: \.self) { raw in
                        Text(MoreCopy.layoutTitle(raw)).tag(raw)
                    }
                } label: {
                    Text(MoreCopy.title(item))
                }
                .pickerStyle(.inline)
                Button(ConclaveStrings.text("Layout Options")) {
                    actions.choose(item, controls: controls)
                }
            } label: {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("control.more." + item.id)
        default:
            Button {
                actions.choose(item, controls: controls)
            } label: {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(!item.isEnabled)
            .accessibilityIdentifier("control.more." + item.id)
        }
    }
}

private struct MoreShareGroup: View {
    let section: MoreSection
    let more: MoreSnapshot
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        ControlGroup {
            ForEach(section.items) { item in
                switch item.kind {
                case .invite:
                    if let url = URL(string: more.meetingLink) {
                        ShareLink(item: url, subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                                  message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                                  preview: SharePreview(Text(more.roomLabel))) {
                            Label(MoreCopy.title(item), systemImage: MoreCopy.glyph(item))
                        }
                        .accessibilityLabel(ConclaveStrings.text("Share Invite"))
                        .accessibilityIdentifier("control.more.invite")
                    }
                case .copyLink:
                    Button {
                        actions.copyLink(more.meetingLink, controls: controls)
                    } label: {
                        Label(MoreCopy.title(item), systemImage: MoreCopy.glyph(item))
                    }
                    .accessibilityIdentifier("control.more.copyLink")
                default:
                    Button {
                        actions.choose(item, controls: controls)
                    } label: {
                        Label(MoreCopy.title(item), systemImage: MoreCopy.glyph(item))
                    }
                    .accessibilityLabel(MoreCopy.accessibilityTitle(item))
                    .accessibilityIdentifier("control.more." + item.id)
                }
            }
        }
        .controlGroupStyle(.compactMenu)
    }
}

struct MoreHostItems: View {
    let section: MoreSection
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        ForEach(section.items) { item in
            switch item.kind {
            case .lockMeeting:
                Toggle(isOn: Binding(get: { item.isOn }, set: { _ in actions.choose(item, controls: controls) })) {
                    MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
                }
                .disabled(!item.isEnabled)
                .accessibilityIdentifier("control.more.lockMeeting")
            case .endForEveryone:
                Section {
                    Button(role: .destructive) {
                        actions.choose(item, controls: controls)
                    } label: {
                        MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
                    }
                    .disabled(!item.isEnabled)
                    .accessibilityIdentifier("control.more.endForEveryone")
                }
            default:
                Button {
                    actions.choose(item, controls: controls)
                } label: {
                    MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
                }
                .disabled(!item.isEnabled)
                .accessibilityIdentifier("control.more." + item.id)
            }
        }
    }
}

struct MoreRowLabel: View {
    let title: String
    let subtitle: String?
    let systemImage: String

    var body: some View {
        Label {
            Text(title)
            if let subtitle {
                Text(subtitle)
            }
        } icon: {
            Image(systemName: systemImage)
        }
    }
}

enum MoreTextScale {
    static func of(_ size: DynamicTypeSize) -> Double {
        switch size {
        case .xSmall: return 14.0 / 17.0
        case .small: return 15.0 / 17.0
        case .medium: return 16.0 / 17.0
        case .large: return 1.0
        case .xLarge: return 19.0 / 17.0
        case .xxLarge: return 21.0 / 17.0
        case .xxxLarge: return 23.0 / 17.0
        case .accessibility1: return 28.0 / 17.0
        case .accessibility2: return 33.0 / 17.0
        case .accessibility3: return 40.0 / 17.0
        case .accessibility4: return 47.0 / 17.0
        case .accessibility5: return 53.0 / 17.0
        @unknown default: return 1.0
        }
    }
}

enum MoreCopy {
    static func captionsStateTitle(_ item: MoreItem) -> String {
        ConclaveStrings.format("Option Summary %@ %@", title(item), ConclaveStrings.text(item.isOn ? "On" : "Off"))
    }

    static func title(_ item: MoreItem) -> String {
        switch item.kind {
        case .reactions: return ConclaveStrings.text("Reactions Are Off")
        case .moreReactions: return ConclaveStrings.text("More Reactions…")
        case .hand:
            switch MoreMenuPolicy.handState(item) {
            case .raising: return ConclaveStrings.text("Raising Hand…")
            case .lowering: return ConclaveStrings.text("Lowering Hand…")
            case .raised: return ConclaveStrings.text("Lower Hand")
            case .lowered: return ConclaveStrings.text("Raise Hand")
            }
        case .screenShare: return item.isOn ? ConclaveStrings.text("Stop Sharing") : ConclaveStrings.text("Share Screen")
        case .captions: return ConclaveStrings.text("Captions")
        case .flipCamera: return ConclaveStrings.text("Flip Camera")
        case .chat: return ConclaveStrings.text("Chat")
        case .participants: return ConclaveStrings.text("Participants")
        case .activities: return ConclaveStrings.text("Activities")
        case .transcript: return ConclaveStrings.text("Transcript")
        case .qa: return ConclaveStrings.text("Questions and Answers")
        case .layout: return ConclaveStrings.text("Layout")
        case .effects: return ConclaveStrings.text("Effects")
        case .systemVideoEffects: return ConclaveStrings.text("Video Effects…")
        case .settings: return ConclaveStrings.text("Settings")
        case .invite: return ConclaveStrings.text("Invite")
        case .copyLink: return ConclaveStrings.text("Copy Link")
        case .meetingDetails: return ConclaveStrings.text("Details")
        case .hostControls: return ConclaveStrings.text("Host Controls")
        case .lockMeeting:
            if item.isPending { return item.isOn ? ConclaveStrings.text("Unlocking…") : ConclaveStrings.text("Locking…") }
            return ConclaveStrings.text("Lock Meeting")
        case .endForEveryone:
            return item.isPending || item.reason == ControlBlockedReason.ending
                ? ConclaveStrings.text("Ending…") : ConclaveStrings.text("End Call for Everyone…")
        }
    }

    static func accessibilityTitle(_ item: MoreItem) -> String {
        switch item.kind {
        case .invite: return ConclaveStrings.text("Share Invite")
        case .meetingDetails: return ConclaveStrings.text("Meeting Details")
        default: return title(item)
        }
    }

    static func subtitle(_ item: MoreItem) -> String? {
        if !item.isEnabled && !item.isPending {
            if item.kind == MoreItemID.reactions && item.reason == ControlBlockedReason.disabledByHost {
                return ConclaveStrings.text("Turned off by the host")
            }
            switch item.reason {
            case .reconnecting, .offline, .remoteShareActive, .audioOnly, .disabledByHost:
                return CallControlsCopy.reasonText(item.reason, name: item.reasonName)
            default:
                break
            }
        }
        switch item.status {
        case .waiting: return ConclaveStrings.format("%lld waiting to join", item.count)
        case .unseen: return ConclaveStrings.format("%lld new", item.count)
        case .unread: return ConclaveStrings.format("%lld unread", item.count)
        case .running: return ConclaveStrings.format("%@ is running", item.statusName)
        case .voteOpen: return ConclaveStrings.text("Vote open")
        case .whiteboard: return ConclaveStrings.text("Whiteboard open")
        case .live: return ConclaveStrings.text("Live")
        case .paused: return ConclaveStrings.text("Paused")
        case .attention: return ConclaveStrings.text("Needs attention")
        case .notesOff: return ConclaveStrings.text("Starts when live notes are on")
        default: break
        }
        if item.kind == MoreItemID.layout { return layoutTitle(item.statusName) }
        return nil
    }

    static func glyph(_ item: MoreItem) -> String {
        switch item.kind {
        case .reactions, .moreReactions: return ConclaveSymbols.faceSmiling
        case .hand: return item.isOn ? ConclaveSymbols.handRaisedFill : ConclaveSymbols.handRaised
        case .screenShare: return item.isOn ? ConclaveSymbols.rectangleOnRectangleSlash : ConclaveSymbols.rectangleOnRectangle
        case .captions: return item.isOn ? ConclaveSymbols.captionsBubbleFill : ConclaveSymbols.captionsBubble
        case .flipCamera: return ConclaveSymbols.arrowTriangle2CirclepathCamera
        case .chat: return ConclaveSymbols.message
        case .participants: return ConclaveSymbols.person2
        case .activities: return ConclaveSymbols.squareGrid2x2
        case .transcript: return ConclaveSymbols.textQuote
        case .qa: return ConclaveSymbols.questionmarkBubble
        case .layout: return ConclaveSymbols.rectangle3Group
        case .effects, .systemVideoEffects: return ConclaveSymbols.cameraFilters
        case .settings: return ConclaveSymbols.gearshape
        case .invite: return ConclaveSymbols.squareAndArrowUp
        case .copyLink: return ConclaveSymbols.docOnDoc
        case .meetingDetails: return ConclaveSymbols.infoCircle
        case .hostControls: return ConclaveSymbols.personBadgeShieldCheckmarkFill
        case .lockMeeting: return item.isOn ? ConclaveSymbols.lockFill : ConclaveSymbols.lockOpen
        case .endForEveryone: return ConclaveSymbols.phoneDownFill
        }
    }

    static func layoutTitle(_ raw: String) -> String {
        switch raw {
        case "tiled": return ConclaveStrings.text("Tiled")
        case "spotlight": return ConclaveStrings.text("Spotlight")
        case "sidebar": return ConclaveStrings.text("Sidebar")
        default: return ConclaveStrings.text("Auto")
        }
    }

    static func reactionLabel(_ option: ReactionOptionModel) -> String {
        ConclaveStrings.format("React with %@", reactionName(option.nameKey))
    }

    static func reactionName(_ nameKey: String) -> String {
        switch nameKey {
        case "thumbsUp": return ConclaveStrings.text("Thumbs Up")
        case "clap": return ConclaveStrings.text("Clap")
        case "laugh": return ConclaveStrings.text("Laugh")
        case "heart": return ConclaveStrings.text("Heart")
        case "party": return ConclaveStrings.text("Party")
        case "wow": return ConclaveStrings.text("Wow")

        case "aura": return ConclaveStrings.text("Aura")
        case "crying": return ConclaveStrings.text("Crying")
        case "goblin": return ConclaveStrings.text("Goblin")
        case "phone": return ConclaveStrings.text("Phone")
        case "sixSeven": return ConclaveStrings.text("Six Seven")
        case "yawn": return ConclaveStrings.text("Yawn")
        default: return nameKey
        }
    }

    static func paletteOptions(_ reactions: ReactionPaletteSnapshot) -> [ConclavePaletteOption] {
        var options: [ConclavePaletteOption] = []
        for option in reactions.emoji {
            options.append(ConclavePaletteOption(id: option.id, emoji: option.id, label: reactionLabel(option), isSelected: false))
        }
        return options
    }

    static func reactionsReason(_ reactions: ReactionPaletteSnapshot) -> String? {
        switch reactions.availability {
        case .disabledByHost: return ConclaveStrings.text("Turned off by the host")
        case .reconnecting: return ConclaveStrings.text("Available after reconnecting")
        case .offline: return ConclaveStrings.text("Available when you’re back online")
        default: return nil
        }
    }
}
#endif
