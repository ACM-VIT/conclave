//  S70 4 (SYS-5), 0.6 SX5: keep awake and proximity. Transpiled; the iOS platform calls live only in the
//  `#elseif os(iOS)` branches below, never in the `#if SKIP` branches (SkipUI maps the idle timer to
//  FLAG_KEEP_SCREEN_ON; the Android proximity wake lock is K/ProximityController.kt).
//
//  Two sources keep the screen on:
//  - the legacy joined-call gate, `CallScreenAwake.setActive(_:)`, still called from
//    MeetingViewModel.activateCallPresence() / deactivateCallPresence() (the legacy route keeps it until WP11);
//  - the presence rule, `CallPresenceSnapshot.keepsScreenAwake` (waiting, connecting, live, recovering, on hold),
//    delivered by the "screenAwake" presence adapter. On iOS it writes the idle timer too, so waiting keeps the
//    screen awake; on Android it is Compose-scoped (`KeepScreenOnEffect` in the native roots reads
//    `CallScreenAwakeState.shared.keepsScreenAwake`).
//  `CallPresenceSnapshot.proximityArmed` (ProximityPolicy) drives the proximity sensor on both platforms. Every
//  platform value is written only on change; near and far never leave this controller (no snapshot field).
import Foundation
import Observation
import SwiftUI
#if canImport(UIKit) && !SKIP
import UIKit
#endif

/// S70 SX1 Debug readout keys (`accessibilityIdentifier` on iOS, `testTag` on Android), ASCII values.
enum CallScreenAwakeReadout {
    static let awakeKey = "sys.awake"
    static let proximityKey = "sys.proximity"
}

/// The two platform writers (S70 4 l3 recording seam): tests install recording closures, the app the platform ones.
@MainActor
final class ScreenAwakeWriters {
    let setIdleTimerDisabled: (Bool) -> Void
    let setProximityMonitoring: (Bool) -> Void

    init(setIdleTimerDisabled: @escaping (Bool) -> Void, setProximityMonitoring: @escaping (Bool) -> Void) {
        self.setIdleTimerDisabled = setIdleTimerDisabled
        self.setProximityMonitoring = setProximityMonitoring
    }

    static func platform() -> ScreenAwakeWriters {
        ScreenAwakeWriters(
            setIdleTimerDisabled: { active in
                CallScreenAwake.writeIdleTimerDisabled(active)
            },
            setProximityMonitoring: { armed in
                CallScreenAwake.writeProximityMonitoring(armed)
            }
        )
    }
}

/// The keep-awake and proximity edge writer (S70 4, SX5). Process-wide like the idle timer, the proximity sensor
/// and the Android wake lock it drives. It never observes the presence snapshot: the "screenAwake" adapter pushes
/// the two fields, and each writer runs once per edge. Only `keepsScreenAwake` is read by a production view (the
/// Android native roots); the two readouts are read by the Debug system fixture only, so near and far flips
/// invalidate no production view.
@MainActor
@Observable
final class CallScreenAwakeState {
    static let shared = CallScreenAwakeState(
        writers: ScreenAwakeWriters.platform(),
        presenceDrivesIdleTimer: CallScreenAwake.presenceDrivesIdleTimer
    )

    /// The presence keep-awake rule (S70 4 a). Android `CallKeepScreenOnEffect()` reads it.
    private(set) var keepsScreenAwake = false
    /// `sys.awake`: `1` while the legacy gate or the presence rule keeps the screen on.
    private(set) var awakeReadout = "0"
    /// `sys.proximity`: `off`, `armed` or `near`.
    private(set) var proximityReadout = "off"

    let writers: ScreenAwakeWriters
    /// True on iOS (and the macOS host); false on Android, where the presence rule is Compose-scoped (4 d).
    let presenceDrivesIdleTimer: Bool

    @ObservationIgnored private(set) var legacyActive = false
    @ObservationIgnored private(set) var proximityArmed = false
    @ObservationIgnored private(set) var idleTimerDisabled = false
    @ObservationIgnored private(set) var proximityState: ProximityState = .off
    /// Diagnostics for the recording tests (S70 4 l3).
    @ObservationIgnored private(set) var idleTimerWriteCount = 0
    @ObservationIgnored private(set) var keepAwakeEdgeCount = 0
    @ObservationIgnored private(set) var proximityWriteCount = 0
    @ObservationIgnored private var monitoringActive = false
    @ObservationIgnored private var isNear = false

    init(writers: ScreenAwakeWriters, presenceDrivesIdleTimer: Bool) {
        self.writers = writers
        self.presenceDrivesIdleTimer = presenceDrivesIdleTimer
    }

    // MARK: Sources

    /// The legacy joined-call gate (`CallScreenAwake.setActive(_:)`).
    func updateLegacyGate(_ active: Bool) {
        guard legacyActive != active else { return }
        legacyActive = active
        refreshIdleTimer()
        refreshAwakeReadout()
    }

    /// The presence adapter (S70 0.5 fan-out). It reads only `keepsScreenAwake` and `proximityArmed`.
    func makePresenceAdapter() -> CallPresenceAdapter {
        CallPresenceAdapter(name: "screenAwake", presenceDidChange: { [weak self] _, new in
            self?.applyPresence(keepsAwake: new.keepsScreenAwake, armed: new.proximityArmed)
        })
    }

    /// The two snapshot fields (`keepsScreenAwake`, `proximityArmed`); each writer runs once per edge.
    func applyPresence(keepsAwake: Bool, armed: Bool) {
        if keepsScreenAwake != keepsAwake {
            keepsScreenAwake = keepsAwake
            keepAwakeEdgeCount += 1
            refreshIdleTimer()
            refreshAwakeReadout()
        }
        if proximityArmed != armed {
            proximityArmed = armed
            if !armed {
                isNear = false
            }
            proximityWriteCount += 1
            writers.setProximityMonitoring(armed)
            refreshProximityState()
        }
    }

    // MARK: Platform reports

    /// Whether the platform is monitoring after a write or a lifecycle change: iOS reads back
    /// `isProximityMonitoringEnabled` (false without a sensor), Android whether its proximity wake lock is held.
    func reportProximityMonitoring(active: Bool) {
        guard monitoringActive != active else { return }
        monitoringActive = active
        if !active {
            isNear = false
        }
        refreshProximityState()
    }

    /// The sensor's near or far (iOS `proximityStateDidChangeNotification`, Android the Debug sensor listener).
    /// Readout only: the system blanks the display itself, and nothing here reaches the presence snapshot.
    func reportProximityNear(_ near: Bool) {
        guard proximityArmed && monitoringActive else { return }
        guard isNear != near else { return }
        isNear = near
        refreshProximityState()
    }

    // MARK: Private

    private func refreshIdleTimer() {
        let next = KeepAwakePolicy.idleTimerDisabled(
            legacyActive: legacyActive,
            presenceKeepsAwake: keepsScreenAwake,
            presenceDrivesIdleTimer: presenceDrivesIdleTimer
        )
        guard next != idleTimerDisabled else { return }
        idleTimerDisabled = next
        idleTimerWriteCount += 1
        writers.setIdleTimerDisabled(next)
    }

    private func refreshAwakeReadout() {
        let readout = KeepAwakePolicy.readout(keepsScreenAwake || legacyActive)
        if awakeReadout != readout {
            awakeReadout = readout
        }
    }

    private func refreshProximityState() {
        let next = ProximityPolicy.state(armed: proximityArmed, monitoringActive: monitoringActive, isNear: isNear)
        guard next != proximityState else { return }
        proximityState = next
        let readout = ProximityPolicy.readout(next)
        if proximityReadout != readout {
            proximityReadout = readout
        }
    }
}

@MainActor
enum CallScreenAwake {
    /// The legacy joined-call gate, called only from MeetingViewModel.activateCallPresence() /
    /// deactivateCallPresence() (the same gate as the legacy CallKit and Android call service wiring).
    static func setActive(_ active: Bool) {
        CallScreenAwakeState.shared.updateLegacyGate(active)
    }

    /// The "screenAwake" presence adapter over the shared writer (installed once by the view model, and by the
    /// Debug system fixture for its standalone presence).
    static func makePresenceAdapter() -> CallPresenceAdapter {
        CallScreenAwakeState.shared.makePresenceAdapter()
    }

    /// `base` plus the "screenAwake" adapter (handwritten Kotlin appends it with this instead of a Skip array).
    static func withScreenAwake(_ base: CallPresenceAdapters) -> CallPresenceAdapters {
        CallPresenceAdapters(base.adapters + [makePresenceAdapter()])
    }

    /// On Android the presence rule is Compose-scoped (`KeepScreenOnEffect`), not SkipUI's window flag (S70 4 d, m).
    static var presenceDrivesIdleTimer: Bool {
        #if SKIP
        return false
        #else
        return true
        #endif
    }

    /// The idle timer writer, called only on edges by `CallScreenAwakeState`.
    static func writeIdleTimerDisabled(_ active: Bool) {
        #if SKIP
        // SkipUI maps this to FLAG_KEEP_SCREEN_ON on the activity window and
        // re-applies it when a recreated MainActivity is attached.
        UIApplication.shared.isIdleTimerDisabled = active
        #elseif os(iOS)
        UIApplication.shared.isIdleTimerDisabled = active
        #endif
    }

    /// The proximity writer, called only on edges by `CallScreenAwakeState`. The platform reports back whether it is
    /// monitoring (`reportProximityMonitoring(active:)`) and near or far (`reportProximityNear(_:)`).
    static func writeProximityMonitoring(_ armed: Bool) {
        #if SKIP
        // Holds or releases PROXIMITY_SCREEN_OFF_WAKE_LOCK (released with RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY).
        ProximityController.setArmed(armed)
        #elseif os(iOS)
        let device = UIDevice.current
        if armed && !proximityObserverInstalled {
            // Once per process; the system posts it only while monitoring is enabled.
            proximityObserverInstalled = true
            _ = NotificationCenter.default.addObserver(
                forName: UIDevice.proximityStateDidChangeNotification,
                object: nil,
                queue: .main
            ) { _ in
                MainActor.assumeIsolated {
                    CallScreenAwakeState.shared.reportProximityNear(UIDevice.current.proximityState)
                }
            }
        }
        if device.isProximityMonitoringEnabled != armed {
            device.isProximityMonitoringEnabled = armed
        }
        // A device without a sensor (iPad) reads back false, so the state stays off.
        CallScreenAwakeState.shared.reportProximityMonitoring(active: device.isProximityMonitoringEnabled)
        #endif
    }

    private static var proximityObserverInstalled = false
}
