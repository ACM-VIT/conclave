package conclave.module

import androidx.compose.material3.Icon

import android.text.format.DateUtils
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CollectionInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collectionInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/*
 * S60 6 d, L6-4 (TRN-2): the Transcript, Ask and Minutes lists on Android. The Transcript list is the S40 ChatTimeline
 * pattern: a reversed LazyColumn (newest at index 0, at the bottom) over newest-first row ids keyed by row id with the
 * marker or group content type; "at bottom" is the first item at offset 48 dp or less; the follow effect lives in its
 * own small composable keyed on the newest row id plus its revision, so growth of the live row is followed while pinned
 * and a delta recomposes only that row and the effect, never the list. Ask uses S40 CL1 bubbles with the CHT-7
 * markdown renderer (long press "Copy answer"); Minutes uses headers and ListItems with Owner and Due lines.
 */

private const val TRANSCRIPT_BOTTOM_SLOP_DP = 48

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TranscriptFeedList(feed: TranscriptFeed, reservation: PaddingValues) {
    val raw = feed.rowIds
    val reversed = remember(raw) { raw.toList().asReversed().toList() }
    if (reversed.isEmpty()) {
        ConclaveEmptyStatus(title = conclaveString("trn_listening_title"), body = conclaveString("trn_listening_body"),
            icon = ConclaveIcons.ClosedCaptionFill0, identifier = "transcript.listening",
            modifier = Modifier.padding(top = reservation.calculateTopPadding()))
        return
    }
    val listState = rememberLazyListState()
    val atBottom by remember {
        derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= TRANSCRIPT_BOTTOM_SLOP_DP }
    }
    var wasAtBottom by remember { mutableStateOf(true) }
    var jumpRequests by remember { mutableStateOf(0) }
    LaunchedEffect(atBottom) { wasAtBottom = atBottom }
    TranscriptFollowEffect(feed, listState) { wasAtBottom }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            reverseLayout = true,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp + reservation.calculateTopPadding(),
                bottom = 12.dp + reservation.calculateBottomPadding()),
            modifier = Modifier.fillMaxSize().imeNestedScroll().testTag("transcript.list")
                .semantics { collectionInfo = CollectionInfo(reversed.size, 1) },
        ) {
            items(
                count = reversed.size,
                key = { reversed[it] },
                contentType = { if (reversed[it].startsWith(TranscriptFeed.markerPrefix)) "marker" else "group" },
            ) { index ->
                TranscriptRow(feed.row(reversed[index]))
            }
        }
        // 6 h: the S40 CL5 pill fades in 120 ms (opacity only).
        AnimatedVisibility(
            visible = !atBottom,
            enter = fadeIn(tween(120)),
            exit = fadeOut(tween(120)),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp + reservation.calculateBottomPadding()),
        ) {
            FilledTonalButton(
                onClick = { jumpRequests += 1 },
                contentPadding = PaddingValues(horizontal = 16.dp),
                modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.jumpPill"),
            ) {
                Icon(ConclaveIcons.ArrowDownwardFill0, contentDescription = null, modifier = Modifier.padding(end = 8.dp).size(18.dp))
                ConclaveText(conclaveString("chat_jump_latest"), line = "transcript.jumpPill.label")
            }
        }
    }
    LaunchedEffect(jumpRequests) {
        if (jumpRequests > 0) listState.scrollToItem(0)
    }
}

/** The follow rule (6 d): keyed on the newest row id plus its revision; reads them alone, so the list never recomposes. */
@Composable
private fun TranscriptFollowEffect(feed: TranscriptFeed, listState: LazyListState, wasAtBottom: () -> Boolean) {
    val newestId = feed.newestId
    val newestRevision = feed.newestRevision
    LaunchedEffect(newestId, newestRevision) {
        if (newestId.isNotEmpty() && wasAtBottom()) listState.scrollToItem(0)
    }
}

/** One row (L6-4): a speaker group as one element ("Avery, 10:41 AM, ..."; partial adds "Still speaking"), or a marker. */
@Composable
private fun TranscriptRow(row: TranscriptRowModel) {
    SideEffect { TranscriptDiagnostics.counters?.bump("transcript.row." + row.id + ".recompose") }
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val typography = MaterialTheme.typography
    if (row.isPauseMarker) {
        val label = conclaveString("trn_resumed_at", TranscriptExport.clock(context, row.startMillis))
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp).testTag("transcript.row.${row.id}"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HorizontalDivider(Modifier.weight(1f), color = scheme.outlineVariant)
            ConclaveText(label, line = "transcript.row.${row.id}.label", style = typography.labelSmall, color = scheme.onSurfaceVariant)
            HorizontalDivider(Modifier.weight(1f), color = scheme.outlineVariant)
        }
        return
    }
    val name = when {
        row.isYou -> conclaveString("trn_you")
        row.speakerName.isBlank() -> conclaveString("trn_speaker")
        else -> row.speakerName
    }
    val time = TranscriptExport.clock(context, row.startMillis)
    val stillSpeaking = conclaveString("trn_still_speaking")
    val description = "$name, $time, ${row.text}"
    Column(
        Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("transcript.row.${row.id}").clearAndSetSemantics {
            contentDescription = description
            if (!row.isFinal) stateDescription = stillSpeaking
        },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            ConclaveText(name, line = "transcript.row.${row.id}.name", style = typography.titleSmall, modifier = Modifier.weight(1f))
            ConclaveText(time, line = "transcript.row.${row.id}.time", style = typography.labelSmall, color = scheme.onSurfaceVariant)
        }
        ConclaveText(row.text, line = "transcript.row.${row.id}.text", style = typography.bodyLarge,
            color = if (row.isFinal) scheme.onSurface else scheme.onSurfaceVariant)
    }
}

// MARK: Ask (6 d)

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TranscriptAskList(presenter: TranscriptPresenter, page: TranscriptPageState, reservation: PaddingValues) {
    val thread = presenter.ask
    val raw = thread.rowIds
    val reversed = remember(raw) { raw.toList().asReversed().toList() }
    val context = LocalContext.current
    if (reversed.isEmpty()) {
        Column(
            Modifier.fillMaxSize().padding(start = 24.dp, end = 24.dp, top = 24.dp + reservation.calculateTopPadding(), bottom = 24.dp)
                .testTag("transcript.ask.empty"),
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ConclaveEmptyStatus(title = conclaveString("trn_ask_empty_title"), body = conclaveString("trn_ask_empty_body"),
                icon = ConclaveIcons.AutoAwesomeFill0, identifier = "transcript.ask.emptyStatus")
            for (name in listOf("trn_ask_suggest_decisions", "trn_ask_suggest_summary", "trn_ask_suggest_actions")) {
                val suggestion = conclaveString(name)
                // Fills the field, never sends; tonal so the coral prominent action stays the only coral one.
                ConclaveButton(title = suggestion, role = ConclaveButtonRole.Tonal, identifier = "transcript.ask.$name",
                    onClick = { page.updateAsk(suggestion) })
            }
        }
        return
    }
    val listState = rememberLazyListState()
    val atBottom by remember {
        derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= TRANSCRIPT_BOTTOM_SLOP_DP }
    }
    var wasAtBottom by remember { mutableStateOf(true) }
    LaunchedEffect(atBottom) { wasAtBottom = atBottom }
    // A new question scrolls to it.
    LaunchedEffect(reversed.firstOrNull()) { listState.scrollToItem(0) }
    TranscriptAskFollowEffect(thread, listState) { wasAtBottom }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val maxBubble = maxWidth * ConclaveBubbleGeometry.maxWidthFraction.toFloat()
        LazyColumn(
            state = listState,
            reverseLayout = true,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp + reservation.calculateTopPadding(),
                bottom = 12.dp + reservation.calculateBottomPadding()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxSize().imeNestedScroll().testTag("transcript.ask.list"),
        ) {
            items(count = reversed.size, key = { reversed[it] }) { index ->
                val id = reversed[index]
                TranscriptAskRow(thread.row(id), maxBubble.value, onRetry = { presenter.retryAsk(rowId = id) },
                    onLink = { url -> ChatLinkLauncher.openInCustomTab(context, url) })
            }
        }
    }
}

/** Streaming growth of the newest answer is followed only while pinned (S40 CHT-7). */
@Composable
private fun TranscriptAskFollowEffect(thread: AskThread, listState: LazyListState, wasAtBottom: () -> Boolean) {
    val growth = thread.tailGrowth
    LaunchedEffect(growth) {
        if (growth > 0 && wasAtBottom()) listState.scrollToItem(0)
    }
}

/**
 * One question (trailing, primaryContainer) and its answer (leading, secondaryContainer), S40 CL1 through the FND-3
 * bubble. Thinking is static "Thinking" with the system spinner (R13); a done answer offers "Copy answer" on long press;
 * failures carry Try again.
 */
@Composable
private fun TranscriptAskRow(row: AskRow, maxBubbleDp: Float, onRetry: () -> Unit, onLink: (String) -> Unit) {
    val context = LocalContext.current
    val typography = MaterialTheme.typography
    val youAsked = conclaveString("trn_you_asked")
    val answered = conclaveString("trn_conclave_answered")
    val copyAnswer = conclaveString("trn_copy_answer")
    var menuOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().testTag("transcript.ask.${row.id}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            val questionDescription = "$youAsked, ${row.question}"
            ConclaveChatBubble(tone = ConclaveBubbleTone.own, isOwn = true, identifier = "transcript.ask.${row.id}.question",
                modifier = Modifier.widthIn(max = maxBubbleDp.dp).clearAndSetSemantics { contentDescription = questionDescription }) {
                ConclaveText(row.question, line = "transcript.ask.${row.id}.question.text", style = typography.bodyLarge)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
            Box {
                val longPress = if (row.state == AskRowState.done) {
                    Modifier.combinedClickable(onClick = {}, onLongClick = { menuOpen = true }, onLongClickLabel = copyAnswer)
                } else Modifier
                ConclaveChatBubble(tone = ConclaveBubbleTone.answer, isOwn = false, identifier = "transcript.ask.${row.id}.answer",
                    modifier = Modifier.widthIn(max = maxBubbleDp.dp).then(longPress)) {
                    when (row.state) {
                        AskRowState.thinking -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                            ConclaveText(conclaveString("trn_thinking"), line = "transcript.ask.${row.id}.thinking")
                        }
                        AskRowState.streaming, AskRowState.done -> Column(Modifier.semantics { contentDescription = answered }) {
                            AssistantMarkdown(blocks = row.blocks.toList(), onLink = onLink, identifier = "transcript.ask.${row.id}.markdown")
                        }
                        AskRowState.error, AskRowState.notSent, AskRowState.timedOut -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            val name = TranscriptCopy.askState(row.state)
                            val text = if (row.state == AskRowState.error && row.errorText.isNotEmpty()) row.errorText
                                else if (name != null) conclaveString(name) else ""
                            ConclaveText(text, line = "transcript.ask.${row.id}.failure", style = typography.bodyLarge, maxLines = 4)
                            TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.ask.${row.id}.retry")) {
                                ConclaveText(conclaveString("ds_try_again"), line = "transcript.ask.${row.id}.retry")
                            }
                        }
                    }
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    NativeSemanticsPopupRoot("transcript.ask.menu")
                    DropdownMenuItem(
                        text = { ConclaveText(copyAnswer, line = "transcript.ask.copyAnswer") },
                        onClick = {
                            menuOpen = false
                            TranscriptExport.copy(context, copyAnswer, row.answerText)
                        },
                        modifier = Modifier.testTag("transcript.ask.copyAnswer"),
                    )
                }
            }
        }
    }
}

/** The one F00 C19 composer (S40 R40-6 slots; always opaque on Android), ImeAction.Send, hardware Enter sends. */
@Composable
internal fun TranscriptAskComposer(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot, page: TranscriptPageState) {
    val canSend = AskRowPolicy.canSend(page.askDraft, canAsk = snapshot.canAsk, phase = snapshot.phase, link = snapshot.link)
    ConclaveComposerStack(
        identifier = "transcript.ask.composer",
        contentPadding = PaddingValues(0.dp),
        accessories = {
            ConclaveComposerStatusLine(text = conclaveString("trn_ask_private"), identifier = "transcript.ask.private")
        },
    ) {
        ConclaveComposerField(
            placeholder = conclaveString("trn_ask_placeholder"),
            value = page.askDraft,
            onValueChange = { page.updateAsk(it) },
            sendEnabled = canSend,
            onSend = { if (presenter.askQuestion(page.askDraft)) page.updateAsk("") },
            identifier = "transcript.ask.field",
            sendLabel = conclaveString("trn_ask_send"),
        )
    }
}

// MARK: Minutes (6 d)

@Composable
internal fun TranscriptMinutesList(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot, reservation: PaddingValues) {
    val minutes = presenter.minutes
    val scheme = MaterialTheme.colorScheme
    val typography = MaterialTheme.typography
    val empty = MinutesPolicy.emptyKind(phase = snapshot.phase, hasContent = minutes.hasContent)
    val sections = minutes.sections.toList()
    val statusKind = MinutesPolicy.statusKind(updating = snapshot.minutesUpdating, updatedAtMillis = snapshot.minutesUpdatedAtMillis)
    // 6 k: the relative "Updated" label refreshes once a minute while Minutes is visible (the only timer).
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(statusKind) {
        while (statusKind == MinutesStatusKind.updated) {
            now = System.currentTimeMillis()
            delay(60_000)
        }
    }
    val statusName = TranscriptCopy.minutesStatus(statusKind)
    val statusText = if (statusKind == MinutesStatusKind.updated) {
        conclaveString(statusName, DateUtils.getRelativeTimeSpanString(snapshot.minutesUpdatedAtMillis.toLong(), now,
            DateUtils.MINUTE_IN_MILLIS).toString())
    } else conclaveString(statusName)
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("transcript.minutes"),
        contentPadding = PaddingValues(top = reservation.calculateTopPadding(), bottom = 16.dp + reservation.calculateBottomPadding()),
    ) {
        item(key = "status", contentType = "status") {
            ListItem(
                leadingContent = if (statusKind == MinutesStatusKind.updating) {
                    { CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp) }
                } else null,
                headlineContent = { ConclaveText(statusText, line = "transcript.minutes.status", color = scheme.onSurfaceVariant) },
                colors = ListItemDefaults.colors(containerColor = scheme.surface),
                modifier = Modifier.semantics(mergeDescendants = true) {}.testTag("transcript.minutes.status"),
            )
        }
        if (snapshot.canRefreshMinutes) {
            item(key = "refresh", contentType = "button") {
                TextButton(onClick = { presenter.refreshMinutes() }, enabled = !snapshot.minutesUpdating,
                    modifier = Modifier.padding(horizontal = 8.dp).heightIn(min = 48.dp).testTag("transcript.minutes.refresh")) {
                    ConclaveText(conclaveString("trn_refresh_minutes"), line = "transcript.minutes.refresh")
                }
            }
        }
        if (snapshot.offersRecapToChat || snapshot.recap != RecapPhase.idle) {
            item(key = "recap", contentType = "recap") {
                val value = TranscriptCopy.recapValue(snapshot.recap)
                val enabled = snapshot.offersRecapToChat && snapshot.recap != RecapPhase.posting
                ListItem(
                    headlineContent = { ConclaveText(conclaveString("trn_post_recap"), line = "transcript.minutes.recap") },
                    supportingContent = {
                        ConclaveText(conclaveString("trn_post_recap_detail"), line = "transcript.minutes.recap.detail",
                            color = scheme.onSurfaceVariant)
                    },
                    trailingContent = if (snapshot.recap == RecapPhase.posting || snapshot.recap == RecapPhase.posted) {
                        {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (snapshot.recap == RecapPhase.posting) {
                                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                                }
                                if (value != null) {
                                    ConclaveText(conclaveString(value), line = "transcript.minutes.recap.value", color = scheme.onSurfaceVariant)
                                }
                            }
                        }
                    } else null,
                    colors = ListItemDefaults.colors(containerColor = scheme.surface),
                    modifier = Modifier.semantics(mergeDescendants = true) {}.testTag("transcript.minutes.recap")
                        .combinedClickable(enabled = enabled, onClick = { presenter.postRecapToChat() }),
                )
            }
        }
        if (minutes.summary.isNotEmpty()) {
            item(key = "summary.header", contentType = "header") { TranscriptMinutesHeader(conclaveString("trn_section_summary")) }
            item(key = "summary", contentType = "entry") {
                ConclaveText(minutes.summary, line = "transcript.minutes.summary", style = typography.bodyLarge,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            }
        }
        for (section in sections) {
            item(key = "header.${section.id}", contentType = "header") {
                TranscriptMinutesHeader(conclaveString(TranscriptCopy.section(section.section)))
            }
            val entries = section.entries.toList()
            for (entry in entries) {
                item(key = entry.id, contentType = "entry") { TranscriptMinutesEntry(entry) }
            }
        }
        if (empty != MinutesEmptyKind.none) {
            item(key = "empty", contentType = "empty") {
                val title = TranscriptCopy.emptyTitle(empty)
                val body = TranscriptCopy.emptyBody(empty)
                if (title != null && body != null) {
                    ConclaveEmptyStatus(title = conclaveString(title), body = conclaveString(body), icon = ConclaveIcons.SummarizeFill0,
                        identifier = "transcript.minutes.empty")
                }
            }
        }
    }
}

@Composable
private fun TranscriptMinutesHeader(title: String) {
    ConclaveText(title, line = "transcript.minutes.header.$title", style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() })
}

/** One entry with "Owner: %1$s" and "Due: %1$s" as separate supporting lines (6 d). */
@Composable
private fun TranscriptMinutesEntry(entry: MinutesEntryModel) {
    val scheme = MaterialTheme.colorScheme
    val owner = if (entry.owner.isNotEmpty()) conclaveString("trn_owner", entry.owner) else null
    val due = if (entry.due.isNotEmpty()) conclaveString("trn_due", entry.due) else null
    ListItem(
        headlineContent = { ConclaveText(entry.text, line = "transcript.minutes.entry.${entry.id}") },
        supportingContent = if (owner != null || due != null) {
            {
                Column {
                    if (owner != null) ConclaveText(owner, line = "transcript.minutes.entry.${entry.id}.owner", color = scheme.onSurfaceVariant)
                    if (due != null) ConclaveText(due, line = "transcript.minutes.entry.${entry.id}.due", color = scheme.onSurfaceVariant)
                }
            }
        } else null,
        colors = ListItemDefaults.colors(containerColor = scheme.surface),
        modifier = Modifier.semantics(mergeDescendants = true) {}.testTag("transcript.minutes.entry.${entry.id}"),
    )
}
