package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Actual transpiled launch policy and lifecycle gate; no view model, media or device operations. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class FixtureLifecycleBridgeTests {
    @Test fun rawAndroidSelectorsRetainFallbackButInvalidPremeetingDoesNot() {
        for (raw in listOf("", "unknown-fixture", "  ")) {
            assertTrue(NativeFixtureLaunch.androidSelector(system = raw, stage = null, people = null, premeeting = null))
            assertTrue(NativeFixtureLaunch.androidSelector(system = null, stage = raw, people = null, premeeting = null))
            assertTrue(NativeFixtureLaunch.androidSelector(system = null, stage = null, people = raw, premeeting = null))
            assertFalse(NativeFixtureLaunch.androidSelector(system = null, stage = null, people = null, premeeting = raw))
        }
        assertFalse(NativeFixtureLaunch.androidSelector(system = null, stage = null, people = null, premeeting = null))
        assertTrue(NativeFixtureLaunch.androidSelector(system = null, stage = null, people = null, premeeting = "home"))
    }

    @Test fun productionCallAndPipBranchesAndReleaseAlwaysWin() {
        for (selector in listOf(false, true)) for (hosting in listOf(false, true)) {
            for (inCall in listOf(false, true)) for (legacyPip in listOf(false, true)) {
                for (debugEligible in listOf(false, true)) {
                    val actual = NativeFixtureLaunch.androidRootPresented(
                        selectorRequested = selector, hostingPreviewRequested = hosting,
                        isInCall = inCall, showsLegacyPipContent = legacyPip, debugEligible = debugEligible,
                    )
                    if (inCall || legacyPip || !debugEligible || (!selector && !hosting)) assertFalse(actual)
                    else assertTrue(actual)
                }
            }
        }
    }

    @Test fun nativeRouteFlagsAndReleaseEligibilityDoNotSuppressProduction() {
        val flags = NativeRouteFlags()
        flags.configure(routes = "premeeting,call", premeetingFixture = null, debugEligible = true)
        assertTrue(flags.isEnabled(NativeRouteKey.premeeting))
        assertFalse(flags.suppressesProductionLifecycle)
        flags.configureFixturePresentation(selectorPresented = true, hostingPreviewPresented = true, debugEligible = false)
        assertFalse(flags.suppressesProductionLifecycle)
        flags.configureFixturePresentation(selectorPresented = true, hostingPreviewPresented = true, debugEligible = true)
        assertTrue(flags.suppressesProductionLifecycle)
        flags.configureFixturePresentation(selectorPresented = true, hostingPreviewPresented = true, debugEligible = false)
        assertFalse(flags.suppressesProductionLifecycle)
        assertTrue(flags.isEnabled(NativeRouteKey.call))
    }

    @Test fun fixtureLifecycleIsSilentAndHostingCloseActivatesOnce() {
        val flags = NativeRouteFlags()
        val gate = ConclaveAppLifecycleGate()
        flags.configureFixturePresentation(selectorPresented = false, hostingPreviewPresented = true, debugEligible = true)
        for (phase in listOf(ConclaveAppLifecyclePhase.active, ConclaveAppLifecyclePhase.inactive,
            ConclaveAppLifecyclePhase.background, ConclaveAppLifecyclePhase.active)) {
            assertFalse(gate.record(phase, fixturePresented = flags.suppressesProductionLifecycle))
        }
        flags.dismissHostingPreview()
        assertTrue(gate.resumeAfterFixture(fixturePresented = flags.suppressesProductionLifecycle))
        assertFalse(gate.resumeAfterFixture(fixturePresented = flags.suppressesProductionLifecycle))
        assertFalse(gate.record(ConclaveAppLifecyclePhase.active, fixturePresented = false))
        assertTrue(gate.record(ConclaveAppLifecyclePhase.inactive, fixturePresented = false))
    }

    @Test fun independentSelectorSurvivesHostingClose() {
        val flags = NativeRouteFlags()
        val gate = ConclaveAppLifecycleGate()
        flags.configureFixturePresentation(selectorPresented = true, hostingPreviewPresented = true, debugEligible = true)
        assertFalse(gate.record(ConclaveAppLifecyclePhase.active, fixturePresented = flags.suppressesProductionLifecycle))
        flags.dismissHostingPreview()
        assertTrue(flags.suppressesProductionLifecycle)
        assertFalse(gate.resumeAfterFixture(fixturePresented = flags.suppressesProductionLifecycle))
        flags.reset()
        assertFalse(flags.suppressesProductionLifecycle)
    }

    @Test fun backgroundCloseWaitsAndNormalPhasesStillDeduplicate() {
        val gate = ConclaveAppLifecycleGate()
        assertFalse(gate.record(ConclaveAppLifecyclePhase.active, fixturePresented = true))
        assertFalse(gate.record(ConclaveAppLifecyclePhase.background, fixturePresented = true))
        assertFalse(gate.resumeAfterFixture(fixturePresented = false))
        assertEquals(ConclaveAppLifecyclePhase.background, gate.observedPhase)
        for (phase in listOf(ConclaveAppLifecyclePhase.active, ConclaveAppLifecyclePhase.inactive,
            ConclaveAppLifecyclePhase.active, ConclaveAppLifecyclePhase.inactive,
            ConclaveAppLifecyclePhase.background, ConclaveAppLifecyclePhase.active)) {
            assertTrue(gate.record(phase, fixturePresented = false))
            assertFalse(gate.record(phase, fixturePresented = false))
        }
        assertFalse(gate.resumeAfterFixture(fixturePresented = false))
    }
}
