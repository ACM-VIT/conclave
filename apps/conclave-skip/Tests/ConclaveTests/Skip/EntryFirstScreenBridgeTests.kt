package conclave.module

import java.io.File
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

    @Test
    fun mainSelectsTheNativePremeetingHostWhenDebugIsNotEligible() {
        val main = source("Android/app/src/main/kotlin/Main.kt")
        assertTrue(main.contains("debugEligible = BuildConfig.DEBUG && routesDebuggable,"))
        assertTrue(main.contains("routes = intent?.getStringExtra(NativeRouteLaunch.ROUTES_EXTRA),"))
        assertTrue(main.contains("premeetingFixture = intent?.getStringExtra(NativeRouteLaunch.PREMEETING_FIXTURE_EXTRA),"))
        assertTrue(main.contains("val premeetingFixture = NativeRouteLaunch.premeetingFixture"))
        assertTrue(main.contains("val nativePremeeting = NativeRouteLaunch.usesNativePremeeting"))
        for (extra in listOf("conclave.systemFixture", "conclave.stageFixture", "conclave.peopleFixture")) {
            assertTrue(extra, main.contains("if (BuildConfig.DEBUG && routesDebuggable) intent?.getStringExtra(\"$extra\") else null"))
        }
        assertTrue(main.contains("hostingPreviewRequested = BuildConfig.DEBUG && intent?.getBooleanExtra(\"conclave.hostingPreview\", false) == true"))

        val nativeBranch = main.indexOf("} else if (nativePremeeting) {")
        val host = main.indexOf("NativePremeetingHost(callContent = legacyRoot)")
        val premeetingFixtureBranch = main.indexOf("} else if (premeetingFixture.isNotEmpty()")
        val hostingBranch = main.indexOf("} else if (showsHostingPreview")
        assertTrue(nativeBranch > 0)
        assertTrue(host > nativeBranch)
        assertTrue(premeetingFixtureBranch in 1 until nativeBranch)
        assertTrue(hostingBranch in 1 until nativeBranch)
        assertFalse(main.contains("showsLegacy" + "PipContent"))
        assertFalse(Regex("(?<![A-Za-z])PipContent\\(\\)").containsMatchIn(main))

        val premeetingHost = source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt")
        assertTrue(premeetingHost.contains("get() = premeetingFixture.isEmpty() && NativeRouteFlags.shared.isEnabled(NativeRouteKey.premeeting)"))
        assertTrue(premeetingHost.contains("return if (PremeetingFixtureScript.state(named = name) != null) name else \"\""))

        val flags = source("Sources/Conclave/App/NativeRouteFlags.swift")
        assertTrue(flags.contains("guard debugEligible else {\n            reset()\n            return\n        }"))
        assertTrue(flags.contains("#if os(iOS) || SKIP\n        return true"))
    }

    private fun source(relative: String): String = File(packageRoot(), relative).readText()

    private fun packageRoot(): File {
        for (directory in generateSequence(File(System.getProperty("user.dir")).canonicalFile) { it.parentFile }) {
            for (candidate in listOf(directory, File(directory, "apps/conclave-skip"))) {
                if (File(candidate, "Android/app/src/main/AndroidManifest.xml").isFile) return candidate
            }
        }
        error("Cannot locate Conclave package from test working directory")
    }
}
