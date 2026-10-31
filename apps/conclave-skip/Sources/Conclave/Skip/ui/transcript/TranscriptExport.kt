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

internal object TranscriptExport {

    fun authority(context: Context): String = context.packageName + ".fileprovider"

    fun directory(context: Context): File = File(context.cacheDir, "exports").apply { mkdirs() }

    fun clock(context: Context, millis: Double): String =
        android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date(millis.toLong()))

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

    fun build(context: Context, presenter: TranscriptPresenter): TranscriptExportFile =
        presenter.exportFile(labels = labels(context, presenter.inputs.roomId), timeLabel = { millis -> clock(context, millis) })

    suspend fun write(context: Context, file: TranscriptExportFile): File? = withContext(Dispatchers.IO) {
        runCatching {
            val target = File(directory(context), file.fileName)
            target.writeText(file.content, Charsets.UTF_8)
            target
        }.getOrNull()
    }

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

    fun copy(context: Context, label: String, text: String): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return false
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
    }
}
