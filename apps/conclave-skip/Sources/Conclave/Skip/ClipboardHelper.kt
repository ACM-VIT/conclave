package conclave.module

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import skip.foundation.ProcessInfo

object ClipboardHelper {

    fun copyToClipboard(text: String, label: String) {
        val ctx = ProcessInfo.processInfo.androidContext
        val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
    }
}
