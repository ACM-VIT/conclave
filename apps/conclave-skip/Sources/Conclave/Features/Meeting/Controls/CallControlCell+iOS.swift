#if os(iOS) && !SKIP
import SwiftUI

// S30 1 c (CTL-1): one bar cell per `CallControlModel`. Each cell reads only its model (S30 1 k). The surface comes from
// the single glass entry (`conclaveControlSurface`, ConclaveCallControl+iOS.swift; R02, F00 4): Off and Engaged are
// paper, On is glass on iOS 26 and the opaque fallback below it and under Reduce Transparency. A blocked control keeps
// hit testing and draws the 40% treatment; its tap explains instead of dispatching (CL6, Q11). `.disabled` is used only
// while leaving. Toggles use the TG 4.2 form of the WP1-2b call toggle (a Button with the toggle trait, a constant
// label and the state in the value), so VoiceOver and Voice Control read the real state from `isOn`.

/// Switches on the control kind. Leave is the CTL-2 `LeaveControl` (LeaveControl+iOS.swift), which reads only
/// `controls.leaveState`; More is the CTL-5 `MoreControl` (MoreMenu+iOS.swift: the native menu or the dark fallback
/// sheet). `isAccessibilityText`, `textSize` (uncapped) and `menuSpace` (the room above the bar) come from the bar
/// (S30 1 c, 4 c, 5 c); `isVerticalBar` is the iPhone compact-height column, where More always takes the sheet (CL16).
struct CallControlCell: View {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let diameter: CGFloat
    let isAccessibilityText: Bool
    var textSize: DynamicTypeSize = DynamicTypeSize.large
    var menuSpace: CGFloat = 0
    var isVerticalBar: Bool = false

    var body: some View {
        switch model.kind {
        case .microphone, .camera, .screenShare, .hand:
            CallControlToggleCell(model: model, controls: controls, diameter: diameter)
        case .chat, .participants, .qa:
            CallControlInvokerCell(model: model, controls: controls, diameter: diameter)
        case .more:
            MoreControl(model: model, controls: controls, diameter: diameter, textSize: textSize, menuSpace: menuSpace,
                        isVerticalBar: isVerticalBar)
        case .leave:
            LeaveControl(controls: controls, diameter: diameter, isAccessibilityText: isAccessibilityText)
        }
    }
}

/// Microphone, Camera, Share Screen and Raise Hand. The gesture kind is computed from `isOn` before the tap and plays
/// only when the presenter returns `dispatched` (S30 1 h); pending, duplicate and explained taps play nothing.
struct CallControlToggleCell: View {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let diameter: CGFloat
    @State private var feedbackKind = FeedbackKind.none
    @State private var feedbackCount = 0
    @State private var slowAck = false

    /// Mic and Camera are optimistic: the intended state draws at once and the spinner appears only after 600 ms.
    /// Hand and Share are not: the spinner replaces the glyph at once (S30 1 c).
    private var showsSpinner: Bool {
        guard model.isPending else { return false }
        if model.kind == CallControlKind.screenShare || model.kind == CallControlKind.hand { return true }
        return slowAck
    }

    var body: some View {
        Button(action: dispatch) {
            CallControlGlyph(systemImage: CallControlsCopy.glyph(model), showsSpinner: showsSpinner, visual: model.visual)
        }
        .buttonStyle(CallControlSurfaceStyle(visual: model.visual, isBlocked: model.isBlocked, diameter: diameter))
        .disabled(model.reason == ControlBlockedReason.leaving)
        .overlay(alignment: .topTrailing) {
            if model.reason == ControlBlockedReason.permissionDenied {
                CallControlWarningMark()
            }
        }
        .conclaveGestureFeedback(feedbackKind, trigger: feedbackCount)
        .accessibilityLabel(CallControlsCopy.title(model.kind))
        .accessibilityValue(CallControlsCopy.value(model))
        .accessibilityAddTraits(.isToggle)
        .modifier(CallControlHint(text: CallControlsCopy.hint(model)))
        .accessibilityInputLabels(CallControlsCopy.inputLabels(model.kind))
        .accessibilityShowsLargeContentViewer {
            Label(CallControlsCopy.title(model.kind), systemImage: CallControlsCopy.glyph(model))
        }
        .help(CallControlsCopy.title(model.kind))
        .accessibilityIdentifier("control." + model.id)
        // One view-local one-shot armed only while pending; a new pending value cancels it (no periodic redraw).
        .task(id: model.isPending) {
            if slowAck { slowAck = false }
            guard model.isPending else { return }
            try? await Task.sleep(for: .milliseconds(CallControlsCopy.spinnerDelayMillis))
            if Task.isCancelled { return }
            slowAck = true
        }
    }

    private func dispatch() {
        let kind = ControlBarPolicy.gestureKind(model)
        if controls.tap(model.kind) == ControlTapResult.dispatched, let kind {
            feedbackKind = kind
            feedbackCount += 1
        }
    }
}

/// Chat, Participants and Q&A: On, Engaged while their panel is current (`.isSelected`). They play nothing (S30 1 h).
/// The badge is ink on coral, hidden from accessibility and folded into the value (F00 C06). More has its own control.
struct CallControlInvokerCell: View {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let diameter: CGFloat
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        Button {
            _ = controls.tap(model.kind)
        } label: {
            CallControlGlyph(systemImage: CallControlsCopy.glyph(model), showsSpinner: false, visual: model.visual)
        }
        .buttonStyle(CallControlSurfaceStyle(visual: model.visual, isBlocked: model.isBlocked, diameter: diameter))
        .disabled(model.reason == ControlBlockedReason.leaving)
        .overlay(alignment: .topTrailing) {
            Group {
                if model.badgeCount > 0 {
                    ConclaveCountBadge(count: model.badgeCount)
                } else if model.showsDot {
                    ConclaveDotBadge()
                }
            }
            .offset(x: layoutDirection == .rightToLeft ? -4 : 4, y: -4)
        }
        .accessibilityLabel(CallControlsCopy.title(model.kind))
        .modifier(CallControlValue(text: CallControlsCopy.invokerValue(model)))
        .accessibilityAddTraits(model.visual == CallControlVisual.engaged ? [.isSelected] : [])
        .accessibilityShowsLargeContentViewer {
            Label(CallControlsCopy.title(model.kind), systemImage: CallControlsCopy.glyph(model))
        }
        .help(CallControlsCopy.title(model.kind))
        .accessibilityIdentifier("control." + model.id)
    }
}

/// The glyph, or a small system spinner in its place while an acknowledgment is slow (D15: no pulse or shimmer). Also
/// More's glyph (MoreMenu+iOS.swift).
struct CallControlGlyph: View {
    let systemImage: String
    let showsSpinner: Bool
    let visual: CallControlVisual
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if showsSpinner {
            // Ink on the paper states, the in-call text color on the On surface.
            ProgressView()
                .controlSize(.small)
                .tint(HostingTheme.token(visual == CallControlVisual.on ? DesignTokens.iosInCallText : DesignTokens.iosInCallOnControlOff))
                .accessibilityHidden(true)
        } else {
            renderedGlyph
        }
    }

    @ViewBuilder
    private var renderedGlyph: some View {
        if #available(iOS 26.0, *) {
            glyph.symbolColorRenderingMode(.flat)
        } else {
            glyph
        }
    }

    private var glyph: some View {
        Image(systemName: systemImage)
            .font(.title3)
            .imageScale(.medium)
            .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
            .accessibilityHidden(true)
    }
}

/// The R02 surface through the single glass entry, sized to the fitted diameter. Opaque renderings dim while pressed;
/// glass gives the system interactive response instead, so it never dims twice. More's sheet form uses it too.
struct CallControlSurfaceStyle: ButtonStyle {
    let visual: CallControlVisual
    let isBlocked: Bool
    let diameter: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        CallControlSurfaceBody(label: configuration.label, isPressed: configuration.isPressed, visual: visual,
                               isBlocked: isBlocked, diameter: diameter)
    }
}

/// The surface itself; More's menu form draws it as the `Menu` label (a menu label takes no button style).
struct CallControlSurfaceBody<Content: View>: View {
    let label: Content
    let isPressed: Bool
    let visual: CallControlVisual
    let isBlocked: Bool
    let diameter: CGFloat
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    #if DEBUG
    @Environment(\.conclaveForceOpaqueControls) private var forceOpaqueSetting
    #endif

    private var state: ConclaveControlState {
        ConclaveControlState(rawValue: visual.rawValue) ?? ConclaveControlState.on
    }

    private var forceOpaque: Bool {
        #if DEBUG
        return forceOpaqueSetting
        #else
        return false
        #endif
    }

    private var usesGlass: Bool {
        guard #available(iOS 26.0, *) else { return false }
        return ConclaveControlSurfaceMapping.spec(state, glassAvailable: true, reduceTransparency: reduceTransparency,
                                                  forceOpaque: forceOpaque, increasedContrast: contrast == .increased,
                                                  isEnabled: !isBlocked).fill == ConclaveControlFill.glass
    }

    var body: some View {
        label
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
            .conclaveControlSurface(state, isEnabled: !isBlocked, shape: .circle)
            .opacity(isPressed && !usesGlass ? CallControlsCopy.pressedOpacity : 1)
    }
}

/// The permission-denied mark (S30 1 e): a 14 pt warning glyph at the top trailing corner, never the only cue (the
/// value names the reason).
private struct CallControlWarningMark: View {
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
            .font(.caption2)
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallWarning))
            .offset(x: layoutDirection == .rightToLeft ? -2 : 2, y: -2)
            .accessibilityHidden(true)
    }
}

struct CallControlValue: ViewModifier {
    let text: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let text {
            content.accessibilityValue(text)
        } else {
            content
        }
    }
}

private struct CallControlHint: ViewModifier {
    let text: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let text {
            content.accessibilityHint(text)
        } else {
            content
        }
    }
}

/// iOS copy for the bar (S30 1 g and 7; Apple title case for labels, sentence case for values and toasts). Keys are
/// String Catalog keys through `ConclaveStrings`. The toast lane (STG-5, CC7) resolves explanation toasts here too.
enum CallControlsCopy {
    static let spinnerDelayMillis = 600
    static let pressedOpacity = 0.6

    static func title(_ kind: CallControlKind) -> String {
        switch kind {
        case .microphone: return ConclaveStrings.text("Microphone")
        case .camera: return ConclaveStrings.text("Camera")
        case .screenShare: return ConclaveStrings.text("Share Screen")
        case .hand: return ConclaveStrings.text("Raise Hand")
        case .chat: return ConclaveStrings.text("Chat")
        case .participants: return ConclaveStrings.text("Participants")
        case .qa: return ConclaveStrings.text("Questions and Answers")
        case .more: return ConclaveStrings.text("More")
        case .leave: return ConclaveStrings.text("Leave Call")
        }
    }

    /// S30 1 e concepts: slashed glyphs for muted and off, the slash glyph while sharing, the filled hand while raised.
    static func glyph(_ model: CallControlModel) -> String {
        switch model.kind {
        case .microphone: return model.isOn ? ConclaveSymbols.micFill : ConclaveSymbols.micSlashFill
        case .camera: return model.isOn ? ConclaveSymbols.videoFill : ConclaveSymbols.videoSlashFill
        case .screenShare: return model.isOn ? ConclaveSymbols.rectangleOnRectangleSlash : ConclaveSymbols.rectangleOnRectangle
        case .hand: return model.isOn ? ConclaveSymbols.handRaisedFill : ConclaveSymbols.handRaised
        case .chat: return ConclaveSymbols.messageFill
        case .participants: return ConclaveSymbols.person2Fill
        case .qa: return ConclaveSymbols.questionmarkBubble
        case .more: return ConclaveSymbols.ellipsis
        case .leave: return ConclaveSymbols.phoneDownFill
        }
    }

    /// The toggle value: the state (or "Paused" and "On hold" for system-paused audio, R29), then the blocked reason,
    /// then "Applies when reconnected" while media intent waits for recovery (S30 1 g).
    static func value(_ model: CallControlModel) -> String {
        var parts: [String] = []
        if model.kind == CallControlKind.microphone && model.reason == ControlBlockedReason.audioInterrupted {
            parts.append(ConclaveStrings.text("Paused"))
        } else if model.kind == CallControlKind.microphone && model.reason == ControlBlockedReason.onHold {
            parts.append(ConclaveStrings.text("On hold"))
        } else {
            parts.append(state(model))
            if let reason = reasonText(model.reason, name: model.reasonName) { parts.append(reason) }
        }
        if model.appliesAfterReconnect { parts.append(ConclaveStrings.text("Applies when reconnected")) }
        return parts.joined(separator: ", ")
    }

    static func state(_ model: CallControlModel) -> String {
        switch model.kind {
        case .microphone: return model.isOn ? ConclaveStrings.text("On") : ConclaveStrings.text("Muted")
        case .camera: return model.isOn ? ConclaveStrings.text("On") : ConclaveStrings.text("Off")
        case .screenShare: return model.isOn ? ConclaveStrings.text("Sharing") : ConclaveStrings.text("Not sharing")
        case .hand:
            if model.isPending { return model.isOn ? ConclaveStrings.text("Lowering") : ConclaveStrings.text("Raising") }
            return model.isOn ? ConclaveStrings.text("Raised") : ConclaveStrings.text("Not raised")
        default: return ""
        }
    }

    /// Chat unread, the host waiting count (Participants or More), new questions (Q&A), or More's dot.
    static func invokerValue(_ model: CallControlModel) -> String? {
        if model.badgeCount > 0 {
            switch model.kind {
            case .chat: return ConclaveStrings.format("%lld unread", model.badgeCount)
            case .participants, .more: return ConclaveStrings.format("%lld waiting to join", model.badgeCount)
            case .qa: return ConclaveStrings.format("%lld new", model.badgeCount)
            default: return nil
            }
        }
        if model.showsDot { return ConclaveStrings.text("New activity") }
        return nil
    }

    /// S30 7 iOS subtitle or value; nil for reasons with no copy on the bar.
    static func reasonText(_ reason: ControlBlockedReason, name: String) -> String? {
        switch reason {
        case .reconnecting: return ConclaveStrings.text("Available after reconnecting")
        case .offline: return ConclaveStrings.text("Available when you’re back online")
        case .remoteShareActive: return ConclaveStrings.format("%@ is presenting", name)
        case .audioOnly: return ConclaveStrings.text("Off in audio-only mode")
        case .disabledByHost: return ConclaveStrings.text("Disabled by the host")
        case .permissionDenied: return ConclaveStrings.text("Access is off in Settings")
        default: return nil
        }
    }

    /// S70 5 g, 5 i: why the microphone is paused while another call or app holds the audio.
    static func hint(_ model: CallControlModel) -> String? {
        if model.kind == CallControlKind.microphone && model.reason == ControlBlockedReason.audioInterrupted {
            return ConclaveStrings.text("Your audio resumes when the other call or app finishes.")
        }
        return nil
    }

    static func inputLabels(_ kind: CallControlKind) -> [String] {
        switch kind {
        case .microphone: return [ConclaveStrings.text("Microphone"), ConclaveStrings.text("Mute"), ConclaveStrings.text("Unmute")]
        case .camera: return [ConclaveStrings.text("Camera"), ConclaveStrings.text("Video")]
        case .screenShare: return [ConclaveStrings.text("Share Screen"), ConclaveStrings.text("Stop Sharing")]
        case .hand: return [ConclaveStrings.text("Raise Hand"), ConclaveStrings.text("Lower Hand")]
        default: return [title(kind)]
        }
    }

    /// The toast for a blocked bar tap (S30 7 last column); STG-5's toast lane shows it for the `blockedExplanation`
    /// notice. Nil for reasons that explain nothing.
    static func toast(_ explanation: ControlExplanation) -> String? {
        switch explanation.reason {
        case .reconnecting: return ConclaveStrings.text("Available after the call reconnects.")
        case .offline: return ConclaveStrings.text("You’re offline. This will be available when you reconnect.")
        case .remoteShareActive:
            return ConclaveStrings.format("%@ is presenting. Only one person can share at a time.", explanation.reasonName)
        case .audioOnly: return ConclaveStrings.text("Your camera is off in audio-only mode.")
        case .disabledByHost:
            return explanation.kind == CallControlKind.camera
                ? ConclaveStrings.text("The host turned off cameras for participants.")
                : ConclaveStrings.text("The host turned off microphones for participants.")
        default: return nil
        }
    }

    /// The S10 7 permission alert for a denied tap.
    static func permissionAlert(_ prompt: ControlPermissionPrompt) -> ConclaveDialogModel {
        let camera = prompt.kind == ControlPermissionKind.camera
        return ConclaveDialogModel(
            kind: ConclaveDialogKind.alert,
            title: camera ? ConclaveStrings.text("Camera Access Is Off") : ConclaveStrings.text("Microphone Access Is Off"),
            message: camera ? ConclaveStrings.text("Allow camera access in Settings to use video in meetings.")
                            : ConclaveStrings.text("Allow microphone access in Settings so people can hear you."),
            confirmTitle: ConclaveStrings.text("Open Settings"),
            confirmRole: ConclaveDialogRole.normal
        )
    }
}
#endif
