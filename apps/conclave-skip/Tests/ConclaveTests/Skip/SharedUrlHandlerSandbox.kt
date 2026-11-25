package conclave.module

import android.os.Build
import org.junit.rules.ExternalResource
import skip.foundation.AssetURLProtocol

class SharedUrlHandlerSandbox : ExternalResource() {
    override fun before() {
        if (Build.VERSION.SDK_INT == OWNER_SDK) return
        AssetURLProtocol::class.java.getDeclaredField("registered").apply { isAccessible = true }.setBoolean(null, true)
    }

    companion object {
        const val OWNER_SDK = 28
    }
}
