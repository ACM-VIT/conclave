package conclave.module

import android.content.ContextWrapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** S70 SX8: library-module bridges resolve app-module drawables and colors by legal name and by type. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class BrandResourceBridgeTests {
    @Test fun resolutionIsByNameAndByType() {
        // The framework package stands in for the app module, whose resources the library test cannot see.
        val resources = RuntimeEnvironment.getApplication().resources
        val drawable = conclaveResourceId(resources, "ic_delete", "drawable", "android")
        assertNotEquals(0, drawable)
        assertEquals(android.R.drawable.ic_delete, drawable)
        assertEquals(0, conclaveResourceId(resources, "ic_delete", "color", "android"))
        val color = conclaveResourceId(resources, "white", "color", "android")
        assertEquals(android.R.color.white, color)
        assertEquals(0, conclaveResourceId(resources, "white", "drawable", "android"))
    }

    @Test fun illegalNamesNeverReachTheLookup() {
        val resources = RuntimeEnvironment.getApplication().resources
        // Uppercase, dots and dashes are not legal resource names (AAPT2 rejects a file named MicFill1).
        for (name in listOf("IC_DELETE", "ic.delete", "ic-delete", "", "1white", "android:drawable/ic_delete")) {
            assertEquals(name, 0, conclaveResourceId(resources, name, "drawable", "android"))
        }
    }

    @Test fun bridgesResolveAgainstTheContextPackageByType() {
        // A context whose package is the framework stands in for the app module (the library test cannot see app
        // resources; their existence is checked by BrandAssetContractsTests and the APK resource audit). The
        // bridges must look up the context's own package, and drawables and colors only by their own type.
        val framework = object : ContextWrapper(RuntimeEnvironment.getApplication()) {
            override fun getPackageName(): String = "android"
        }
        assertEquals(android.R.drawable.ic_delete, conclaveDrawableId(framework, "ic_delete"))
        assertEquals(android.R.color.white, conclaveColorId(framework, "white"))
        assertEquals(0, conclaveColorId(framework, "ic_delete"))
        assertEquals(0, conclaveDrawableId(framework, "white"))
        assertEquals(0, conclaveDrawableId(framework, "Ic_delete"))
        // The application's own package has no such framework names, so a lookup there finds nothing.
        assertEquals(0, conclaveDrawableId(RuntimeEnvironment.getApplication(), "ic_delete"))
    }
}
