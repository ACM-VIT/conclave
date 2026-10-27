// The R02 call control surface, call toggles, panel invokers, Leave and the compact control bar (PN 3.5 A1,
// F00 C04 and C05). This is the only WP1 file that may use glass. The state-to-surface mapping sits in a
// host-compiled section outside the iOS block, written in plain Swift with no SwiftUI or UIKit type, so the macOS
// host compiles it and `swift test` checks it against the R02 table (a refinement of TG 4.4's iOS-only block).

#if !SKIP
/// The three visual states of an in-call control. Off is a muted microphone or a camera that is off; Engaged is a
/// raised hand, a running share or an open panel (glyph shape, not color, separates it from Off, Q9); On is the
/// rest.
enum ConclaveControlState: String, CaseIterable {
    case off, on, engaged
}

/// The control outline. Call controls are circles; other outlines arrive with the chrome (C03, FND-2).
enum ConclaveControlShape: String, CaseIterable {
    case circle
}

/// How a control surface is filled.
enum ConclaveControlFill: String, CaseIterable {
    /// Opaque paper (`iosInCallControlOff`), never glass, so the state never depends on what is behind it.
    case paper
    /// Regular Liquid Glass.
    case glass
    /// The opaque fallback (`iosInCallControlFallback`).
    case fallback
}

/// Which glyph variant the control draws for its state.
enum ConclaveControlGlyph: String, CaseIterable {
    /// The slashed off glyph.
    case off
    case on
    /// The FILL 1 engaged glyph.
    case engaged
}

/// One row of the R02 state table.
struct ConclaveControlSurfaceSpec: Equatable {
    let fill: ConclaveControlFill
    /// The opaque fill token; nil for glass.
    let fillToken: Int64?
    let glyph: ConclaveControlGlyph
    let glyphToken: Int64
    /// The 1 pt inner stroke token; nil draws no stroke. The stroke is decorative and never the only affordance.
    let strokeToken: Int64?
    /// Glass with `.interactive()`. Never true for an opaque rendering or a disabled control.
    let isInteractive: Bool
    let opacity: Double
}

/// The R02 state table as a pure function of plain inputs. Pressed is not an input: glass gives the system
/// interactive response and every opaque rendering dims through its button style.
enum ConclaveControlSurfaceMapping {
    static let disabledOpacity = 0.4

    static func spec(_ state: ConclaveControlState, glassAvailable: Bool, reduceTransparency: Bool,
                     forceOpaque: Bool, increasedContrast: Bool, isEnabled: Bool) -> ConclaveControlSurfaceSpec {
        let opacity = isEnabled ? 1.0 : disabledOpacity
        switch state {
        case .off:
            return ConclaveControlSurfaceSpec(fill: .paper, fillToken: DesignTokens.iosInCallControlOff, glyph: .off,
                                              glyphToken: DesignTokens.iosInCallOnControlOff, strokeToken: nil,
                                              isInteractive: false, opacity: opacity)
        case .engaged:
            return ConclaveControlSurfaceSpec(fill: .paper, fillToken: DesignTokens.iosInCallControlOff, glyph: .engaged,
                                              glyphToken: DesignTokens.iosInCallOnControlOff, strokeToken: nil,
                                              isInteractive: false, opacity: opacity)
        case .on:
            let glass = glassAvailable && !reduceTransparency && !forceOpaque
            let stroke: Int64?
            if increasedContrast {
                stroke = DesignTokens.iosInCallBorderHighContrast
            } else {
                stroke = glass ? nil : DesignTokens.iosInCallBorder
            }
            return ConclaveControlSurfaceSpec(fill: glass ? .glass : .fallback,
                                              fillToken: glass ? nil : DesignTokens.iosInCallControlFallback,
                                              glyph: .on, glyphToken: DesignTokens.iosInCallText, strokeToken: stroke,
                                              isInteractive: glass && isEnabled, opacity: opacity)
        }
    }
}
#endif

#if os(iOS) && !SKIP
import SwiftUI

#if DEBUG
/// Debug only: the gallery's "Force Opaque Controls" switch. Release builds have no such key, and the surface
/// and the bar read a constant `false` there.
private struct ConclaveForceOpaqueControlsKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var conclaveForceOpaqueControls: Bool {
        get { self[ConclaveForceOpaqueControlsKey.self] }
        set { self[ConclaveForceOpaqueControlsKey.self] = newValue }
    }
}
#endif

/// Where a call control's gesture feedback goes. Production plays through the view-local gesture route; the
/// Debug gallery records the route's decision and never reaches a haptic engine.
enum ConclaveGestureRoute {
    case live
    case recordOnly((FeedbackKind) -> Void)
}

/// Sizes of the call controls (F00 C04 c, C05 c): a 52 pt base scaled with the body style, clamped to [44, 60].
enum ConclaveCallControlMetrics {
    static let baseDiameter = CGFloat(CompactBarFit.iosBaseDiameter)

    static func clamped(_ diameter: CGFloat) -> CGFloat {
        let minimum = CGFloat(CompactBarFit.iosMinimumTarget)
        let maximum = CGFloat(CompactBarFit.iosMaximumDiameter)
        return min(max(diameter, minimum), maximum)
    }
}

extension View {
    /// The R02 control surface: the glass branch only on iOS 26 or later with Reduce Transparency off and no
    /// Debug force; otherwise the opaque fallback. Fills and strokes come from generated tokens.
    func conclaveControlSurface(_ state: ConclaveControlState, isEnabled: Bool,
                                shape: ConclaveControlShape = .circle) -> some View {
        modifier(ConclaveControlSurface(state: state, isEnabled: isEnabled, shape: shape, isPressed: false))
    }
}

/// The surface itself. `isPressed` comes from a button style and only dims opaque renderings.
struct ConclaveControlSurface: ViewModifier {
    let state: ConclaveControlState
    let isEnabled: Bool
    let shape: ConclaveControlShape
    let isPressed: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    #if DEBUG
    @Environment(\.conclaveForceOpaqueControls) private var forceOpaqueSetting
    #endif

    private var forceOpaque: Bool {
        #if DEBUG
        return forceOpaqueSetting
        #else
        return false
        #endif
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency, !forceOpaque {
            let spec = ConclaveControlSurfaceMapping.spec(state, glassAvailable: true, reduceTransparency: reduceTransparency,
                                                          forceOpaque: forceOpaque, increasedContrast: contrast == .increased,
                                                          isEnabled: isEnabled)
            if spec.fill == .glass {
                content
                    .foregroundStyle(HostingTheme.token(spec.glyphToken))
                    .glassEffect(.regular.interactive(spec.isInteractive), in: Circle())
                    .overlay { ConclaveControlStroke(token: spec.strokeToken) }
                    .opacity(spec.opacity)
            } else {
                opaque(content, spec)
            }
        } else {
            opaque(content, ConclaveControlSurfaceMapping.spec(state, glassAvailable: false, reduceTransparency: reduceTransparency,
                                                               forceOpaque: forceOpaque, increasedContrast: contrast == .increased,
                                                               isEnabled: isEnabled))
        }
    }

    /// Paper for Off and Engaged, the fallback for On: always opaque, with a system-like press highlight.
    private func opaque(_ content: Content, _ spec: ConclaveControlSurfaceSpec) -> some View {
        content
            .foregroundStyle(HostingTheme.token(spec.glyphToken))
            .background(HostingTheme.token(spec.fillToken ?? DesignTokens.iosInCallControlFallback), in: Circle())
            .overlay { ConclaveControlStroke(token: spec.strokeToken) }
            .opacity(spec.opacity * (isPressed ? ConclaveControlPress.opacity : 1))
    }
}

/// System-like dimming for opaque controls while pressed; no scale bounce (F00 9).
private enum ConclaveControlPress {
    static let opacity = 0.6
}

/// The decorative 1 pt inner stroke.
private struct ConclaveControlStroke: View {
    let token: Int64?

    var body: some View {
        if let token {
            Circle().strokeBorder(HostingTheme.token(token), lineWidth: 1)
        }
    }
}

/// Draws a control's glyph inside its circle and applies the surface with the press state.
private struct ConclaveControlButtonStyle: ButtonStyle {
    let state: ConclaveControlState
    let isEnabled: Bool
    let diameter: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
            .modifier(ConclaveControlSurface(state: state, isEnabled: isEnabled, shape: .circle,
                                             isPressed: configuration.isPressed))
    }
}

/// A call control glyph: flat symbol rendering on iOS 26 and later, the replace transition unless Reduce Motion.
private struct ConclaveControlGlyphImage: View {
    let systemImage: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
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

/// Reads the scaled base diameter under the bar's text-size cap, for fit arithmetic in a composition.
struct ConclaveScaledControlDiameter<Content: View>: View {
    @ViewBuilder let content: (CGFloat) -> Content

    var body: some View {
        ScaledDiameterReader(content: content)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private struct ScaledDiameterReader: View {
        let content: (CGFloat) -> Content
        @ScaledMetric(relativeTo: .body) private var diameter = ConclaveCallControlMetrics.baseDiameter

        var body: some View {
            content(ConclaveCallControlMetrics.clamped(diameter))
        }
    }
}

// MARK: Call toggle (F00 C04 c, TG 4.2 toggle.call, OQ-2b-4)

/// Mic, Camera, Raise Hand or Share Screen: a `Button` with the toggle trait (TG 4.2), a constant label and the
/// state in the value. `feedback` is the gesture kind this tap plays (nil plays nothing, for example a share
/// whose result arrives as an outcome).
struct ConclaveCallToggle: View {
    let title: String
    let value: String
    let systemImage: String
    let state: ConclaveControlState
    let isEnabled: Bool
    let diameter: CGFloat?
    let inputLabels: [String]
    let feedback: FeedbackKind?
    let gestureRoute: ConclaveGestureRoute
    let identifier: String
    let action: () -> Void

    init(title: String, value: String, systemImage: String, state: ConclaveControlState, isEnabled: Bool = true,
         diameter: CGFloat? = nil, inputLabels: [String] = [], feedback: FeedbackKind? = nil,
         gestureRoute: ConclaveGestureRoute = .live, identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.value = value
        self.systemImage = systemImage
        self.state = state
        self.isEnabled = isEnabled
        self.diameter = diameter
        self.inputLabels = inputLabels
        self.feedback = feedback
        self.gestureRoute = gestureRoute
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        CallToggleContent(toggle: self)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private struct CallToggleContent: View {
        let toggle: ConclaveCallToggle
        @ScaledMetric(relativeTo: .body) private var scaledDiameter = ConclaveCallControlMetrics.baseDiameter
        @State private var tappedKind = FeedbackKind.none
        @State private var taps = 0

        var body: some View {
            let size = ConclaveCallControlMetrics.clamped(toggle.diameter ?? scaledDiameter)
            Button {
                if let kind = toggle.feedback {
                    switch toggle.gestureRoute {
                    case .live:
                        // An async outcome never plays on the gesture route (F1); its token arrives later.
                        if !kind.isAsyncOutcome {
                            tappedKind = kind
                            taps += 1
                        }
                    case .recordOnly(let record):
                        record(kind)
                    }
                }
                toggle.action()
            } label: {
                ConclaveControlGlyphImage(systemImage: toggle.systemImage)
            }
            .buttonStyle(ConclaveControlButtonStyle(state: toggle.state, isEnabled: toggle.isEnabled, diameter: size))
            .disabled(!toggle.isEnabled)
            .modifier(LiveGestureFeedback(route: toggle.gestureRoute, kind: tappedKind, trigger: taps))
            .accessibilityLabel(toggle.title)
            .accessibilityValue(toggle.value)
            .accessibilityAddTraits(.isToggle)
            .accessibilityInputLabels(toggle.inputLabels.isEmpty ? [toggle.title] : toggle.inputLabels)
            .accessibilityShowsLargeContentViewer {
                Label(toggle.title, systemImage: toggle.systemImage)
            }
            .accessibilityIdentifier(toggle.identifier)
        }
    }
}

/// Plays the tapped kind through the view-local route in production; the record-only route adds nothing.
private struct LiveGestureFeedback: ViewModifier {
    let route: ConclaveGestureRoute
    let kind: FeedbackKind
    let trigger: Int

    @ViewBuilder
    func body(content: Content) -> some View {
        switch route {
        case .live:
            content.conclaveGestureFeedback(kind, trigger: trigger)
        case .recordOnly:
            content
        }
    }
}

// MARK: Panel invokers (Chat, More) and the Chat count badge (F00 C04 c, OQ-2b-7)

/// A panel invoker on the call surface: On while its panel is closed, Engaged while it is open. It plays
/// nothing (F00 C04 e) and takes no gesture route. The count badge is ink on coral, hidden from accessibility and
/// folded into the value; it hides while the panel is open and at zero.
struct ConclaveCallInvoker: View {
    let title: String
    let systemImage: String
    let isEngaged: Bool
    let badgeCount: Int
    let isEnabled: Bool
    let diameter: CGFloat?
    let identifier: String
    let action: () -> Void

    init(title: String, systemImage: String, isEngaged: Bool = false, badgeCount: Int = 0, isEnabled: Bool = true,
         diameter: CGFloat? = nil, identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.isEngaged = isEngaged
        self.badgeCount = badgeCount
        self.isEnabled = isEnabled
        self.diameter = diameter
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        InvokerContent(invoker: self)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private struct InvokerContent: View {
        let invoker: ConclaveCallInvoker
        @ScaledMetric(relativeTo: .body) private var scaledDiameter = ConclaveCallControlMetrics.baseDiameter

        private var showsBadge: Bool { invoker.badgeCount > 0 && !invoker.isEngaged }

        var body: some View {
            let size = ConclaveCallControlMetrics.clamped(invoker.diameter ?? scaledDiameter)
            Button(action: invoker.action) {
                ConclaveControlGlyphImage(systemImage: invoker.systemImage)
            }
            .buttonStyle(ConclaveControlButtonStyle(state: invoker.isEngaged ? .engaged : .on, isEnabled: invoker.isEnabled,
                                                    diameter: size))
            .disabled(!invoker.isEnabled)
            .overlay(alignment: .topTrailing) {
                if showsBadge {
                    ConclaveCountBadge(count: invoker.badgeCount)
                }
            }
            .accessibilityLabel(invoker.title)
            .modifier(InvokerValue(text: showsBadge ? ConclaveStrings.format("%lld unread", invoker.badgeCount) : nil))
            .accessibilityAddTraits(invoker.isEngaged ? [.isSelected] : [])
            .accessibilityShowsLargeContentViewer {
                Label(invoker.title, systemImage: invoker.systemImage)
            }
            .accessibilityIdentifier(invoker.identifier)
        }
    }
}

private struct InvokerValue: ViewModifier {
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

/// Ink numerals on coral (never white, 6.374), "99+" above 99, capped with the bar. Never read on its own.
private struct ConclaveCountBadge: View {
    let count: Int

    var body: some View {
        Text(count > 99 ? 99.formatted() + "+" : count.formatted())
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(HostingTheme.onCoral)
            .padding(.horizontal, 5)
            .frame(minWidth: 18, minHeight: 18)
            .background(HostingTheme.coralFill, in: Capsule())
            .accessibilityHidden(true)
    }
}

// MARK: Leave (F00 C04 c, OD Q9, OQ3)

/// Glyph-only red Leave in the toggles' diameter: opaque dynamic system red in the dark environment, never glass,
/// with a white glyph. It plays nothing (Q11) and takes no gesture route. The increased-contrast fill token and
/// the host End menu arrive with FND-1 and CTL-2.
struct ConclaveLeaveButton: View {
    let diameter: CGFloat?
    let identifier: String
    let action: () -> Void

    init(diameter: CGFloat? = nil, identifier: String, action: @escaping () -> Void) {
        self.diameter = diameter
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        LeaveContent(leave: self)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private struct LeaveContent: View {
        let leave: ConclaveLeaveButton
        @ScaledMetric(relativeTo: .body) private var scaledDiameter = ConclaveCallControlMetrics.baseDiameter

        var body: some View {
            let size = ConclaveCallControlMetrics.clamped(leave.diameter ?? scaledDiameter)
            Button(action: leave.action) {
                ConclaveControlGlyphImage(systemImage: ConclaveSymbols.phoneDownFill)
            }
            .buttonStyle(ConclaveLeaveButtonStyle(diameter: size))
            .accessibilityLabel(ConclaveStrings.text("Leave Call"))
            .accessibilityShowsLargeContentViewer {
                Label(ConclaveStrings.text("Leave Call"), systemImage: ConclaveSymbols.phoneDownFill)
            }
            .accessibilityIdentifier(leave.identifier)
        }
    }
}

private struct ConclaveLeaveButtonStyle: ButtonStyle {
    let diameter: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(HostingTheme.token(DesignTokens.neutralWhite))
            .frame(width: diameter, height: diameter)
            .background(Color(uiColor: .systemRed), in: Circle())
            .contentShape(Circle())
            .opacity(configuration.isPressed ? ConclaveControlPress.opacity : 1)
    }
}

// MARK: Control bar (F00 C05 c)

/// The floating cluster: one `GlassEffectContainer` in the glass branch, a plain `HStack` otherwise; horizontal
/// only (OQ-2b-11). Each control carries its own surface, so the bar draws no background. Reading order is the
/// code order, which mirrors in right-to-left layouts, so Leave stays last.
struct ConclaveControlBar<Content: View>: View {
    let spacing: CGFloat
    let identifier: String
    @ViewBuilder let content: () -> Content
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    #if DEBUG
    @Environment(\.conclaveForceOpaqueControls) private var forceOpaqueSetting
    #endif

    init(spacing: CGFloat = CGFloat(DesignTokens.space12), identifier: String, @ViewBuilder content: @escaping () -> Content) {
        self.spacing = spacing
        self.identifier = identifier
        self.content = content
    }

    private var forceOpaque: Bool {
        #if DEBUG
        return forceOpaqueSetting
        #else
        return false
        #endif
    }

    var body: some View {
        bar
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
    }

    @ViewBuilder
    private var bar: some View {
        if #available(iOS 26.0, *), !reduceTransparency, !forceOpaque {
            GlassEffectContainer(spacing: spacing) {
                HStack(spacing: spacing) { content() }
            }
        } else {
            HStack(spacing: spacing) { content() }
        }
    }
}
#endif
