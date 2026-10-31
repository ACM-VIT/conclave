package conclave.module

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class EntryFirstScreenBridgeTests {
    @After
    fun restoreProductionRoutes() {
        NativeRouteFlags.shared.reset()
    }

    @Test
    fun theSkipBranchOfTheDefaultGetterEnablesBothNativeRoots() {
        assertTrue(NativeRouteFlags.nativeUIAvailable)
        val flags = NativeRouteFlags()
        assertEquals(listOf(NativeRouteKey.premeeting, NativeRouteKey.call), flags.enabledKeys.toList())
        assertTrue(flags.isEnabled(NativeRouteKey.premeeting))
        assertTrue(flags.isEnabled(NativeRouteKey.call))
        assertTrue(flags.routesPremeetingNatively)
        assertEquals("", flags.premeetingFixture)
        assertFalse(flags.suppressesProductionLifecycle)
    }

    @Test
    fun aLaunchThatIsNotDebugEligibleIgnoresRouteAndFixtureExtras() {
        NativeRouteFlags.shared.configure(routes = "none", premeetingFixture = "inCall", debugEligible = true)
        assertEquals("inCall", NativeRouteLaunch.premeetingFixture)
        assertFalse(NativeRouteLaunch.usesNativePremeeting)

        NativeRouteFlags.shared.configure(routes = "none", premeetingFixture = "inCall", debugEligible = false)
        assertEquals(listOf(NativeRouteKey.premeeting, NativeRouteKey.call), NativeRouteFlags.shared.enabledKeys.toList())
        assertEquals("", NativeRouteLaunch.premeetingFixture)
        assertTrue(NativeRouteLaunch.usesNativePremeeting)
        assertTrue(NativeRouteFlags.shared.isEnabled(NativeRouteKey.call))
        assertFalse(NativeFixtureLaunch.androidSelector(system = null, stage = null, people = null, premeeting = NativeRouteLaunch.premeetingFixture))
    }
}
