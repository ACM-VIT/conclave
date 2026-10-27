import Foundation

// S70 5 c, 5 d and SX11 (SYS-2): what the route owner does when the active audio route changes, and how system
// interruptions map onto `AudioInterruptionKind`. Pure and transpiled (host tests on macOS and in Robolectric):
// String raw-value enums, scalar structs and arrays of strings only. Replaces the blind re-assertion at 0, 250 ms,
// 1 s and 2.5 s that re-applied the app's own selection and could revert a choice made in system UI (CE B13, B15,
// B16), and the silent clearing of explicit choices (CE G8).

/// One vocabulary for both platforms. iOS passes `AVAudioSession.RouteChangeReason` through
/// `fromIOSRawValue(_:)`; Android maps its callbacks: `AudioDeviceCallback` additions and removals to
/// `newDeviceAvailable` and `oldDeviceUnavailable`, a communication device change through
/// `classifyCommunicationDeviceChange`.
enum AudioRouteChangeReason: String, CaseIterable, Equatable {
    case newDeviceAvailable, oldDeviceUnavailable, categoryChange, routeConfigurationChange, wakeFromSleep
    case noSuitableRouteForCategory, unknown
    /// `AVAudioSession.RouteChangeReason.override` (named `routeOverride` because `override` is a keyword in Kotlin
    /// and a declaration modifier in Swift; the raw value stays "override").
    case routeOverride = "override"

    /// `AVAudioSession.RouteChangeReason` raw values (AVAudioSessionTypes.h): 0 unknown, 1 newDeviceAvailable,
    /// 2 oldDeviceUnavailable, 3 categoryChange, 4 override, 6 wakeFromSleep, 7 noSuitableRouteForCategory,
    /// 8 routeConfigurationChange.
    static func fromIOSRawValue(_ rawValue: Int) -> AudioRouteChangeReason {
        switch rawValue {
        case 1: return .newDeviceAvailable
        case 2: return .oldDeviceUnavailable
        case 3: return .categoryChange
        case 4: return .routeOverride
        case 6: return .wakeFromSleep
        case 7: return .noSuitableRouteForCategory
        case 8: return .routeConfigurationChange
        default: return .unknown
        }
    }
}

/// The explicit intent as the policy sees it. `routeId` is the owner's `preferredRouteIntent` ("" follows the
/// system default); `presentId` is the option id that matches the intent now ("" while its device is absent; on
/// Android a reconnected Bluetooth device gets a new id, so the owner matches by kind and name); `wasPresent`
/// says whether it matched before this change.
struct AudioRouteIntentState: Equatable {
    let routeId: String
    let presentId: String
    let wasPresent: Bool
}

/// The active route around the change. `defaultId` is what the platform's default order picks with the devices
/// present now: Android full-duplex external, output-only external, speaker, earpiece (CE G20); iOS the system's
/// external choice, or the speaker when no external device remains (S70 5 c: fall back to the speaker).
struct AudioRouteState: Equatable {
    let previousId: String
    let currentId: String
    let defaultId: String
}

enum AudioRouteChangeActionKind: String, CaseIterable, Equatable {
    /// The intent's device returned: route back to it.
    case restoreIntent
    /// A different device arrived: follow the default order (system default).
    case adoptNewDevice
    /// The active device left: keep the intent, fall back.
    case fallBack
    /// The person chose a route in system UI (Control Center, the route list, the Android output switcher): it
    /// becomes the intent.
    case adoptAsIntent
    /// The change is the owner's own request landing.
    case confirmOwnRequest
    /// A re-read found the intent's device present but not active: apply it again.
    case reapplyIntent
    /// Nothing to do.
    case keep
    /// Ignored by rule (`categoryChange`).
    case ignore
}

struct AudioRouteChangeAction: Equatable {
    let kind: AudioRouteChangeActionKind
    /// The option id the owner asks the backend to apply; "" applies nothing.
    let targetId: String
    /// The intent after this change.
    let intentId: String
    /// The route the call ends on (the target when one is applied, else the current route).
    let finalId: String
    /// At most one `routeChanged` stage event (S20 SC18), for automatic changes only.
    let postsRouteChanged: Bool
    /// Capture recovery (the microphone restart) only after a real change, never on a timer.
    let restartsCapture: Bool
}

enum AudioRouteChangePolicy {
    /// S70 5 c: any change within 2 s after the system route list closes is the person's choice.
    static let systemPickerWindowMillis: Double = 2_000
    /// A change within this window after the owner's own request, landing on the requested route, is that request.
    static let ownRequestWindowMillis: Double = 1_500
    /// S30 3 d: a requested switch that has not landed after 3 s fails.
    static let requestTimeoutMillis: Double = 3_000
    /// Android throttle between automatic re-applies (CE G17, kept).
    static let androidReapplyThrottleMillis: Double = 700

    /// A change while the system route list was just used is a choice made there (adopted, no toast), except a
    /// device loss, which keeps the intent, and a category change, which is always ignored.
    static func effectiveReason(_ reason: AudioRouteChangeReason, isWithinSystemPickerWindow: Bool) -> AudioRouteChangeReason {
        guard isWithinSystemPickerWindow else { return reason }
        switch reason {
        case .oldDeviceUnavailable, .categoryChange:
            return reason
        default:
            return .routeOverride
        }
    }

    /// S70 SX11 `action(reason:intent:current:pendingOwnRequest:)`: the S70 5 c reason table.
    static func action(
        reason: AudioRouteChangeReason,
        intent: AudioRouteIntentState,
        current: AudioRouteState,
        pendingOwnRequest: Bool
    ) -> AudioRouteChangeAction {
        let now = current.currentId
        switch reason {
        case .categoryChange:
            return make(.ignore, target: "", intent: intent.routeId, landing: now, current: current, posts: false, restarts: false)

        case .oldDeviceUnavailable:
            // Keep the intent; fall back to it if its device is still here, else to the default order.
            var fallback = intent.presentId
            if fallback.isEmpty {
                fallback = current.defaultId
            }
            let landing = fallback.isEmpty ? now : fallback
            return make(.fallBack, target: landing == now ? "" : landing, intent: intent.routeId, landing: landing,
                        current: current, posts: landing != current.previousId, restarts: landing != current.previousId)

        case .newDeviceAvailable:
            if pendingOwnRequest {
                return make(.confirmOwnRequest, target: "", intent: intent.routeId, landing: now, current: current,
                            posts: false, restarts: now != current.previousId)
            }
            if !intent.routeId.isEmpty && !intent.presentId.isEmpty && !intent.wasPresent {
                // The intent's device came back: restore it.
                let target = intent.presentId
                return make(.restoreIntent, target: target == now ? "" : target, intent: intent.routeId, landing: target,
                            current: current, posts: target != current.previousId, restarts: target != current.previousId)
            }
            let followed = current.defaultId.isEmpty ? now : current.defaultId
            if !intent.routeId.isEmpty && intent.wasPresent && intent.presentId == followed {
                // The default order still picks the intent: nothing moves.
                return make(.keep, target: followed == now ? "" : followed, intent: intent.routeId, landing: followed,
                            current: current, posts: followed != current.previousId, restarts: followed != current.previousId)
            }
            // A different device arrived. An explicit choice whose device is still here gives way to it (otherwise a
            // later re-read would route back and fight the newcomer); a lost device keeps its claim, so its return
            // still restores it.
            let nextIntent = (intent.wasPresent && !intent.presentId.isEmpty) ? "" : intent.routeId
            return make(.adoptNewDevice, target: followed == now ? "" : followed, intent: nextIntent, landing: followed,
                        current: current, posts: followed != current.previousId, restarts: followed != current.previousId)

        case .routeOverride:
            if pendingOwnRequest {
                return make(.confirmOwnRequest, target: "", intent: intent.routeId, landing: now, current: current,
                            posts: false, restarts: now != current.previousId)
            }
            // Chosen in system UI: the new route is the new explicit intent. The list confirmed it, so no toast.
            return make(.adoptAsIntent, target: "", intent: now, landing: now, current: current,
                        posts: false, restarts: now != current.previousId)

        case .routeConfigurationChange, .wakeFromSleep, .noSuitableRouteForCategory, .unknown:
            if pendingOwnRequest {
                return make(.confirmOwnRequest, target: "", intent: intent.routeId, landing: now, current: current,
                            posts: false, restarts: now != current.previousId)
            }
            if !intent.routeId.isEmpty && !intent.presentId.isEmpty && intent.presentId != now {
                let target = intent.presentId
                return make(.reapplyIntent, target: target, intent: intent.routeId, landing: target, current: current,
                            posts: target != current.previousId, restarts: target != current.previousId)
            }
            return make(.keep, target: "", intent: intent.routeId, landing: now, current: current,
                        posts: now != current.previousId, restarts: now != current.previousId)
        }
    }

    /// Android `OnCommunicationDeviceChangedListener` (API 31+): a change caused by a device leaving or arriving is
    /// handled as that loss or arrival (the `AudioDeviceCallback` reports it too, in either order); only a change
    /// between two devices that were both present before and after is a choice made in system UI.
    static func classifyCommunicationDeviceChange(
        previousId: String,
        newId: String,
        previousAvailableIds: [String],
        currentAvailableIds: [String]
    ) -> AudioRouteChangeReason {
        if !previousId.isEmpty && !currentAvailableIds.contains(previousId) {
            return .oldDeviceUnavailable
        }
        if !newId.isEmpty && !previousAvailableIds.contains(newId) {
            return .newDeviceAvailable
        }
        if previousId == newId {
            return .routeConfigurationChange
        }
        return .routeOverride
    }

    /// Whether a change landing at `nowMillis` on `currentId` is the owner's own request made at `requestMillis`
    /// toward `targetId` ("" requested the system default, so any landing route counts). Negative `requestMillis`
    /// means no request.
    static func isOwnRequest(requestMillis: Double, targetId: String, currentId: String, nowMillis: Double) -> Bool {
        guard requestMillis >= 0, nowMillis - requestMillis <= ownRequestWindowMillis else { return false }
        return targetId.isEmpty || targetId == currentId
    }

    private static func make(
        _ kind: AudioRouteChangeActionKind,
        target: String,
        intent: String,
        landing: String,
        current: AudioRouteState,
        posts: Bool,
        restarts: Bool
    ) -> AudioRouteChangeAction {
        AudioRouteChangeAction(
            kind: kind,
            targetId: target,
            intentId: intent,
            finalId: landing,
            postsRouteChanged: posts && !landing.isEmpty,
            restartsCapture: restarts
        )
    }
}

/// System events that change what the microphone row and the banner lane say (S70 5 c, 5 d). The mute intent is
/// never changed by any of them.
enum AudioInterruptionEvent: String, CaseIterable, Equatable {
    /// iOS `.began` with reason `.default` (another call, Siri, an alarm).
    case began
    /// iOS `.began` with reason `.builtInMicMuted` (iPad cover closed).
    case beganBuiltInMicMuted
    /// iOS `.ended`.
    case ended
    /// `mediaServicesWereResetNotification` still unrecovered after 2 s.
    case servicesReset
    /// The session was rebuilt after a reset.
    case servicesRecovered
    /// Android `AUDIOFOCUS_LOSS` or `AUDIOFOCUS_LOSS_TRANSIENT` (a cellular call, another VoIP app).
    case focusLost
    /// Android `AUDIOFOCUS_GAIN`.
    case focusGained
}

enum AudioInterruptionPolicy {
    /// `AVAudioSession.InterruptionReason.builtInMicMuted` raw value (AVAudioSessionTypes.h).
    static let iosBuiltInMicMutedReason = 2
    /// S70 5 c: a media services reset shows nothing unless it lasts over 2 s.
    static let servicesResetNoticeDelayMillis: Double = 2_000

    /// The interruption after `event`. A CallKit hold (`held`, set through `CallPresence.handle(.hold)`) is sticky:
    /// only the resume command clears it, so the interruption that comes with the hold never overwrites it.
    static func next(current: AudioInterruptionKind, event: AudioInterruptionEvent) -> AudioInterruptionKind {
        if current == .held {
            return .held
        }
        switch event {
        case .began, .focusLost:
            return .otherAudio
        case .beganBuiltInMicMuted:
            return .deviceMicMuted
        case .servicesReset:
            return .servicesReset
        case .ended, .focusGained, .servicesRecovered:
            return .none
        }
    }

    /// iOS `.began` reason raw value to the event.
    static func beganEvent(reasonRawValue: Int) -> AudioInterruptionEvent {
        reasonRawValue == iosBuiltInMicMutedReason ? .beganBuiltInMicMuted : .began
    }

    /// Whether the event should re-apply the route intent once audio is back (focus regained, interruption over).
    static func reappliesIntent(_ event: AudioInterruptionEvent) -> Bool {
        event == .ended || event == .focusGained || event == .servicesRecovered
    }
}
