#if os(iOS) && !SKIP
import SwiftUI

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
            CallControlToggleCell(model: model, controls: controls, diameter: diameter, isAccessibilityText: isAccessibilityText)
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

struct CallControlToggleCell: View {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let diameter: CGFloat

    var isAccessibilityText: Bool = false
    @State private var feedbackKind = FeedbackKind.none
    @State private var feedbackCount = 0
    @State private var flipCounter = 0
    @State private var slowAck = false

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
        .modifier(MediaShortcutModifier(model: model, controls: controls, isAccessibilityText: isAccessibilityText,
                                        onFlip: { flipCounter += 1 }))
        .conclaveGestureFeedback(.selectionChanged, trigger: flipCounter)
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

struct CallControlGlyph: View {
    let systemImage: String
    let showsSpinner: Bool
    let visual: CallControlVisual
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if showsSpinner {

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
            .contentTransition(reduceMotion ? .identity : glyphTransition)
            .animation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion), value: systemImage)
            .accessibilityHidden(true)
    }

    private var glyphTransition: ContentTransition {
        if #available(iOS 18.0, *) {
            return .symbolEffect(.replace.magic(fallback: .replace))
        }
        return .symbolEffect(.replace)
    }
}

struct CallControlSurfaceStyle: ButtonStyle {
    let visual: CallControlVisual
    let isBlocked: Bool
    let diameter: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        CallControlSurfaceBody(label: configuration.label, isPressed: configuration.isPressed, visual: visual,
                               isBlocked: isBlocked, diameter: diameter)
    }
}

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
