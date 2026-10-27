#if os(iOS) && !SKIP
import Combine
import SwiftUI
import UIKit

// One reader per system accessibility setting (S70 13 c). Leaves read the environment directly
// (`accessibilityReduceMotion`, `accessibilityReduceTransparency`, `colorSchemeContrast`, `legibilityWeight`,
// `accessibilityDifferentiateWithoutColor`, `accessibilityDimFlashingLights`, `accessibilityPlayAnimatedImages`);
// presenters get the few values they need pushed as the shared `SystemAccessibilityState` from one root reader.
// Settings apply live: every value comes from the environment or a change notification, never a launch read.

extension View {
    /// Root reader: reports the current `SystemAccessibilityState` at once and on every change (equality guarded).
    /// `forceScreenReader` is the Debug fixture override (S20 SL14 `CONCLAVE_STAGE_FORCE_SCREEN_READER`).
    func conclaveSystemAccessibility(forceScreenReader: Bool = false,
                                     onChange: @escaping (SystemAccessibilityState) -> Void) -> some View {
        modifier(ConclaveSystemAccessibilityReader(forceScreenReader: forceScreenReader, onChange: onChange))
    }
}

struct ConclaveSystemAccessibilityReader: ViewModifier {
    let forceScreenReader: Bool
    let onChange: (SystemAccessibilityState) -> Void
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilitySwitchControlEnabled) private var switchControl
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @State private var prefersCrossFade = UIAccessibility.prefersCrossFadeTransitions
    @State private var assistiveAccess = false

    private var state: SystemAccessibilityState {
        SystemAccessibilityMapping.iosState(voiceOver: voiceOver || forceScreenReader, switchControl: switchControl,
                                            assistiveAccess: assistiveAccess, reduceMotion: reduceMotion,
                                            prefersCrossFade: prefersCrossFade,
                                            differentiateWithoutColor: differentiateWithoutColor)
    }

    func body(content: Content) -> some View {
        content
            .modifier(ConclaveAssistiveAccessReader(isRunning: $assistiveAccess))
            // iOS 26.4 adds an environment value for the same setting; the UIKit reader covers iOS 17 and later
            // with one code path (S70 13 c).
            .onReceive(NotificationCenter.default.publisher(for: UIAccessibility.prefersCrossFadeTransitionsStatusDidChange)) { _ in
                let value = UIAccessibility.prefersCrossFadeTransitions
                if prefersCrossFade != value { prefersCrossFade = value }
            }
            .onChange(of: state, initial: true) { _, newState in
                onChange(newState)
            }
    }
}

/// Assistive Access is an iOS 18 environment value; iOS 17 reads it as off (S70 13 c).
private struct ConclaveAssistiveAccessReader: ViewModifier {
    @Binding var isRunning: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.modifier(AssistiveAccessProbe(isRunning: $isRunning))
        } else {
            content
        }
    }
}

@available(iOS 18.0, *)
private struct AssistiveAccessProbe: ViewModifier {
    @Binding var isRunning: Bool
    @Environment(\.accessibilityAssistiveAccessEnabled) private var enabled

    func body(content: Content) -> some View {
        content.onChange(of: enabled, initial: true) { _, value in
            if isRunning != value { isRunning = value }
        }
    }
}

/// The settings leaves read, gathered for readouts and the Debug gallery. Production leaves read the environment
/// values themselves; this exists so one view can show every reader at once.
struct ConclaveAccessibilityReadings: Equatable {
    let reduceMotion: Bool
    let reduceTransparency: Bool
    let increasedContrast: Bool
    let boldText: Bool
    let differentiateWithoutColor: Bool
    let dimFlashingLights: Bool
    let playAnimatedImages: Bool
}

/// Hands the current readings to `content`; recomputed only when one of the environment values changes.
struct ConclaveAccessibilityReadingsReader<Content: View>: View {
    @ViewBuilder let content: (ConclaveAccessibilityReadings) -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.legibilityWeight) private var legibilityWeight
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @Environment(\.accessibilityDimFlashingLights) private var dimFlashingLights
    @Environment(\.accessibilityPlayAnimatedImages) private var playAnimatedImages

    var body: some View {
        content(ConclaveAccessibilityReadings(reduceMotion: reduceMotion, reduceTransparency: reduceTransparency,
                                              increasedContrast: contrast == .increased, boldText: legibilityWeight == .bold,
                                              differentiateWithoutColor: differentiateWithoutColor,
                                              dimFlashingLights: dimFlashingLights, playAnimatedImages: playAnimatedImages))
    }
}
#endif
