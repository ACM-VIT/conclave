package conclave.module

import java.net.MalformedURLException
import java.net.URI
import org.robolectric.pluginapi.TestEnvironmentLifecyclePlugin
import skip.foundation.AssetURLProtocol

class SandboxAssetUrlHandler : TestEnvironmentLifecyclePlugin {
    override fun onSetupApplicationState() {
        try {
            AssetURLProtocol.register()
        } catch (error: Error) {
            if (error.message != FACTORY_ALREADY_DEFINED) throw error
        }
        if (!checkedThisSandbox) {
            checkAssetUrlsReachSkip()
            checkedThisSandbox = true
        }
        ranInThisSandbox = true
    }

    private fun checkAssetUrlsReachSkip() {
        val connection = try {
            URI.create("asset:/${AssetURLProtocol.scheme}-handler-check").toURL().openConnection()
        } catch (error: MalformedURLException) {
            throw IllegalStateException("No JVM handler serves asset: URLs after registering Skip's", error)
        }
        check(connection.javaClass.name == SKIP_ASSET_CONNECTION) {
            "asset: URLs open ${connection.javaClass.name}, not Skip's $SKIP_ASSET_CONNECTION; another URL stream handler factory took the JVM"
        }
    }

    companion object {
        const val FACTORY_ALREADY_DEFINED = "factory already defined"
        const val SKIP_ASSET_CONNECTION = "skip.foundation.AssetURLProtocol\$AssetStreamHandler\$AssetURLConnection"
        @Volatile var ranInThisSandbox = false
        @Volatile private var checkedThisSandbox = false
    }
}
