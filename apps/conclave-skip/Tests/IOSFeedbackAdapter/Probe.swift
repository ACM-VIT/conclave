import Foundation
import SwiftUI
import UIKit
import Darwin

// Compile with the six real production files, not the SwiftPM host-only test target.
// BASELINE_ADAPTER changes API binding only; no SUT behavior is implemented here.
@MainActor
final class Fixture {
    let owner = NativeHostingPresenter()
    let defaults: UserDefaults
    let suite = "conclave.feedback-probe." + UUID().uuidString
    let delivery: IOSFeedbackDelivery
    var mount = 0

    init() {
        defaults = UserDefaults(suiteName: suite)!
        delivery = IOSFeedbackDelivery(presenter: owner, defaults: defaults)
    }
    func clean() -> Bool {
        defaults.removePersistentDomain(forName: suite)
        return (defaults.persistentDomain(forName: suite) ?? [:]).isEmpty
    }
    func attach(_ id: Int, active: Bool = true) {
        #if BASELINE_ADAPTER
        delivery.setActive(active)
        delivery.attach()
        #else
        delivery.attach(mount: id, active: active)
        #endif
    }
    func detach(_ id: Int) {
        #if BASELINE_ADAPTER
        delivery.setActive(false)
        #else
        delivery.detach(mount: id)
        #endif
    }
    func active(_ value: Bool, _ id: Int) {
        #if BASELINE_ADAPTER
        delivery.setActive(value)
        #else
        delivery.setActive(value, mount: id)
        #endif
    }
    func refresh(_ id: Int) {
        #if BASELINE_ADAPTER
        delivery.refresh()
        #else
        delivery.refresh(mount: id)
        #endif
    }
    func observe(_ id: Int? = nil) {
        #if BASELINE_ADAPTER
        delivery.observe()
        #else
        delivery.observe(mount: id ?? mount)
        #endif
    }
    func complete(_ kind: FeedbackKind = .joined) {
        owner.completeNextFixtureAction(kind: kind)
        observe()
    }
    func remount(newFirst: Bool) {
        let old = mount
        mount += 1
        if newFirst { attach(mount); detach(old) }
        else { detach(old); attach(mount) }
    }
    var counters: [Int] {
        [owner.feedbackState.acceptedCount, owner.feedbackState.token.sequence, delivery.intendedCount]
    }
}

@main
@MainActor
struct FeedbackAdapterProbe {
    static var checks = 0
    static var failures = 0
    static var cases = 0
    static var current = ""
    static func emit(_ value: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
    static func check(_ value: Bool, _ name: String, actual: String = "", expected: String = "true") {
        checks += 1
        if !value { failures += 1 }
        emit(["type": "assertion", "case": current, "name": name, "pass": value,
              "actual": actual.isEmpty ? String(value) : actual, "expected": expected])
    }
    static func ledger(_ f: Fixture, _ expected: [Int], _ name: String) {
        check(f.counters == expected, name, actual: String(describing: f.counters), expected: String(describing: expected))
    }
    static func scenario(_ name: String, _ body: (Fixture) -> Void) {
        cases += 1
        current = name
        let f = Fixture()
        check(f.delivery.recordOnly, "immutable recording-only guard")
        check(f.defaults.object(forKey: ConclaveFeedback.preferenceKey) == nil, "isolated preference starts absent")
        body(f)
        check(f.delivery.effect == nil, "no sensory request published")
        check(f.clean(), "isolated suite cleaned")
    }
    static func main() {
        #if BASELINE_ADAPTER
        let variant = "unchanged-baseline"
        #else
        let variant = "mount-owned-adapter"
        #endif
        emit(["type": "start", "variant": variant, "os": ProcessInfo.processInfo.operatingSystemVersionString,
              "mainThread": Thread.isMainThread, "standardPreferencesWritten": false,
              "scope": "direct imposed callback orders; no SwiftUI mounting or physical effects"])
        check(Thread.isMainThread, "driver on main thread")
        scenario("A_no_remount_control") { f in
            f.attach(0)
            f.complete(); ledger(f, [1, 1, 1], "first")
            f.delivery.setSuspended(true)
            f.complete(); ledger(f, [2, 2, 1], "suppressed")
            f.delivery.setSuspended(false); f.observe(); ledger(f, [2, 2, 1], "resume quiet")
            f.complete(); ledger(f, [3, 3, 2], "fresh after resume")
        }
        for newFirst in [false, true] {
            scenario("B_remount_newFirst_\(newFirst)") { f in
                f.attach(0); f.complete(); ledger(f, [1, 1, 1], "first")
                f.remount(newFirst: newFirst); f.observe(); ledger(f, [1, 1, 1], "remount quiet")
                f.complete(); ledger(f, [2, 2, 2], "fresh after remount")
                f.owner.repeatLastFixtureCompletion(); f.observe(); ledger(f, [2, 2, 2], "duplicate quiet")
            }
            scenario("F1_full_ledger_newFirst_\(newFirst)") { f in
                f.attach(0); ledger(f, [0, 0, 0], "initial")
                f.complete(); ledger(f, [1, 1, 1], "first")
                f.owner.repeatLastFixtureCompletion(); f.observe(); ledger(f, [1, 1, 1], "repeat")
                f.delivery.gesture(); ledger(f, [1, 1, 2], "gesture separated")
                f.delivery.setSuspended(true); f.owner.completeNextFixtureAction(); f.delivery.setSuspended(false)
                f.observe(); ledger(f, [2, 2, 2], "coalesced pause event resume")
                f.complete(); ledger(f, [3, 3, 3], "fresh")
                f.remount(newFirst: newFirst); f.observe(); ledger(f, [3, 3, 3], "nonzero remount quiet")
                f.delivery.setSuspended(true); f.complete(); ledger(f, [4, 4, 3], "suppressed accepted")
                f.owner.repeatLastFixtureCompletion(); f.observe(); ledger(f, [4, 4, 3], "suppressed duplicate")
                f.delivery.setSuspended(false); f.observe(); ledger(f, [4, 4, 3], "resume quiet")
                f.complete(); ledger(f, [5, 5, 4], "F1 fresh after remount and resume")
            }
        }
        #if !BASELINE_ADAPTER
        repairedCoverage()
        #else
        emit(["type": "limit", "message": "Baseline exposes no prepare seam; no baseline deferred-ticket tests claimed."])
        #endif
        emit(["type": "summary", "variant": variant, "cases": cases, "assertions": checks, "failures": failures])
        exit(failures == 0 ? 0 : 1)
    }
    #if !BASELINE_ADAPTER
    static func repairedCoverage() {
        scenario("stale_callbacks_before_and_after_current_observation") { f in
            f.attach(0); f.complete(); f.remount(newFirst: true)
            f.owner.completeNextFixtureAction()
            let epoch = f.delivery.exposureEpoch
            f.attach(0, active: false); f.detach(0); f.active(false, 0); f.active(true, 0); f.refresh(0); f.observe(0)
            check(f.delivery.exposureEpoch == epoch, "stale callbacks leave epoch untouched")
            ledger(f, [2, 2, 1], "stale observation cannot deliver current fresh token")
            f.observe(); ledger(f, [2, 2, 2], "current fresh survives stale callbacks")
            f.attach(0); f.detach(0); f.active(false, 0); f.refresh(0); f.observe(0)
            f.complete(); ledger(f, [3, 3, 3], "later current fresh")
            f.active(false, 1); f.active(true, 0); f.complete()
            ledger(f, [4, 4, 3], "stale active cannot restore current inactive")
            f.active(true, 1); f.observe(); ledger(f, [4, 4, 3], "current restoration quiet")
            f.complete(); ledger(f, [5, 5, 4], "fresh after real owner restoration")
        }
        scenario("older_attach_after_newest_detach_and_same_mount_reappearance") { f in
            f.attach(0); f.complete(); f.remount(newFirst: true); f.detach(1)
            let epoch = f.delivery.exposureEpoch
            f.attach(0); f.active(true, 0); f.active(true, 1); f.observe(0); f.delivery.gesture()
            check(f.delivery.exposureEpoch == epoch, "no callback recreates detached ownership")
            f.complete(); ledger(f, [2, 2, 1], "detached outcome suppressed")
            f.attach(1); f.observe(); ledger(f, [2, 2, 1], "same mount sequential reappearance baselines")
            f.complete(); ledger(f, [3, 3, 2], "fresh after reappearance")
        }
        scenario("duplicate_attach_preserves_fresh_token_and_pending_ticket") { f in
            f.attach(0); f.owner.completeNextFixtureAction()
            let epoch = f.delivery.exposureEpoch
            f.attach(0, active: false)
            check(f.delivery.exposureEpoch == epoch, "duplicate attach does not rebaseline")
            f.observe(); ledger(f, [1, 1, 1], "fresh token survives duplicate attach")
            f.owner.completeNextFixtureAction()
            guard let ticket = f.delivery.prepareObservation(mount: 0) else { check(false, "real pending ticket exists"); return }
            f.attach(0)
            check(f.delivery.consume(ticket, mount: 0) != nil, "pending ticket survives duplicate attach")
            check(f.delivery.consume(ticket, mount: 0) == nil, "ticket consumed once")
        }
        scenario("stale_observe_and_consume_cannot_steal_current_ticket") { f in
            f.attach(0); f.remount(newFirst: true); f.owner.completeNextFixtureAction()
            check(f.delivery.prepareObservation(mount: 0) == nil, "stale prepare cannot capture fresh unobserved token")
            guard let ticket = f.delivery.prepareObservation(mount: 1) else { check(false, "real pending ticket exists"); return }
            check(f.delivery.prepareObservation(mount: 0) == nil, "stale prepare rejected")
            f.observe(0)
            check(f.delivery.consume(ticket, mount: 0) == nil, "stale consume rejected before take")
            check(f.delivery.consume(ticket, mount: 1) != nil, "current ticket was not stolen")
            check(f.delivery.consume(ticket, mount: 1) == nil, "current take one shot")
        }
        scenario("stale_defaults_notification_does_not_reflect_or_rebaseline") { f in
            f.attach(0); f.remount(newFirst: true)
            let epoch = f.delivery.exposureEpoch
            f.defaults.set(false, forKey: ConclaveFeedback.preferenceKey)
            f.refresh(0)
            check(f.delivery.preferenceEnabled, "stale notification leaves preference reflection unchanged")
            check(f.delivery.exposureEpoch == epoch, "stale notification leaves cursor epoch unchanged")
            f.refresh(1)
            check(!f.delivery.preferenceEnabled, "current notification reflects actual defaults")
            f.complete(); ledger(f, [1, 1, 0], "disabled outcome suppressed")
            f.defaults.set(true, forKey: ConclaveFeedback.preferenceKey); f.refresh(1); f.observe()
            ledger(f, [1, 1, 0], "preference restoration does not replay")
            f.complete(); ledger(f, [2, 2, 1], "fresh after preference restoration")
        }
        for boundary in ["remount", "reappearance", "activity", "suspension", "preference", "session"] {
            scenario("pending_invalidation_\(boundary)") { f in
                f.attach(0); f.owner.completeNextFixtureAction()
                guard let old = f.delivery.prepareObservation(mount: 0) else { check(false, "real pending ticket exists"); return }
                switch boundary {
                case "remount": f.remount(newFirst: true)
                case "reappearance": f.detach(0); f.attach(0)
                case "activity": f.active(false, 0); f.active(true, 0)
                case "suspension": f.delivery.setSuspended(true); f.delivery.setSuspended(false)
                case "preference": f.delivery.setPreference(false); f.delivery.setPreference(true)
                case "session": f.owner.resetFixtureSession(); f.observe()
                default: fatalError("unlisted boundary")
                }
                check(f.delivery.consume(old, mount: f.mount) == nil, "old ticket invalidated")
                f.owner.completeNextFixtureAction()
                guard let fresh = f.delivery.prepareObservation(mount: f.mount) else { check(false, "fresh ticket exists after invalidation"); return }
                check(f.delivery.consume(old, mount: f.mount) == nil, "old ticket cannot steal fresh ticket")
                check(f.delivery.consume(fresh, mount: f.mount) != nil, "fresh current ticket still delivered")
                check(f.delivery.consume(fresh, mount: f.mount) == nil, "fresh current ticket one shot")
            }
        }
        scenario("inactive_attach_and_coalesced_activity_restoration") { f in
            f.attach(0, active: false); f.complete(); f.delivery.gesture()
            ledger(f, [1, 1, 0], "inactive attach never forces eligibility")
            f.active(true, 0); f.observe(); ledger(f, [1, 1, 0], "active restoration quiet")
            f.complete(); ledger(f, [2, 2, 1], "active fresh")
            f.active(false, 0); f.owner.completeNextFixtureAction(); f.active(true, 0); f.observe()
            ledger(f, [3, 3, 1], "coalesced lifecycle event not replayed")
            f.complete(); ledger(f, [4, 4, 2], "fresh after coalesced lifecycle")
        }
        scenario("live_preference_recheck_at_consume") { f in
            f.attach(0); f.owner.completeNextFixtureAction()
            guard let ticket = f.delivery.prepareObservation(mount: 0) else { check(false, "ticket exists"); return }
            f.defaults.set(false, forKey: ConclaveFeedback.preferenceKey) // No notification/refresh yet.
            check(f.delivery.consume(ticket, mount: 0) == nil, "consume reads actual disabled preference")
            f.defaults.set(true, forKey: ConclaveFeedback.preferenceKey)
            check(f.delivery.consume(ticket, mount: 0) == nil, "re-enabling cannot revive consumed rejection")
            f.refresh(0); f.complete(); ledger(f, [2, 2, 1], "later fresh delivers")
        }
        scenario("coalesced_preference_pause_event_resume") { f in
            f.attach(0); f.complete(); ledger(f, [1, 1, 1], "enabled first")
            f.delivery.setPreference(false)
            f.owner.completeNextFixtureAction()
            f.delivery.gesture()
            f.delivery.setPreference(true)
            f.observe(); ledger(f, [2, 2, 1], "preference off event on without observation stays quiet")
            f.complete(); ledger(f, [3, 3, 2], "fresh after preference restoration once")
            f.owner.repeatLastFixtureCompletion(); f.observe(); ledger(f, [3, 3, 2], "restored duplicate quiet")
        }
        scenario("R1_and_stale_session_ticket_collision") { f in
            f.attach(0); f.complete(); ledger(f, [1, 1, 1], "R1 first")
            f.owner.resetFixtureSession(); f.observe()
            f.owner.repeatLastFixtureCompletion(); f.observe(); ledger(f, [0, 0, 1], "R1 repeat before fresh quiet")
            f.complete(); ledger(f, [1, 1, 2], "R1 new session fresh once")
            f.owner.repeatLastFixtureCompletion(); f.observe(); ledger(f, [1, 1, 2], "R1 duplicate quiet")
            f.owner.completeNextFixtureAction()
            guard let old = f.delivery.prepareObservation(mount: 0) else { check(false, "old session ticket exists"); return }
            f.owner.resetFixtureSession() // Final consume rejects session even before refresh.
            check(f.delivery.consume(old, mount: 0) == nil, "live session checked at consume")
            check(!f.owner.completeFixtureAction(actionID: 99, expectedSession: 2, kind: .joined), "old callback rejected")
            f.observe()
            check(f.owner.completeFixtureAction(actionID: 99, expectedSession: 3, kind: .joined), "same action ID allowed in new session")
            f.observe(); ledger(f, [1, 1, 3], "colliding sequence isolated")
        }
        scenario("nonzero_attach_silent_mapping_and_latest_token_coalescing") { f in
            f.owner.completeNextFixtureAction(); f.attach(0); f.observe()
            ledger(f, [1, 1, 0], "nonzero attach baselines")
            f.complete(.connectionRestored); f.observe(); ledger(f, [2, 2, 0], "silent mapping advances without replay")
            f.owner.completeNextFixtureAction(); f.owner.completeNextFixtureAction(kind: .actionRejected); f.observe()
            ledger(f, [4, 4, 1], "latest token coalescing allowed")
            check(f.delivery.lastKind == "actionRejected", "latest kind delivered")
            f.delivery.gesture(); ledger(f, [4, 4, 2], "gesture does not publish outcome")
        }
    }
    #endif
}
