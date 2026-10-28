package conclave.module

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.FileProvider
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import skip.ui.UIApplication

/*
 * S60 6 d, C6-26 (TRN-2): Export and Copy on Android. Export writes the presenter's finals-only Markdown (localized
 * headings, the locale's clock) to `cache/exports/` (the FileProvider `exports` path, res/xml/conclave_file_paths.xml)
 * off the main thread and shares a `content://` URI through the chooser with EXTRA_STREAM and
 * FLAG_GRANT_READ_URI_PERMISSION (a `file://` URI would throw FileUriExposedException), suppressing the PiP auto-enter
 * around it (the NativeMeetingShare pattern, S70 8 d). Copy writes the clipboard; only API 28 to 32 show the app
 * snackbar (API 33 and later show the system clipboard confirmation, F00 8).
 */
internal object TranscriptExport {
    /** The FileProvider authority declared in AndroidManifest.xml (CHT-4 landed it; shared with chat and SYS-15). */
    fun authority(context: Context): String = context.packageName + ".fileprovider"

    /** The cache subdirectory exposed as the FileProvider `exports` path. */
    fun directory(context: Context): File = File(context.cacheDir, "exports").apply { mkdirs() }

    /** The locale's short clock (12 or 24 hours per the system setting), never a fixed format (S60 6 m). */
    fun clock(context: Context, millis: Double): String =
        android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date(millis.toLong()))

    /** Localized headings for the export and the copy (S60 6 j). */
    fun labels(context: Context, roomId: String): TranscriptExportLabels = TranscriptExportLabels(
        title = conclaveStringOf(context, "trn_export_title", roomId),
        summary = conclaveStringOf(context, "trn_section_summary"),
        topics = conclaveStringOf(context, "trn_section_topics"),
        decisions = conclaveStringOf(context, "trn_section_decisions"),
        actionItems = conclaveStringOf(context, "trn_section_action_items"),
        openQuestions = conclaveStringOf(context, "trn_section_open_questions"),
        followUps = conclaveStringOf(context, "trn_section_follow_ups"),
        transcript = conclaveStringOf(context, "trn_export_transcript"),
        speaker = conclaveStringOf(context, "trn_speaker"),
    )

    /** The document text (built on the main thread from the presenter, finals only). */
    fun build(context: Context, presenter: TranscriptPresenter): TranscriptExportFile =
        presenter.exportFile(labels = labels(context, presenter.inputs.roomId), timeLabel = { millis -> clock(context, millis) })

    /** Writes the file off the main thread; null when the cache cannot be written. */
    suspend fun write(context: Context, file: TranscriptExportFile): File? = withContext(Dispatchers.IO) {
        runCatching {
            val target = File(directory(context), file.fileName)
            target.writeText(file.content, Charsets.UTF_8)
            target
        }.getOrNull()
    }

    /** The chooser with the FileProvider URI (6 l 3). Returns false when nothing could open it. */
    fun share(context: Context, file: File, subject: String): Boolean {
        return try {
            val uri = FileProvider.getUriForFile(context, authority(context), file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/markdown"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, subject)
                putExtra(Intent.EXTRA_TITLE, file.name)
                clipData = ClipData.newRawUri(subject, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, subject)
            val activity = UIApplication.shared.androidActivity
            if (activity != null) {
                PipManager.suppressNextAutoEnter("transcript_export")
                activity.startActivity(chooser)
            } else {
                context.startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            true
        } catch (failure: Throwable) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            false
        }
    }

    /** Writes the clipboard. Returns true when the app should show its own "Transcript copied" (API 28 to 32). */
    fun copy(context: Context, label: String, text: String): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return false
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
    }
}
