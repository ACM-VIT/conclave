package conclave.module

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import skip.foundation.ProcessInfo

/// Bridges the shared SwiftUI meeting UI to the Android system clipboard. iOS
/// copies via `UIPasteboard`; SkipUI has no SwiftUI clipboard API, so the
/// `#if SKIP` branches call into this object directly (it lives in the same
/// transpiled `conclave.module` package). Uses the process / app Context — no
/// Activity or ComposeView is required for a clipboard write.
object ClipboardHelper {
    /// Copies `text` to the primary clip as plain text. `label` is the
    /// user-invisible ClipData label (shown only in some system UIs).
    fun copyToClipboard(text: String, label: String) {
        val ctx = ProcessInfo.processInfo.androidContext
        val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
    }
}
