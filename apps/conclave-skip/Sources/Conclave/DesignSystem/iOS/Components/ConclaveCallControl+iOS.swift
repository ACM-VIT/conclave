

#if !SKIP

enum ConclaveControlState: String, CaseIterable {
    case off, on, engaged
}

enum ConclaveControlShape: String, CaseIterable {
    case circle, capsule
}

enum ConclaveControlFill: String, CaseIterable {

    case paper

    case glass

    case fallback

    case scrim
}

enum ConclaveControlGlyph: String, CaseIterable {

    case off
    case on

    case engaged
}

struct ConclaveControlSurfaceSpec: Equatable {
    let fill: ConclaveControlFill

    let fillToken: Int64?
    let glyph: ConclaveControlGlyph
    let glyphToken: Int64

    let strokeToken: Int64?

    let isInteractive: Bool
    let opacity: Double
}

enum ConclaveControlSurfaceMapping {
    static let disabledOpacity = 0.4

    static func spec(_ state: ConclaveControlState, glassAvailable: Bool, reduceTransparency: Bool,
                     forceOpaque: Bool, increasedContrast: Bool, isEnabled: Bool) -> ConclaveControlSurfaceSpec {
        return spec(state, context: .stage, glassAvailable: glassAvailable, reduceTransparency: reduceTransparency,
                    forceOpaque: forceOpaque, increasedContrast: increasedContrast, isEnabled: isEnabled)
    }

    static func spec(_ state: ConclaveControlState, context: ConclaveSurfaceContext, glassAvailable: Bool,
                     reduceTransparency: Bool, forceOpaque: Bool, increasedContrast: Bool,
                     isEnabled: Bool) -> ConclaveControlSurfaceSpec {
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
            if context == .overVideo {
                return ConclaveControlSurfaceSpec(fill: .scrim,
                                                  fillToken: increasedContrast ? DesignTokens.iosInCallLabelScrimHighContrast : DesignTokens.iosInCallLabelScrim,
                                                  glyph: .on, glyphToken: DesignTokens.iosInCallText,
                                                  strokeToken: increasedContrast ? DesignTokens.iosInCallBorderHighContrast : DesignTokens.iosInCallBorder,
                                                  isInteractive: false, opacity: opacity)
            }
            let glass = context.allowsGlass && glassAvailable && !reduceTransparency && !forceOpaque
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
import AVKit
import SwiftUI

#if DEBUG

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

private struct ConclaveControlPressedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    fileprivate var conclaveControlPressed: Bool {
        get { self[ConclaveControlPressedKey.self] }
        set { self[ConclaveControlPressedKey.self] = newValue }
    }
}

enum ConclaveGestureRoute {
    case live
    case recordOnly((FeedbackKind) -> Void)
}

enum ConclaveCallControlMetrics {
    static let baseDiameter = CGFloat(CompactBarFit.iosBaseDiameter)

    static func clamped(_ diameter: CGFloat) -> CGFloat {
        let minimum = CGFloat(CompactBarFit.iosMinimumTarget)
        let maximum = CGFloat(CompactBarFit.iosMaximumDiameter)
        return min(max(diameter, minimum), maximum)
    }
}

extension View {

    func conclaveControlSurface(_ state: ConclaveControlState, isEnabled: Bool,
                                shape: ConclaveControlShape = .circle,
                                context: ConclaveSurfaceContext = .stage) -> some View {
        modifier(ConclaveControlSurface(state: state, isEnabled: isEnabled, shape: shape, context: context))
    }

    func conclaveControlPressed(_ isPressed: Bool) -> some View {
        environment(\.conclaveControlPressed, isPressed)
    }
}

struct ConclaveControlOutline: InsettableShape {
    let shape: ConclaveControlShape
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let inset = rect.insetBy(dx: insetAmount, dy: insetAmount)
        switch shape {
        case .circle: return Circle().path(in: inset)
        case .capsule: return Capsule().path(in: inset)
        }
    }

    func inset(by amount: CGFloat) -> ConclaveControlOutline {
        ConclaveControlOutline(shape: shape, insetAmount: insetAmount + amount)
    }
}

struct ConclaveControlSurface: ViewModifier {
    let state: ConclaveControlState
    let isEnabled: Bool
    let shape: ConclaveControlShape
    var context: ConclaveSurfaceContext = .stage
    @Environment(\.conclaveControlPressed) private var isPressed
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
            let spec = ConclaveControlSurfaceMapping.spec(state, context: context, glassAvailable: true,
                                                          reduceTransparency: reduceTransparency, forceOpaque: forceOpaque,
                                                          increasedContrast: contrast == .increased, isEnabled: isEnabled)
            let glass = spec.fill == .glass
            content
                .foregroundStyle(HostingTheme.token(spec.glyphToken))
                .background {
                    if !glass {
                        ConclaveControlOutline(shape: shape).fill(HostingTheme.token(spec.fillToken ?? DesignTokens.iosInCallControlFallback))
                    }
                }
                .overlay { ConclaveControlStroke(token: glass ? nil : spec.strokeToken, shape: shape) }
                .opacity(glass ? 1 : dimming(spec))
                .glassEffect(glass ? .regular.interactive(spec.isInteractive) : .identity, in: ConclaveControlOutline(shape: shape))
                .overlay { ConclaveControlStroke(token: glass ? spec.strokeToken : nil, shape: shape) }
                .opacity(glass ? spec.opacity : 1)
        } else {
            opaque(content, ConclaveControlSurfaceMapping.spec(state, context: context, glassAvailable: false,
                                                               reduceTransparency: reduceTransparency, forceOpaque: forceOpaque,
                                                               increasedContrast: contrast == .increased, isEnabled: isEnabled))
        }
    }

    private func opaque(_ content: Content, _ spec: ConclaveControlSurfaceSpec) -> some View {
        content
            .foregroundStyle(HostingTheme.token(spec.glyphToken))
            .background(HostingTheme.token(spec.fillToken ?? DesignTokens.iosInCallControlFallback), in: ConclaveControlOutline(shape: shape))
            .overlay { ConclaveControlStroke(token: spec.strokeToken, shape: shape) }
            .opacity(dimming(spec))
    }

    private func dimming(_ spec: ConclaveControlSurfaceSpec) -> Double {
        spec.opacity * (isPressed ? ConclaveControlPress.opacity : 1)
    }
}

private enum ConclaveControlPress {
    static let opacity = 0.6
}

private struct ConclaveControlStroke: View {
    let token: Int64?
    let shape: ConclaveControlShape

    var body: some View {
        if let token {
            ConclaveControlOutline(shape: shape).strokeBorder(HostingTheme.token(token), lineWidth: 1)
        }
    }
}

private struct ConclaveControlButtonStyle: ButtonStyle {
    let state: ConclaveControlState
    let isEnabled: Bool
    let diameter: CGFloat
    var context: ConclaveSurfaceContext = .stage

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
            .modifier(ConclaveControlSurface(state: state, isEnabled: isEnabled, shape: .circle, context: context))
            .conclaveControlPressed(configuration.isPressed)
    }
}

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
    let context: ConclaveSurfaceContext
    let identifier: String
    let action: () -> Void

    init(title: String, value: String, systemImage: String, state: ConclaveControlState, isEnabled: Bool = true,
         diameter: CGFloat? = nil, inputLabels: [String] = [], feedback: FeedbackKind? = nil,
         gestureRoute: ConclaveGestureRoute = .live, context: ConclaveSurfaceContext = .stage, identifier: String,
         action: @escaping () -> Void) {
        self.title = title
        self.value = value
        self.systemImage = systemImage
        self.state = state
        self.isEnabled = isEnabled
        self.diameter = diameter
        self.inputLabels = inputLabels
        self.feedback = feedback
        self.gestureRoute = gestureRoute
        self.context = context
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
            .buttonStyle(ConclaveControlButtonStyle(state: toggle.state, isEnabled: toggle.isEnabled, diameter: size,
                                                    context: toggle.context))
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
            .background(HostingTheme.inCallLeave, in: Circle())
            .contentShape(Circle())
            .opacity(configuration.isPressed ? ConclaveControlPress.opacity : 1)
    }
}

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

struct ConclaveLabelledCallToggle: View {
    let title: String
    let value: String
    let systemImage: String
    let state: ConclaveControlState
    let isEnabled: Bool
    let inputLabels: [String]
    let feedback: FeedbackKind?
    let gestureRoute: ConclaveGestureRoute
    let context: ConclaveSurfaceContext
    let identifier: String
    let action: () -> Void

    init(title: String, value: String, systemImage: String, state: ConclaveControlState, isEnabled: Bool = true,
         inputLabels: [String] = [], feedback: FeedbackKind? = nil, gestureRoute: ConclaveGestureRoute = .live,
         context: ConclaveSurfaceContext = .onSurface, identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.value = value
        self.systemImage = systemImage
        self.state = state
        self.isEnabled = isEnabled
        self.inputLabels = inputLabels
        self.feedback = feedback
        self.gestureRoute = gestureRoute

        self.context = context == .stage ? .onSurface : context
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        VStack(spacing: 6) {
            ConclaveCallToggle(title: title, value: value, systemImage: systemImage, state: state, isEnabled: isEnabled,
                               inputLabels: inputLabels, feedback: feedback, gestureRoute: gestureRoute, context: context,
                               identifier: identifier, action: action)
            Text(value)
                .font(.caption)
                .foregroundStyle(context == .overVideo ? HostingTheme.token(DesignTokens.iosInCallText) : HostingTheme.inCallTextSecondary)
                .padding(.horizontal, context == .overVideo ? 6 : 0)
                .background {
                    if context == .overVideo { Capsule().fill(HostingTheme.inCallLabelScrim) }
                }
                .opacity(isEnabled ? 1 : ConclaveControlSurfaceMapping.disabledOpacity)
                .accessibilityHidden(true)
        }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

enum ConclaveChromeContext: String, CaseIterable {
    case stage, lobbyCard

    var surface: ConclaveSurfaceContext { self == .stage ? .stage : .overVideo }
}

enum ConclaveChromeMetrics {

    static let height: CGFloat = 44

    static let capsuleMaxWidthFraction: CGFloat = 0.6
}

struct ConclaveMeetingCapsule: View {
    let title: String
    let subtitle: String
    let isLocked: Bool
    let captionsOn: Bool
    let isLive: Bool
    let maxWidth: CGFloat?
    let context: ConclaveChromeContext
    let identifier: String
    let action: () -> Void

    init(title: String, subtitle: String, isLocked: Bool = false, captionsOn: Bool = false, isLive: Bool = false, maxWidth: CGFloat? = nil,
         context: ConclaveChromeContext = .stage, identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.subtitle = subtitle
        self.isLocked = isLocked
        self.captionsOn = captionsOn
        self.isLive = isLive
        self.maxWidth = maxWidth
        self.context = context
        self.identifier = identifier
        self.action = action
    }

    private var value: String {
        isLocked ? subtitle + ", " + ConclaveStrings.text("Locked") : subtitle
    }

    var body: some View {
        let compact = (maxWidth ?? .infinity) < 180
        Button(action: action) {
            HStack(spacing: 8) {
                if isLive && !compact {
                    Circle()
                        .fill(HostingTheme.token(DesignTokens.iosInCallLive))
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
                if isLocked && !compact {
                    Image(systemName: ConclaveSymbols.lockFill)
                        .font(.subheadline)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if captionsOn && !compact {
                    Image(systemName: ConclaveSymbols.captionsBubbleFill)
                        .font(.subheadline)
                        .accessibilityHidden(true)
                }
                Image(systemName: ConclaveSymbols.chevronRight)
                    .font(.caption.weight(.semibold))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: ConclaveChromeMetrics.height)
            .contentShape(Capsule())
        }
        .buttonStyle(ConclaveChromeButtonStyle(shape: .capsule, context: context))
        .frame(maxWidth: maxWidth, alignment: .leading)
        .accessibilityLabel(title)
        .accessibilityValue(value)
        .accessibilityShowsLargeContentViewer {
            Label(title, systemImage: isLocked ? ConclaveSymbols.lockFill : ConclaveSymbols.person2)
        }
        .accessibilityIdentifier(identifier)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

struct ConclaveChromeButton: View {
    let title: String
    let value: String?
    let systemImage: String
    let context: ConclaveChromeContext
    let identifier: String
    let action: () -> Void

    init(title: String, value: String? = nil, systemImage: String, context: ConclaveChromeContext = .stage,
         identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.value = value
        self.systemImage = systemImage
        self.context = context
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            ConclaveControlGlyphImage(systemImage: systemImage)
                .frame(width: ConclaveChromeMetrics.height, height: ConclaveChromeMetrics.height)
                .contentShape(Circle())
        }
        .buttonStyle(ConclaveChromeButtonStyle(shape: .circle, context: context))
        .accessibilityLabel(title)
        .modifier(InvokerValue(text: value))
        .accessibilityShowsLargeContentViewer {
            Label(title, systemImage: systemImage)
        }
        .accessibilityIdentifier(identifier)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

private struct ConclaveChromeButtonStyle: ButtonStyle {
    let shape: ConclaveControlShape
    let context: ConclaveChromeContext

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(ConclaveControlSurface(state: .on, isEnabled: true, shape: shape, context: context.surface))
            .conclaveControlPressed(configuration.isPressed)
    }
}

struct ConclaveRoutePickerButton: View {
    let context: ConclaveChromeContext
    let identifier: String
    let onPresentingChange: (Bool) -> Void

    init(context: ConclaveChromeContext = .stage, identifier: String, onPresentingChange: @escaping (Bool) -> Void = { _ in }) {
        self.context = context
        self.identifier = identifier
        self.onPresentingChange = onPresentingChange
    }

    var body: some View {
        ConclaveRoutePickerView(onPresentingChange: onPresentingChange)
            .frame(width: ConclaveChromeMetrics.height, height: ConclaveChromeMetrics.height)
            .modifier(ConclaveControlSurface(state: .on, isEnabled: true, shape: .circle, context: context.surface))
            .accessibilityIdentifier(identifier)
    }
}

private struct ConclaveRoutePickerView: UIViewRepresentable {
    let onPresentingChange: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onPresentingChange: onPresentingChange)
    }

    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.tintColor = UIColor(HostingTheme.token(DesignTokens.iosInCallText))
        view.activeTintColor = UIColor(HostingTheme.inCallCoralText)
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {
        context.coordinator.onPresentingChange = onPresentingChange
    }

    final class Coordinator: NSObject, AVRoutePickerViewDelegate {
        var onPresentingChange: (Bool) -> Void

        init(onPresentingChange: @escaping (Bool) -> Void) {
            self.onPresentingChange = onPresentingChange
        }

        func routePickerViewWillBeginPresentingRoutes(_ routePickerView: AVRoutePickerView) {
            onPresentingChange(true)
        }

        func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
            onPresentingChange(false)
        }
    }
}

struct ConclaveTopChromeCluster<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    #if DEBUG
    @Environment(\.conclaveForceOpaqueControls) private var forceOpaqueSetting
    #endif

    init(spacing: CGFloat = CGFloat(DesignTokens.space8), @ViewBuilder content: @escaping () -> Content) {
        self.spacing = spacing
        self.content = content
    }

    private var forceOpaque: Bool {
        #if DEBUG
        return forceOpaqueSetting
        #else
        return false
        #endif
    }

    @ViewBuilder
    var body: some View {
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
