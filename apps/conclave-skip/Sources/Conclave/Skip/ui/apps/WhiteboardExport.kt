package conclave.module

import android.content.Context
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

internal object WhiteboardExport {
    suspend fun share(context: Context, pngBase64: String, handoff: (File) -> Boolean) {
        var prepared: File? = null
        var handedOff = false
        try {
            withContext(Dispatchers.IO) {
                val bytes = android.util.Base64.decode(pngBase64, android.util.Base64.DEFAULT)
                prepared = NativeExportFiles.write(context, "whiteboard", "whiteboard.png", bytes)
            }
            currentCoroutineContext().ensureActive()
            val file = prepared ?: return
            handedOff = handoff(file)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
        } finally {
            if (!handedOff) prepared?.let { NativeExportFiles.discard(it) }
        }
    }
}
