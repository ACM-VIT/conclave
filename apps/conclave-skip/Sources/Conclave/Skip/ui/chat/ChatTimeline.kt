package conclave.module

import androidx.compose.foundation.layout.size

import androidx.compose.material3.Icon

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CollectionInfo
import androidx.compose.ui.semantics.collectionInfo
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first

/*
 * S40 2 d (CHT-1): the timeline, a reversed LazyColumn (newest at index 0, at the bottom) keyed by row id with the
 * row kind as content type; short conversations align at the top and read oldest to newest. The cache reverses the
 * presenter's ids once per revision. A new row follows only while
 * at the bottom (captured before the insert) or for your own send; otherwise remote messages count into the jump
 * pill. Rows read only their own entry, so a reaction or delivery write recomposes one item. No timers in the list
 * (the 900 ms highlight is one effect keyed by the focus request).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChatTimeline(
    cache: ChatTimelineCache,
    presenter: ChatPresenter,
    actions: ChatRowActions,
    sidePane: Boolean,
    reservation: PaddingValues,
) {
    val reversed = cache.current()
    ChatDiagnostics.counters?.bump("chat.recompose.list")
    if (reversed.ids.isEmpty()) {
        ChatEmptyState(presenter, actions)
        return
    }
    val listState = rememberLazyListState()
    val reduceMotion = rememberReduceMotion()
    var unseen by remember { mutableIntStateOf(0) }
    var highlightId by remember { mutableStateOf("") }
    val atBottom by remember {
        derivedStateOf { !listState.canScrollBackward ||
            (listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= 48) }
    }
    var wasAtBottom by remember { mutableStateOf(true) }
    var jumpRequests by remember { mutableIntStateOf(0) }
    var initialPositioned by remember { mutableStateOf(false) }
    val placement = remember { ChatTimelinePlacement() }
    LaunchedEffect(atBottom) {
        wasAtBottom = atBottom
        if (atBottom) unseen = 0
    }
    val snapshot = reversed.snapshot
    LaunchedEffect(Unit) {
        // Opening is one request, so unread history cannot race a focus destination or an animated newest scroll.
        placement.focusRequest = snapshot.focusRequest
        placement.newestId = snapshot.newestId
        val target = ChatTimelinePolicy.initialTarget(focusId = snapshot.focusId,
            firstUnreadId = snapshot.firstUnreadId, newestId = snapshot.newestId)
        // In a reversed list offset zero puts this divider at the bottom, hiding the unread row below it.
        // Use the measured viewport to keep the divider near the upper third and the first unread in view.
        val offset = if (target == "unread") {
            val layout = snapshotFlow { listState.layoutInfo }
                .first { it.viewportEndOffset > it.viewportStartOffset }
            -(layout.viewportEndOffset - layout.viewportStartOffset) * 2 / 3
        } else 0
        // Arrivals before the first layout can move the reversed index without changing the destination.
        val index = cache.current().ids.indexOf(target)
        if (index >= 0) listState.scrollToItem(index, offset)
        initialPositioned = true
    }
    LaunchedEffect(snapshot.newestId, initialPositioned) {
        if (!initialPositioned || snapshot.newestId == placement.newestId) return@LaunchedEffect
        placement.newestId = snapshot.newestId
        if (snapshot.newestId.isEmpty()) return@LaunchedEffect
        if (wasAtBottom || snapshot.newestIsOwn) {
            if (reduceMotion) listState.scrollToItem(0) else listState.animateScrollToItem(0)
        } else if (snapshot.newestIsRemoteMessage) {
            unseen += 1
        }
    }
    LaunchedEffect(snapshot.focusRequest, initialPositioned) {
        val focus = snapshot.focusId
        if (!initialPositioned || focus.isEmpty() || focus !in reversed.ids) return@LaunchedEffect
        // New messages do not cancel an in-progress destination scroll or its highlight lifetime.
        if (snapshot.focusRequest != placement.focusRequest) {
            placement.focusRequest = snapshot.focusRequest
            val index = reversed.ids.indexOf(focus)
            if (reduceMotion) listState.scrollToItem(index) else listState.animateScrollToItem(index)
        }
        highlightId = focus
        delay(900)
        if (highlightId == focus) highlightId = ""
    }
    // T3 borrow P8 (2 d composer focus): read inside its own scope, so a focus gain recomposes no list or row.
    ChatComposerFocusFollow(listState, reduceMotion) { actions.composerFocusRevision }
    Column(Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val maxBubble = maxWidth * ConclaveBubbleGeometry.maxWidthFraction.toFloat()
            LazyColumn(
                state = listState,
                reverseLayout = true,
                verticalArrangement = Arrangement.Top,
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp + reservation.calculateTopPadding(),
                    bottom = 12.dp + reservation.calculateBottomPadding()),
                modifier = Modifier.fillMaxSize().imeNestedScroll().testTag("chat.timeline")
                    .semantics { collectionInfo = CollectionInfo(reversed.ids.size, 1) },
            ) {
                items(count = reversed.ids.size, key = { reversed.ids[it] }, contentType = { reversed.kinds[it] }) { index ->
                    val rowId = reversed.ids[index]
                    ChatRow(presenter.rows.entry(rowId), actions, sidePane, maxBubble, highlightId == rowId)
                }
            }
        }
        if (initialPositioned && !atBottom) {
            FilledTonalButton(
                onClick = {
                    unseen = 0
                    jumpRequests += 1
                },
                contentPadding = PaddingValues(horizontal = 16.dp),
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = 8.dp).testTag("chat.jumpPill"),
            ) {
                Icon(ConclaveIcons.ArrowDownwardFill0, contentDescription = null, modifier = Modifier.padding(end = 8.dp).size(18.dp))
                val label = if (unseen > 0) conclavePlural("chat_jump_new", unseen, unseen) else conclaveString("chat_jump_latest")
                ConclaveText(label, line = "chat.jumpPill.label")
            }
        }
    }
    // The pill's tap scrolls through this effect so the button lambda stays a plain state write.
    LaunchedEffect(jumpRequests) {
        if (jumpRequests > 0) {
            if (reduceMotion) listState.scrollToItem(0) else listState.animateScrollToItem(0)
        }
    }
}

/** Effect bookkeeping does not invalidate the list or its rows. */
private class ChatTimelinePlacement {
    var newestId = ""
    var focusRequest = 0
}

/**
 * T3 borrow P8 (S40 2 d composer focus, the T3 "follow when at the end" rule with one visibility test on every
 * platform): when the composer's field gains focus (`revision` moves past the value seen at first composition), the
 * effect runs [ChatFocusFollow.follow]: while the newest row is at least partly visible the reversed list scrolls to
 * index 0 (instantly under Remove animations); farther up, the position and the jump pill stay. `revision` is read
 * here, in this effect's own scope.
 */
@Composable
internal fun ChatComposerFocusFollow(listState: LazyListState, reduceMotion: Boolean, revision: () -> Int) {
    val current = revision()
    val initial = remember { current }
    LaunchedEffect(current) {
        if (current == initial) return@LaunchedEffect
        ChatFocusFollow.follow(listState, reduceMotion)
    }
}

/** P8: the one visibility rule and the focus follow it gates. */
internal object ChatFocusFollow {
    /** The newest row (index 0 of the reversed list) is at least partly inside the viewport. */
    fun newestVisible(listState: LazyListState): Boolean =
        listState.layoutInfo.visibleItemsInfo.any { it.index == 0 }

    /**
     * The focus gain's effect body (the Robolectric tests drive it directly): while the newest row is at least partly
     * visible, scrolls the reversed list to index 0 (instantly under Remove animations, else animated on the caller's
     * frame clock) and returns true; farther up it leaves the position alone and returns false. The check runs before
     * the IME insets shrink the list, and the reversed list keeps index 0 at the bottom while it shrinks.
     */
    suspend fun follow(listState: LazyListState, reduceMotion: Boolean): Boolean {
        if (!newestVisible(listState)) return false
        if (reduceMotion) listState.scrollToItem(0) else listState.animateScrollToItem(0)
        return true
    }
}

/** 2 d empty state: F00 C14 column, then Ask Conclave AI (hidden when the assistant is unavailable). */
@Composable
private fun ChatEmptyState(presenter: ChatPresenter, actions: ChatRowActions) {
    val showsAssistant = presenter.composer.assistant != AssistantAvailability.unavailable
    Column(
        Modifier.fillMaxSize().padding(24.dp).testTag("chat.empty"),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ConclaveEmptyStatus(
            title = conclaveString("chat_empty_title"),
            body = conclaveString("chat_empty_body"),
            icon = ConclaveIcons.ChatBubbleFill0,
            identifier = "chat.empty.status",
        )
        ConclaveText(conclaveString("chat_empty_visibility"), line = "chat.empty.visibility",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center)
        if (showsAssistant) {
            ConclaveText(conclaveString("chat_empty_assistant"), line = "chat.empty.assistant",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center)
            FilledTonalButton(onClick = { actions.focusComposer("@Conclave ") }, modifier = Modifier.testTag("chat.askAssistant")) {
                ConclaveText(conclaveString("chat_ask_assistant"), line = "chat.askAssistant.label")
            }
        }
    }
}

/** 2 d day separator: centered labelSmall in onSurfaceVariant, a heading. */
@Composable
internal fun ChatDayRow(row: ChatRowModel) {
    val context = LocalContext.current
    ConclaveText(
        ChatCopyAndroid.day(context, row.timestampMillis), line = "chat.row.${row.id}",
        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).semantics { heading() },
    )
}

/** 2 d unread divider: HorizontalDivider plus labelMedium "New messages", a heading. */
@Composable
internal fun ChatUnreadDivider() {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        ConclaveText(conclaveString("chat_new_messages_divider"), line = "chat.unread",
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}
