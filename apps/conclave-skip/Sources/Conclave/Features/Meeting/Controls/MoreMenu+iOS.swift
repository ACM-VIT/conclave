#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// S30 5 c (CTL-5): the More control on the iOS bar. A native `Menu` (F00 C16, Q2) with `.menuOrder(.priority)` (CL5,
// RECONCILE R8), so the first declared section, the reaction palette, sits nearest the control and the Host submenu
// farthest; it opens as the dark fallback sheet (MoreSheet+iOS.swift, CL16) whenever the menu would not fit without
// scrolling: accessibility text sizes, the iPhone compact-height column, or an estimate (`MoreMenuPolicy`) taller than
// the space above the control. Both read the one `MoreSnapshot`. Feedback triggers live on this control, not on menu
// items (items unmount before a delayed effect could fire, F00 C22 c), and each fires only after the presenter returns
// `dispatched` (S30 5 h): `reactionSent`, `handRaised` or `handLowered` (the kind captured before the tap),
// `linkCopied`, `selectionChanged` on Flip (H2 row 23), `endForEveryonePrompted` when More's End dialog appears.
// Nothing plays on open, panel rows, Invite, Settings or Lock. The End confirmation More asks for is the FND-1 dialog
// attached here (R09); the Leave control keeps its own. Never glass beyond the shared control surface (R02).

struct MoreControl: View {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let diameter: CGFloat
    /// The uncapped text size from the bar (the bar caps its own chrome at `.xxxLarge`).
    let textSize: DynamicTypeSize
    /// The space above the control for the menu (0 in the vertical column).
    let menuSpace: CGFloat
    let isVerticalBar: Bool
    @State private var showsSheet = false
    @State private var showsTray = false
    /// A panel row, End or a share start chosen in the fallback sheet, performed in its `onDismiss` (NF 9.1).
    @State private var deferred: MoreItemID? = nil
    @State private var reactionCounter = 0
    @State private var handCounter = 0
    @State private var handKind = FeedbackKind.handRaised
    @State private var copyCounter = 0
    @State private var flipCounter = 0
    @State private var endPromptCounter = 0
    @State private var lastPromptedId = 0
    /// The confirmation this control already closed, so the binding never shows it again while S1 catches up (the CTL-2
    /// Leave control's rule).
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
                // In-call dark (D3); a sheet scopes the scheme to its own presentation. Rows grow with Dynamic Type
                // (uncapped, S30 5 f Largest text).
                .preferredColorScheme(.dark)
                .dynamicTypeSize(textSize)
        }
        .reactionsTray(isPresented: $showsTray, controls: controls, onSent: { reactionCounter += 1 })
        .conclaveDialog(
            LeaveControlCopy.endDialog(),
            isPresented: Binding(
                get: { confirmationId != closedConfirmationId && MoreMenuPolicy.presentsEndDialog(controls.leaveState) },
                set: { shown in
                    if shown || confirmationId == 0 { return }
                    closedConfirmationId = confirmationId
                    // As on the Leave control: cancel on the next turn, after a confirm may have consumed the id.
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
        .onChange(of: confirmationId) { _, _ in
            // S30 5 h: once per new confirmation More asked for (its row, or its row in the fallback sheet).
            let current = controls.leaveState
            if MoreMenuPolicy.playsEndPrompt(previousId: lastPromptedId, leave: current) {
                endPromptCounter += 1
            }
            lastPromptedId = current.confirmationId
        }
        .onChange(of: showsSheet) { _, open in
            // S30 CC16: an open sheet keeps chrome visible (a system menu holds it through the bar hold, CTL-2).
            controls.stage.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: open)
        }
        .onChange(of: MoreMenuHeightKey(estimate: estimate, space: Double(menuSpace), usesSheet: usesSheet), initial: true) { _, key in
            // CL13 `controls.menuHeight`; never published.
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

    /// The callbacks the menu and the sheet share. Every one runs only after the presenter returned `dispatched`.
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
                // After the menu has dismissed (a popover or sheet never presents from a closing menu).
                Task { @MainActor in showsTray = true }
            },
            selectAfterDismiss: { id in
                deferred = id
                showsSheet = false
            }
        )
    }

    /// The fallback sheet's `onDismiss`: a panel, the End confirmation or a share start, only now that it is gone.
    private func performDeferred() {
        guard let id = deferred else { return }
        deferred = nil
        _ = controls.select(id)
    }
}

/// The count badge (the compact host waiting count) or More's dot, ink on coral, folded into the value (F00 C06).
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

/// What the menu and the fallback sheet call back into the More control (its feedback counters and the deferral).
struct MoreActions {
    /// True in the fallback sheet: panel rows, End and a share start wait for the sheet's dismissal.
    let inSheet: Bool
    let onReaction: () -> Void
    let onHand: (Bool) -> Void
    let onCopy: () -> Void
    let onFlip: () -> Void
    let onMoreReactions: () -> Void
    let selectAfterDismiss: (MoreItemID) -> Void

    /// One row: in the menu every row selects at once (the system closes the menu first); in the sheet the rows that
    /// open something wait for the sheet to go (`MoreMenuPolicy.actsAfterDismiss`).
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

    /// Copy Link: the pasteboard first, then the toast "Link copied" through the presenter (CC7, CL18).
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

/// The menu content (S30 5 c): built when the menu opens [Unverified: SwiftUI builds `Menu` content lazily on iOS 17;
/// if not, it still reads only `more` and `reactions`]. Sections in priority order, first nearest the control.
struct MoreMenuContent: View {
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        let more = controls.more
        ForEach(more.sections) { section in
            switch section.id {
            case MoreSectionID.reactions:
                MoreMenuReactions(section: section, controls: controls, actions: actions)
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

/// The palette (C22: `ControlGroup` with the palette style, nearest the control), or one disabled row with the
/// reason while reactions cannot send (S30 6 f), then "More Reactions…" once flat art ships (Q10).
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

/// One You or Panels row. Captions is a system `Toggle` (checkmark); the hand and share rows flip their titles
/// instead ("Lower Hand", "Stop Sharing", H-06); Layout is one submenu level with the inline mode picker and
/// "Layout Options". A disabled row keeps its place and shows its reason as the subtitle (R10).
struct MoreMenuRow: View {
    let item: MoreItem
    let more: MoreSnapshot
    let controls: CallControlsPresenter
    let actions: MoreActions

    var body: some View {
        switch item.kind {
        case .captions:
            Toggle(isOn: Binding(get: { item.isOn }, set: { on in _ = controls.setCaptions(on) })) {
                MoreRowLabel(title: MoreCopy.title(item), subtitle: MoreCopy.subtitle(item), systemImage: MoreCopy.glyph(item))
            }
            .disabled(!item.isEnabled)
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

/// Invite, Copy Link and Details as one medium `ControlGroup` row (HIG medium layout, IOS 9.2). Invite is the
/// `ShareLink` with the F00 payload and the full label "Share Invite" (CL19, RECONCILE R14); Details reads "Meeting
/// Details".
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
    }
}

/// The Host submenu (one level, HIG): Host Controls, Lock Meeting (a `Toggle`, "Locking…" while pending), then End Call
/// for Everyone… last in its own section (destructive, farthest from the control, CL15). No voice agent (Owner OQ7).
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

/// A row label: the title, the optional subtitle (reason or status) as the second `Text`, and the glyph. Every row
/// in a section carries an icon (H-06).
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

/// CL16: the body text scale for a Dynamic Type size (Apple's body sizes over the 17 pt default: 14, 15, 16, 17,
/// 19, 21, 23; the accessibility sizes always take the sheet, so their values only keep the readout honest).
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

/// iOS copy for More (S30 5 g, 6 g and 7; Apple title case for titles, sentence case for subtitles). String Catalog
/// keys through `ConclaveStrings`. Glyph stand-ins until the CL11 manifest concepts land: Layout uses
/// `rectangleInsetFilledOnRectangle` (for `rectangle.3.group`), Effects `videoFill` (for `camera.filters`), Host Controls
/// `crownFill` (for `person.badge.shield.checkmark.fill`); Layout and Effects are hidden in this push anyway.
enum MoreCopy {
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

    /// The full accessibility label where the visible title is the short form (the medium row).
    static func accessibilityTitle(_ item: MoreItem) -> String {
        switch item.kind {
        case .invite: return ConclaveStrings.text("Share Invite")
        case .meetingDetails: return ConclaveStrings.text("Meeting Details")
        default: return title(item)
        }
    }

    /// The second line: the reason while blocked (S30 7), else the status (5 f); nil for none. A reason never replaces
    /// the title (S30 7 rule 2).
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
        case .layout: return ConclaveSymbols.rectangleInsetFilledOnRectangle
        case .effects, .systemVideoEffects: return ConclaveSymbols.videoFill
        case .settings: return ConclaveSymbols.gearshape
        case .invite: return ConclaveSymbols.squareAndArrowUp
        case .copyLink: return ConclaveSymbols.docOnDoc
        case .meetingDetails: return ConclaveSymbols.infoCircle
        case .hostControls: return ConclaveSymbols.crownFill
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

    /// "React with Thumbs Up" (S30 6 g): a word label, never the glyph (WEB CTL-G2).
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
        // The art names (shown once the flat art ships, CC14).
        case "aura": return ConclaveStrings.text("Aura")
        case "crying": return ConclaveStrings.text("Crying")
        case "goblin": return ConclaveStrings.text("Goblin")
        case "phone": return ConclaveStrings.text("Phone")
        case "sixSeven": return ConclaveStrings.text("Six Seven")
        case "yawn": return ConclaveStrings.text("Yawn")
        default: return nameKey
        }
    }

    /// The FND-2 palette options for the emoji row.
    static func paletteOptions(_ reactions: ReactionPaletteSnapshot) -> [ConclavePaletteOption] {
        var options: [ConclavePaletteOption] = []
        for option in reactions.emoji {
            options.append(ConclavePaletteOption(id: option.id, emoji: option.id, label: reactionLabel(option), isSelected: false))
        }
        return options
    }

    /// The reason the palette shows while it cannot send (the tray footer and the sheet row).
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
