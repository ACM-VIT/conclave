#if !SKIP
import Testing
@testable import Conclave

struct FixtureLifecycleTests {
    @Test func allIOSFixtureSelectorsAreRecognized() {
        for state in SystemFixtureState.allCases {
            #expect(NativeFixtureLaunch.iOSSelector(system: state.rawValue, stage: nil, people: nil, premeeting: nil))
        }
        for state in StageFixtureState.allCases {
            #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: state.rawValue, people: nil, premeeting: nil))
        }
        for state in ControlsFixtureState.allCases {
            #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: state.rawValue, people: nil, premeeting: nil))
        }
        for state in PeopleFixtureState.allCases {
            #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: nil, people: state.rawValue, premeeting: nil))
        }
        for state in PremeetingFixtureState.allCases {
            #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: nil, people: nil, premeeting: state.rawValue))
        }
    }

    @Test func invalidSelectorsKeepEachPlatformsExistingRootBehavior() {
        for raw in ["", "unknown-fixture", "  "] {
            #expect(!NativeFixtureLaunch.iOSSelector(system: raw, stage: raw, people: raw, premeeting: raw))
            #expect(NativeFixtureLaunch.androidSelector(system: raw, stage: nil, people: nil, premeeting: nil))
            #expect(NativeFixtureLaunch.androidSelector(system: nil, stage: raw, people: nil, premeeting: nil))
            #expect(NativeFixtureLaunch.androidSelector(system: nil, stage: nil, people: raw, premeeting: nil))
            #expect(!NativeFixtureLaunch.androidSelector(system: nil, stage: nil, people: nil, premeeting: raw))
        }
        #expect(!NativeFixtureLaunch.iOSSelector(system: nil, stage: nil, people: nil, premeeting: nil))
        #expect(!NativeFixtureLaunch.androidSelector(system: nil, stage: nil, people: nil, premeeting: nil))
    }

    @Test func iosPeopleRootsAndLifecycleUseTheSameSelection() {
        for raw in PeopleFixtureState.allCases.map({ $0.rawValue }) + PeopleWebinarFixtureState.allCases.map({ $0.rawValue }) + ["unknown", ""] {
            let displayed = NativeFixtureLaunch.iOSPeopleState(raw) != nil
            let selected = NativeFixtureLaunch.iOSSelector(system: nil, stage: nil, people: raw, premeeting: nil)
            #expect(selected == displayed)
            if NativeFixtureLaunch.iOSPeopleQaState(raw) != nil {
                #expect(displayed && NativeFixtureLaunch.iOSPeopleState(raw) == .guest4)
            }
        }
    }

    @Test func qaFixtureSuppressesResumeAcrossBackgroundAndForeground() {
        let selected = NativeFixtureLaunch.iOSSelector(system: nil, stage: nil, people: " qa-attendee-5 ", premeeting: nil)
        #expect(selected)
        let flags = NativeRouteFlags()
        flags.configureFixturePresentation(selectorPresented: selected, hostingPreviewPresented: false, debugEligible: true)
        var gate = ConclaveAppLifecycleGate()
        for phase in [ConclaveAppLifecyclePhase.active, .inactive, .background, .active] {
            let delivered = gate.record(phase, fixturePresented: flags.suppressesProductionLifecycle)
            #expect(!delivered)
        }
        let resumed = gate.resumeAfterFixture(fixturePresented: flags.suppressesProductionLifecycle)
        #expect(!resumed)
        flags.configureFixturePresentation(selectorPresented: selected, hostingPreviewPresented: false, debugEligible: false)
        #expect(!flags.suppressesProductionLifecycle)
    }

    @Test func routeFlagsAloneAndReleaseEligibilityNeverSuppressProduction() {
        let flags = NativeRouteFlags()
        flags.configure(routes: "premeeting,call", premeetingFixture: nil, debugEligible: true)
        #expect(flags.enabledKeys == [.premeeting, .call])
        #expect(!flags.suppressesProductionLifecycle)
        flags.configureFixturePresentation(selectorPresented: true, hostingPreviewPresented: true, debugEligible: false)
        #expect(!flags.suppressesProductionLifecycle)
        #expect(flags.enabledKeys == [.premeeting, .call])
        flags.configureFixturePresentation(selectorPresented: true, hostingPreviewPresented: false, debugEligible: true)
        #expect(flags.suppressesProductionLifecycle)
        flags.configureFixturePresentation(selectorPresented: true, hostingPreviewPresented: true, debugEligible: false)
        #expect(!flags.suppressesProductionLifecycle)
    }

    @Test func androidCallAndPipBranchesWinOverEveryFixtureRequest() {
        for selector in [false, true] {
            for hosting in [false, true] {
                for inCall in [false, true] {
                    for legacyPip in [false, true] {
                        for debugEligible in [false, true] {
                            let actual = NativeFixtureLaunch.androidRootPresented(
                                selectorRequested: selector, hostingPreviewRequested: hosting,
                                isInCall: inCall, showsLegacyPipContent: legacyPip, debugEligible: debugEligible
                            )
                            if inCall || legacyPip || !debugEligible || (!selector && !hosting) {
                                #expect(!actual)
                            } else {
                                #expect(actual)
                            }
                        }
                    }
                }
            }
        }
    }

    @Test func hostingCloseResumesActiveProductionExactlyOnce() {
        let flags = NativeRouteFlags()
        var gate = ConclaveAppLifecycleGate()
        flags.configureFixturePresentation(selectorPresented: false, hostingPreviewPresented: true, debugEligible: true)
        for phase in [ConclaveAppLifecyclePhase.active, .inactive, .background, .active] {
            let delivered = gate.record(phase, fixturePresented: flags.suppressesProductionLifecycle)
            #expect(!delivered)
        }
        flags.dismissHostingPreview()
        let firstResume = gate.resumeAfterFixture(fixturePresented: flags.suppressesProductionLifecycle)
        let duplicateResume = gate.resumeAfterFixture(fixturePresented: flags.suppressesProductionLifecycle)
        let duplicateActive = gate.record(.active, fixturePresented: flags.suppressesProductionLifecycle)
        let inactive = gate.record(.inactive, fixturePresented: flags.suppressesProductionLifecycle)
        #expect(firstResume)
        #expect(!duplicateResume)
        #expect(!duplicateActive)
        #expect(inactive)
    }

    @Test func closingHostingDoesNotEndAnIndependentSelectorFixture() {
        let flags = NativeRouteFlags()
        var gate = ConclaveAppLifecycleGate()
        flags.configureFixturePresentation(selectorPresented: true, hostingPreviewPresented: true, debugEligible: true)
        let active = gate.record(.active, fixturePresented: flags.suppressesProductionLifecycle)
        #expect(!active)
        flags.dismissHostingPreview()
        #expect(flags.suppressesProductionLifecycle)
        let resume = gate.resumeAfterFixture(fixturePresented: flags.suppressesProductionLifecycle)
        #expect(!resume)
        flags.reset()
        #expect(!flags.suppressesProductionLifecycle)
    }

    @Test func closingWhileBackgroundedWaitsForTheNextActivePhase() {
        var gate = ConclaveAppLifecycleGate()
        let activeWhileInFixture = gate.record(.active, fixturePresented: true)
        let backgroundWhileInFixture = gate.record(.background, fixturePresented: true)
        let backgroundExit = gate.resumeAfterFixture(fixturePresented: false)
        #expect(!activeWhileInFixture)
        #expect(!backgroundWhileInFixture)
        #expect(!backgroundExit)
        #expect(gate.observedPhase == .background)
        let resumed = gate.record(.active, fixturePresented: false)
        let duplicate = gate.record(.active, fixturePresented: false)
        #expect(resumed)
        #expect(!duplicate)
    }

    @Test func ordinaryLifecyclePreservesPhaseDeduplication() {
        var gate = ConclaveAppLifecycleGate()
        let launching = gate.record(.launching, fixturePresented: false)
        #expect(!launching)
        for phase in [ConclaveAppLifecyclePhase.active, .inactive, .active, .inactive, .background, .active] {
            let changed = gate.record(phase, fixturePresented: false)
            let duplicate = gate.record(phase, fixturePresented: false)
            #expect(changed)
            #expect(!duplicate)
        }
        let redundantResume = gate.resumeAfterFixture(fixturePresented: false)
        #expect(!redundantResume)
    }
}
#endif
