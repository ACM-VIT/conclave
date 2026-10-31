package conclave.module

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import skip.foundation.UserDefaults

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class AppearancePreferenceBridgeTests {
    private fun freshDefaults(): UserDefaults {
        val prefs = RuntimeEnvironment.getApplication().getSharedPreferences("appearance-test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        return UserDefaults(platformValue = prefs)
    }

    @Test fun systemFollowsTheSystemAndOverridesRemainExplicit() {
        assertFalse(AppearanceMode.system.usesDarkAppearance(systemIsDark = false))
        assertTrue(AppearanceMode.system.usesDarkAppearance(systemIsDark = true))
        for (systemDark in listOf(false, true)) {
            assertFalse(AppearanceMode.light.usesDarkAppearance(systemIsDark = systemDark))
            assertTrue(AppearanceMode.dark.usesDarkAppearance(systemIsDark = systemDark))
        }
    }

    @Test fun preferencePersistsAndSystemClearsTheOverride() {
        val defaults = freshDefaults()
        val preference = AppearancePreference(defaults = defaults)
        assertEquals(AppearanceMode.system, preference.mode)
        preference.setMode(AppearanceMode.dark)
        assertEquals(AppearanceMode.dark, AppearancePreference(defaults = defaults).mode)
        preference.setMode(AppearanceMode.light)
        assertEquals(AppearanceMode.light, AppearancePreference(defaults = defaults).mode)
        preference.setMode(AppearanceMode.system)
        assertNull(defaults.object_(forKey = AppearancePreference.storageKey))
        assertEquals(AppearanceMode.system, AppearancePreference(defaults = defaults).mode)
    }

    @Test fun unknownValueFallsBackAndUnrelatedPreferenceSurvives() {
        val defaults = freshDefaults()
        defaults.set("future", forKey = AppearancePreference.storageKey)
        defaults.set("kept", forKey = "unrelated.preference")
        val preference = AppearancePreference(defaults = defaults)
        assertEquals(AppearanceMode.system, preference.mode)
        preference.setMode(AppearanceMode.system)
        assertNull(defaults.object_(forKey = AppearancePreference.storageKey))
        preference.setMode(AppearanceMode.dark)
        assertEquals("kept", defaults.string(forKey = "unrelated.preference"))
        assertEquals("dark", defaults.string(forKey = AppearancePreference.storageKey))
    }
}
