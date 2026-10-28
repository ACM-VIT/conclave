package conclave.module

import android.content.ContextWrapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class BrandResourceBridgeTests {
    @Test fun resolutionIsByNameAndByType() {

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

        for (name in listOf("IC_DELETE", "ic.delete", "ic-delete", "", "1white", "android:drawable/ic_delete")) {
            assertEquals(name, 0, conclaveResourceId(resources, name, "drawable", "android"))
        }
    }

    @Test fun bridgesResolveAgainstTheContextPackageByType() {

        val framework = object : ContextWrapper(RuntimeEnvironment.getApplication()) {
            override fun getPackageName(): String = "android"
        }
        assertEquals(android.R.drawable.ic_delete, conclaveDrawableId(framework, "ic_delete"))
        assertEquals(android.R.color.white, conclaveColorId(framework, "white"))
        assertEquals(0, conclaveColorId(framework, "ic_delete"))
        assertEquals(0, conclaveDrawableId(framework, "white"))
        assertEquals(0, conclaveDrawableId(framework, "Ic_delete"))

        assertEquals(0, conclaveDrawableId(RuntimeEnvironment.getApplication(), "ic_delete"))
    }
}
