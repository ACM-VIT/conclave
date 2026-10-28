package conclave.module

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp

private val NoticePreviewMaxWidth = 560.dp

internal fun noticeLevelNameOf(context: Context, level: String): String = when (level) {
    HostNoticeLevel.warning -> conclaveStringOf(context, "hst_level_warning")
    HostNoticeLevel.error -> conclaveStringOf(context, "hst_level_urgent")
    else -> conclaveStringOf(context, "hst_level_info")
}

internal fun noticeBannerKind(level: String): ConclaveBannerKind = when (level) {
    HostNoticeLevel.warning -> ConclaveBannerKind.Warning
    HostNoticeLevel.error -> ConclaveBannerKind.Error
    else -> ConclaveBannerKind.Info
}

internal fun noticePreviewTextOf(context: Context, sender: String, message: String): String {
    val trimmed = message.trim()
    val shown = if (trimmed.isEmpty()) conclaveStringOf(context, "hst_message_label") else trimmed
    if (sender.isEmpty()) return shown
    return conclaveStringOf(context, "stg_banner_notice_from", sender) + " " + shown
}

@Composable
internal fun NoticeComposerPage(people: PeoplePresenter, reservation: PaddingValues, snackbar: SnackbarHostState) {
    val host = people.host
    val snapshot = host.snapshot
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val sending = snapshot.noticePhase == HostFieldPhase.sending
    val blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
    var draft by rememberSaveable { mutableStateOf(host.drafts.noticeText) }
    var level by rememberSaveable { mutableStateOf(HostControlsPolicy.normalizedLevel(host.drafts.noticeLevel)) }
    var seenSentSerial by rememberSaveable { mutableIntStateOf(snapshot.noticeSentSerial) }
    val count = draft.length
    val tooLong = HostControlsPolicy.isNoticeTooLong(count)
    val canSend = HostControlsPolicy.canSendNotice(draft, isPending = sending, isBlocked = blocked)
    LaunchedEffect(snapshot.noticeSentSerial) {
        if (snapshot.noticeSentSerial == seenSentSerial) return@LaunchedEffect
        seenSentSerial = snapshot.noticeSentSerial

        draft = host.drafts.noticeText
        snackbar.showSnackbar(conclaveStringOf(context, "hst_notice_sent"))
    }
    val sender = people.localName()
    val previewText = noticePreviewTextOf(context, sender, draft)
    val previewLabel = conclaveString("hst_preview_label", noticeLevelNameOf(context, level), previewText)
    val reason = hostReasonOf(context, snapshot.blockedReason)
    val levels = listOf(
        ConclaveSegmentModel(id = HostNoticeLevel.info, title = conclaveString("hst_level_info"), isEnabled = !sending),
        ConclaveSegmentModel(id = HostNoticeLevel.warning, title = conclaveString("hst_level_warning"), isEnabled = !sending),
        ConclaveSegmentModel(id = HostNoticeLevel.error, title = conclaveString("hst_level_urgent"), isEnabled = !sending),
    )
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(reservation).padding(16.dp)
            .testTag("host.page.notice"),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = {
                draft = it
                host.drafts.noticeText = it
            },
            modifier = Modifier.fillMaxWidth().testTag("host.notice.field"),
            enabled = !sending,
            label = { ConclaveText(conclaveString("hst_message_label"), line = "host.notice.field.label") },
            supportingText = if (HostControlsPolicy.showsNoticeCounter(count)) {
                {
                    ConclaveCharacterCounter(count = count, limit = HostControlsPolicy.noticeLimit,
                        visibleFrom = HostControlsPolicy.noticeCounterFrom, identifier = "host.notice.counter")
                }
            } else {
                null
            },
            isError = tooLong,
            minLines = 3,
            maxLines = 8,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        )
        ConclaveSegmentedRow(
            options = levels,
            selectedId = level,
            identifier = "host.notice.level",
            onSelect = {
                level = it
                host.drafts.noticeLevel = it
            },
        )
        ConclaveText(conclaveString("hst_preview"), line = "host.notice.preview.title",
            style = MaterialTheme.typography.titleSmall, color = scheme.onSurfaceVariant)
        HostingTheme(inCall = true) {
            ConclaveBanner(
                kind = noticeBannerKind(level),
                text = previewText,
                identifier = "host.notice.preview",
                inCall = true,
                modifier = Modifier.widthIn(max = NoticePreviewMaxWidth).clearAndSetSemantics { contentDescription = previewLabel },
            )
        }
        if (reason != null) {
            ConclaveText(reason, line = "host.notice.reason", style = MaterialTheme.typography.bodySmall,
                color = scheme.onSurfaceVariant)
        }
        Button(
            onClick = { host.sendNotice(draft, level = level) },
            enabled = canSend,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("host.notice.send"),
        ) {
            if (sending) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = scheme.onPrimaryContainer)
                ConclaveText(conclaveString("hst_sending"), line = "host.notice.sending", modifier = Modifier.padding(start = 8.dp))
            } else {
                ConclaveText(conclaveString("hst_send_notice_button"), line = "host.notice.send")
            }
        }
    }
}
