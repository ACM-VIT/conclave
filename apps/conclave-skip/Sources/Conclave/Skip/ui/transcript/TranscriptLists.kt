package conclave.module

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
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SuggestionChip
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CollectionInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collectionInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
private fun rememberJumpState(listState: LazyListState, rowCount: Int): Pair<Boolean, Boolean> {
    val density = LocalDensity.current.density.toDouble()
    val atLatest by remember(listState, density) {
        derivedStateOf {
            val distance = TranscriptFollowPolicy.reversedListDistance(firstVisibleIndex = listState.firstVisibleItemIndex,
                firstVisibleOffset = listState.firstVisibleItemScrollOffset.toDouble() / density)
            TranscriptFollowPolicy.isAtLatest(distanceFromLatest = distance)
        }
    }
    val showsJump = TranscriptFollowPolicy.showsJumpToLatest(rowCount = rowCount,
        distanceFromLatest = if (atLatest) 0.0 else TranscriptFollowPolicy.farFromLatest)
    return Pair(atLatest, showsJump)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TranscriptFeedList(feed: TranscriptFeed, reservation: PaddingValues) {
    val raw = feed.rowIds
    val reversed = remember(raw) { raw.toList().asReversed().toList() }
    if (reversed.isEmpty()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, top = 16.dp + reservation.calculateTopPadding(), bottom = 16.dp)
            .testTag("transcript.listening")) {
            TranscriptNote(conclaveString("trn_listening_title"), conclaveString("trn_listening_body"), "transcript.listening")
        }
        return
    }
    val listState = rememberLazyListState()
    val (atLatest, showsJump) = rememberJumpState(listState, reversed.size)
    var wasAtLatest by remember { mutableStateOf(true) }
    var jumpRequests by remember { mutableStateOf(0) }
    LaunchedEffect(atLatest) { wasAtLatest = atLatest }
    TranscriptFollowEffect(feed, listState) { wasAtLatest }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            reverseLayout = true,
            verticalArrangement = Arrangement.Top,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp + reservation.calculateTopPadding(),
                bottom = 16.dp + reservation.calculateBottomPadding()),
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

        AnimatedVisibility(
            visible = showsJump,
            enter = fadeIn(tween(150)),
            exit = fadeOut(tween(150)),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp + reservation.calculateBottomPadding()),
        ) {
            FilledTonalButton(
                onClick = { jumpRequests += 1 },
                contentPadding = PaddingValues(start = 12.dp, end = 16.dp),
                modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.jumpPill"),
            ) {
                Icon(ConclaveIcons.ArrowDownwardFill0, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                ConclaveText(conclaveString("chat_jump_latest"), line = "transcript.jumpPill.label")
            }
        }
    }
    LaunchedEffect(jumpRequests) {
        if (jumpRequests > 0) listState.animateScrollToItem(0)
    }
}

@Composable
private fun TranscriptFollowEffect(feed: TranscriptFeed, listState: LazyListState, wasAtLatest: () -> Boolean) {
    val newestId = feed.newestId
    val newestRevision = feed.newestRevision
    LaunchedEffect(newestId, newestRevision) {
        if (newestId.isNotEmpty() && wasAtLatest()) listState.scrollToItem(0)
    }
}

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
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ConclaveText(name, line = "transcript.row.${row.id}.name", style = typography.titleSmall, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.alignByBaseline().weight(1f, fill = false))
            ConclaveText(time, line = "transcript.row.${row.id}.time", style = typography.labelSmall, color = scheme.onSurfaceVariant,
                maxLines = 1, modifier = Modifier.alignByBaseline())
        }
        ConclaveText(row.text, line = "transcript.row.${row.id}.text", style = typography.bodyLarge, color = scheme.onSurface)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TranscriptAskList(presenter: TranscriptPresenter, page: TranscriptPageState, reservation: PaddingValues) {
    val thread = presenter.ask
    val raw = thread.rowIds
    val reversed = remember(raw) { raw.toList().asReversed().toList() }
    val context = LocalContext.current
    if (reversed.isEmpty()) {
        TranscriptAskEmpty(page, reservation)
        return
    }
    val listState = rememberLazyListState()
    val (atLatest, _) = rememberJumpState(listState, reversed.size)
    var wasAtLatest by remember { mutableStateOf(true) }
    LaunchedEffect(atLatest) { wasAtLatest = atLatest }

    LaunchedEffect(reversed.firstOrNull()) { listState.scrollToItem(0) }
    TranscriptAskFollowEffect(thread, listState) { wasAtLatest }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val maxBubble = maxWidth * ConclaveBubbleGeometry.maxWidthFraction.toFloat()
        LazyColumn(
            state = listState,
            reverseLayout = true,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp + reservation.calculateTopPadding(),
                bottom = 16.dp + reservation.calculateBottomPadding()),
            verticalArrangement = Arrangement.spacedBy(20.dp, Alignment.Top),
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

@Composable
private fun TranscriptNote(title: String, body: String, identifier: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val typography = MaterialTheme.typography
    Column(modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ConclaveText(title, line = "$identifier.title", style = typography.titleMedium, modifier = Modifier.semantics { heading() })
        ConclaveText(body, line = "$identifier.body", style = typography.bodyMedium, color = scheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TranscriptAskEmpty(page: TranscriptPageState, reservation: PaddingValues) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, top = 16.dp + reservation.calculateTopPadding(), bottom = 16.dp)
            .testTag("transcript.ask.empty"),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        TranscriptNote(conclaveString("trn_ask_empty_title"), conclaveString("trn_ask_empty_body"), "transcript.ask.empty")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (name in listOf("trn_ask_suggest_decisions", "trn_ask_suggest_summary", "trn_ask_suggest_actions")) {
                val suggestion = conclaveString(name)
                SuggestionChip(
                    onClick = { page.updateAsk(suggestion) },
                    label = { ConclaveText(suggestion, line = "transcript.ask.$name") },
                    modifier = Modifier.testTag("transcript.ask.$name"),
                )
            }
        }
    }
}

@Composable
private fun TranscriptAskFollowEffect(thread: AskThread, listState: LazyListState, wasAtLatest: () -> Boolean) {
    val growth = thread.tailGrowth
    LaunchedEffect(growth) {
        if (growth > 0 && wasAtLatest()) listState.scrollToItem(0)
    }
}

@Composable
private fun TranscriptAskRow(row: AskRow, maxBubbleDp: Float, onRetry: () -> Unit, onLink: (String) -> Unit) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val typography = MaterialTheme.typography
    val youAsked = conclaveString("trn_you_asked")
    val answered = conclaveString("trn_conclave_answered")
    val copyAnswer = conclaveString("trn_copy_answer")
    var menuOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().testTag("transcript.ask.${row.id}"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            val questionDescription = "$youAsked, ${row.question}"
            ConclaveChatBubble(tone = ConclaveBubbleTone.peer, isOwn = true, identifier = "transcript.ask.${row.id}.question",
                modifier = Modifier.widthIn(max = maxBubbleDp.dp).clearAndSetSemantics { contentDescription = questionDescription }) {
                ConclaveText(row.question, line = "transcript.ask.${row.id}.question.text", style = typography.bodyLarge)
            }
        }
        Box(Modifier.fillMaxWidth().testTag("transcript.ask.${row.id}.answer")) {
            when (row.state) {
                AskRowState.thinking -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    ConclaveText(conclaveString("trn_thinking"), line = "transcript.ask.${row.id}.thinking", style = typography.bodyMedium,
                        color = scheme.onSurfaceVariant)
                }
                AskRowState.streaming, AskRowState.done -> {
                    val longPress = if (row.state == AskRowState.done) {
                        Modifier.combinedClickable(onClick = {}, onLongClick = { menuOpen = true }, onLongClickLabel = copyAnswer)
                    } else Modifier
                    Column(Modifier.fillMaxWidth().then(longPress).semantics { contentDescription = answered }) {
                        AssistantMarkdown(blocks = row.blocks.toList(), onLink = onLink, identifier = "transcript.ask.${row.id}.markdown")
                    }
                }
                AskRowState.error, AskRowState.notSent, AskRowState.timedOut -> Column {
                    val name = TranscriptCopy.askState(row.state)
                    val text = if (row.state == AskRowState.error && row.errorText.isNotEmpty()) row.errorText
                        else if (name != null) conclaveString(name) else ""
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(ConclaveIcons.ErrorFill1, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                        ConclaveText(text, line = "transcript.ask.${row.id}.failure", style = typography.bodyMedium,
                            color = scheme.onSurfaceVariant, maxLines = 4)
                    }
                    TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.ask.${row.id}.retry")) {
                        ConclaveText(conclaveString("ds_try_again"), line = "transcript.ask.${row.id}.retry")
                    }
                }
            }
            ConclaveDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, identifier = "transcript.ask.menu") {
                ConclaveMenuItem(
                    title = copyAnswer,
                    identifier = "transcript.ask.copyAnswer",
                    onClick = {
                        menuOpen = false
                        TranscriptExport.copy(context, copyAnswer, row.answerText)
                    },
                )
            }
        }
    }
}

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

@Composable
private fun minutesStatusText(kind: MinutesStatusKind, updatedAtMillis: Double): String {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(kind) {
        while (kind == MinutesStatusKind.updated) {
            now = System.currentTimeMillis()
            delay(MinutesAgePolicy.tickMillis.toLong())
        }
    }
    val name = TranscriptCopy.minutesStatus(kind)
    if (name != null) return conclaveString(name)
    val age = MinutesAgePolicy.age(updatedAtMillis = updatedAtMillis, nowMillis = now.toDouble())
    val ageName = TranscriptCopy.minutesAge(age.kind)
    return if (age.kind == MinutesAgeKind.justNow) conclaveString(ageName) else conclaveString(ageName, age.count)
}

@Composable
internal fun TranscriptMinutesList(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot, reservation: PaddingValues) {
    val minutes = presenter.minutes
    val scheme = MaterialTheme.colorScheme
    val typography = MaterialTheme.typography
    val empty = MinutesPolicy.emptyKind(phase = snapshot.phase, hasContent = minutes.hasContent)
    val sections = minutes.sections.toList()
    val statusKind = MinutesPolicy.statusKind(updating = snapshot.minutesUpdating, updatedAtMillis = snapshot.minutesUpdatedAtMillis)
    val statusText = minutesStatusText(statusKind, snapshot.minutesUpdatedAtMillis)
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("transcript.minutes"),
        contentPadding = PaddingValues(top = 4.dp + reservation.calculateTopPadding(), bottom = 24.dp + reservation.calculateBottomPadding()),
    ) {
        val showsStatusText = MinutesPolicy.showsStatusText(statusKind, hasContent = minutes.hasContent)
        if (showsStatusText || snapshot.canRefreshMinutes) item(key = "status", contentType = "status") {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 16.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).semantics(mergeDescendants = true) {}.testTag("transcript.minutes.status"),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (showsStatusText) {
                        if (statusKind == MinutesStatusKind.updating) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        }
                        ConclaveText(statusText, line = "transcript.minutes.status", style = typography.bodyMedium,
                            color = scheme.onSurfaceVariant)
                    }
                }
                if (snapshot.canRefreshMinutes) {
                    val refreshLabel = conclaveString("trn_refresh_minutes")
                    TextButton(onClick = { presenter.refreshMinutes() }, enabled = !snapshot.minutesUpdating,
                        modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.minutes.refresh").semantics { contentDescription = refreshLabel }) {
                        Icon(ConclaveIcons.RefreshFill0, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        ConclaveText(conclaveString("trn_refresh"), line = "transcript.minutes.refresh")
                    }
                }
            }
        }
        if (empty != MinutesEmptyKind.none) {
            item(key = "empty", contentType = "empty") {
                val title = TranscriptCopy.emptyTitle(empty)
                val body = TranscriptCopy.emptyBody(empty)
                if (title != null && body != null) {
                    TranscriptNote(conclaveString(title), conclaveString(body), "transcript.minutes.empty",
                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp).testTag("transcript.minutes.empty"))
                }
            }
        }
        if (minutes.summary.isNotEmpty()) {
            item(key = "summary.header", contentType = "header") { TranscriptMinutesHeader(conclaveString("trn_section_summary")) }
            item(key = "summary", contentType = "summary") {
                ConclaveText(minutes.summary, line = "transcript.minutes.summary", style = typography.bodyLarge,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("transcript.minutes.summary"))
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
        if (snapshot.offersRecapToChat || snapshot.recap != RecapPhase.idle) {
            item(key = "recap", contentType = "recap") { TranscriptRecapBlock(presenter, snapshot) }
        }
    }
}

@Composable
private fun TranscriptRecapBlock(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot) {
    val scheme = MaterialTheme.colorScheme
    val typography = MaterialTheme.typography
    val recap = snapshot.recap
    val value = TranscriptCopy.recapValue(recap)
    val valueText = if (value != null) conclaveString(value) else ""
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HorizontalDivider(Modifier.padding(bottom = 16.dp), color = scheme.outlineVariant)
        FilledTonalButton(
            onClick = { presenter.postRecapToChat() },
            enabled = snapshot.offersRecapToChat && recap != RecapPhase.posting,
            contentPadding = PaddingValues(start = 16.dp, end = 24.dp),
            modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.minutes.recap")
                .semantics { if (valueText.isNotEmpty()) stateDescription = valueText },
        ) {
            if (recap == RecapPhase.posting) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                Icon(if (recap == RecapPhase.posted) ConclaveIcons.CheckFill0 else ConclaveIcons.AutoAwesomeFill0,
                    contentDescription = null, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(8.dp))
            ConclaveText(conclaveString("trn_post_recap"), line = "transcript.minutes.recap")
        }
        if (recap == RecapPhase.failed) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ConclaveText(valueText, line = "transcript.minutes.recap.value", style = typography.bodySmall, color = scheme.error,
                    modifier = Modifier.weight(1f, fill = false))
                TextButton(onClick = { presenter.postRecapToChat() }, enabled = snapshot.offersRecapToChat,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.minutes.recap.retry")) {
                    ConclaveText(conclaveString("ds_try_again"), line = "transcript.minutes.recap.retry")
                }
            }
        } else {
            val detail = if (recap == RecapPhase.posted) valueText else conclaveString("trn_post_recap_detail")
            ConclaveText(detail, line = "transcript.minutes.recap.detail", style = typography.bodySmall, color = scheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun TranscriptMinutesHeader(title: String) {
    ConclaveText(title, line = "transcript.minutes.header.$title", style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp).semantics { heading() })
}

@Composable
private fun TranscriptMinutesEntry(entry: MinutesEntryModel) {
    val scheme = MaterialTheme.colorScheme
    val parts = mutableListOf<String>()
    if (entry.owner.isNotEmpty()) parts.add(conclaveString("trn_owner", entry.owner))
    if (entry.due.isNotEmpty()) parts.add(conclaveString("trn_due", entry.due))
    val detail = parts.joinToString(" · ")
    ListItem(
        headlineContent = { ConclaveText(entry.text, line = "transcript.minutes.entry.${entry.id}") },
        supportingContent = if (detail.isNotEmpty()) {
            { ConclaveText(detail, line = "transcript.minutes.entry.${entry.id}.detail", color = scheme.onSurfaceVariant) }
        } else null,
        colors = ListItemDefaults.colors(containerColor = scheme.surface),
        modifier = Modifier.semantics(mergeDescendants = true) {}.testTag("transcript.minutes.entry.${entry.id}"),
    )
}
