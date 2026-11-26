package conclave.module

import java.io.File
import java.net.URI
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28, 33])
class SandboxAssetUrlHandlerTests {
    @Test
    fun thePluginRanInThisSandbox() {
        assertTrue(
            "SandboxAssetUrlHandler did not run in this sandbox: its META-INF/services descriptor is not on the test resources path",
            SandboxAssetUrlHandler.ranInThisSandbox,
        )
    }

    @Test
    fun aDiagnosticsStoreWriteWorksInEverySandboxWhicheverLoadedSkipFirst() {
        val base = Files.createTempDirectory("sandbox-url-handler").toFile()
        val store = DiagnosticsFileStore(directoryPath = File(base, "store").path, exportDirectoryPath = File(base, "exports").path)
        val payload = DiagnosticsPayloadFactory.payload(
            kind = DiagnosticsPayloadKind.exitReason,
            createdAtMillis = System.currentTimeMillis().toDouble(),
            fields = skip.lib.Array(listOf(DiagnosticsPayloadFactory.number("status", 0.0))),
            detailJSON = NativePerformanceDiagnostics.traceJSON("main prio=5 tid=1 Native\n  at a.b.C.d(C.kt:1)"),
        )
        assertTrue("a sandbox that loaded Skip after another sandbox could not write its diagnostics", store.writePayload(payload))
    }

    @Test
    fun anAssetUrlReadsTheSameBytesAsTheAssetManagerInEverySandbox() {
        val path = "conclave/module/Resources/TablerChess-LICENSE.txt"
        val expected = RuntimeEnvironment.getApplication().assets.open(path).use { it.readBytes() }
        val read = URI.create("asset:/$path").toURL().openStream().use { it.readBytes() }
        assertArrayEquals("asset: URLs do not read this sandbox's assets", expected, read)
    }
}
