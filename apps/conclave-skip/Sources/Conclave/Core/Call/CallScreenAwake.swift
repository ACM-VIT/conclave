

import Foundation
import Observation
import SwiftUI
#if canImport(UIKit) && !SKIP
import UIKit
#endif

enum CallScreenAwakeReadout {
    static let awakeKey = "sys.awake"
    static let proximityKey = "sys.proximity"
}

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

@MainActor
@Observable
final class CallScreenAwakeState {
    static let shared = CallScreenAwakeState(
        writers: ScreenAwakeWriters.platform(),
        presenceDrivesIdleTimer: CallScreenAwake.presenceDrivesIdleTimer
    )

    private(set) var keepsScreenAwake = false

    private(set) var awakeReadout = "0"

    private(set) var proximityReadout = "off"

    let writers: ScreenAwakeWriters

    let presenceDrivesIdleTimer: Bool

    @ObservationIgnored private(set) var legacyActive = false
    @ObservationIgnored private(set) var proximityArmed = false
    @ObservationIgnored private(set) var idleTimerDisabled = false
    @ObservationIgnored private(set) var proximityState: ProximityState = .off

    @ObservationIgnored private(set) var idleTimerWriteCount = 0
    @ObservationIgnored private(set) var keepAwakeEdgeCount = 0
    @ObservationIgnored private(set) var proximityWriteCount = 0
    @ObservationIgnored private var monitoringActive = false
    @ObservationIgnored private var isNear = false

    init(writers: ScreenAwakeWriters, presenceDrivesIdleTimer: Bool) {
        self.writers = writers
        self.presenceDrivesIdleTimer = presenceDrivesIdleTimer
    }

    func updateLegacyGate(_ active: Bool) {
        guard legacyActive != active else { return }
        legacyActive = active
        refreshIdleTimer()
        refreshAwakeReadout()
    }

    func makePresenceAdapter() -> CallPresenceAdapter {
        CallPresenceAdapter(name: "screenAwake", presenceDidChange: { [weak self] _, new in
            self?.applyPresence(keepsAwake: new.keepsScreenAwake, armed: new.proximityArmed)
        })
    }

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

    func reportProximityMonitoring(active: Bool) {
        guard monitoringActive != active else { return }
        monitoringActive = active
        if !active {
            isNear = false
        }
        refreshProximityState()
    }

    func reportProximityNear(_ near: Bool) {
        guard proximityArmed && monitoringActive else { return }
        guard isNear != near else { return }
        isNear = near
        refreshProximityState()
    }

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

    static func setActive(_ active: Bool) {
        CallScreenAwakeState.shared.updateLegacyGate(active)
    }

    static func makePresenceAdapter() -> CallPresenceAdapter {
        CallScreenAwakeState.shared.makePresenceAdapter()
    }

    static func withScreenAwake(_ base: CallPresenceAdapters) -> CallPresenceAdapters {
        CallPresenceAdapters(base.adapters + [makePresenceAdapter()])
    }

    static var presenceDrivesIdleTimer: Bool {
        #if SKIP
        return false
        #else
        return true
        #endif
    }

    static func writeIdleTimerDisabled(_ active: Bool) {
        #if SKIP

        UIApplication.shared.isIdleTimerDisabled = active
        #elseif os(iOS)
        UIApplication.shared.isIdleTimerDisabled = active
        #endif
    }

    static func writeProximityMonitoring(_ armed: Bool) {
        #if SKIP

        ProximityController.setArmed(armed)
        #elseif os(iOS)
        let device = UIDevice.current
        if armed && !proximityObserverInstalled {

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

        CallScreenAwakeState.shared.reportProximityMonitoring(active: device.isProximityMonitoringEnabled)
        #endif
    }

    private static var proximityObserverInstalled = false
}
