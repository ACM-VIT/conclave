package conclave.module

import org.robolectric.pluginapi.TestEnvironmentLifecyclePlugin
import skip.foundation.AssetURLProtocol

class SandboxAssetUrlHandler : TestEnvironmentLifecyclePlugin {
    override fun onSetupApplicationState() {
        try {
            AssetURLProtocol.register()
        } catch (error: Error) {
            if (error.message != FACTORY_ALREADY_DEFINED) throw error
        }
    }

    companion object {
        const val FACTORY_ALREADY_DEFINED = "factory already defined"
    }
}
