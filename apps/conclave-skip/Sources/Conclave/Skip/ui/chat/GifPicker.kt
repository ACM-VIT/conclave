package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GifPickerSheet(presenter: ChatPresenter, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.semantics { testTagsAsResourceId = true }.testTag("chat.gifs"),
    ) {
        NativeSemanticsPopupRoot("chat.gifs")
        GifPickerContent(presenter, onPicked = {
            scope.launch { sheetState.hide() }.invokeOnCompletion { onDismiss() }
        })
    }
}

@Composable
internal fun GifPickerContent(presenter: ChatPresenter, onPicked: () -> Unit, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(ChatGifPickerState.initial) }
    var query by remember { mutableStateOf("") }
    var kindId by remember { mutableStateOf(ChatGifKind.gif.rawValue) }
    var loadJob by remember { mutableStateOf<Job?>(null) }
    var moreJob by remember { mutableStateOf<Job?>(null) }
    val kind = ChatGifKind.init(rawValue = kindId) ?: ChatGifKind.gif

    fun start(nextKind: ChatGifKind, nextQuery: String) {
        loadJob?.cancel()
        moreJob?.cancel()
        val next = state.starting(nextKind, nextQuery)
        state = next
        val generation = next.generation
        loadJob = scope.launch {
            val page = presenter.searchGifs(nextKind, nextQuery, 1)
            state = state.acceptingFirst(page, generation)
        }
    }

    fun loadMore() {
        val current = state
        if (!current.canLoadMore) return
        state = current.startingMore()
        val generation = current.generation
        moreJob = scope.launch {
            val page = presenter.searchGifs(current.kind, current.query, current.nextPage)
            state = state.acceptingMore(page, generation)
        }
    }

    LaunchedEffect(query) {
        if (state.generation > 0) delay(ChatGifPickerState.debounceMillis.toLong())
        start(ChatGifKind.init(rawValue = kindId) ?: ChatGifKind.gif, query)
    }

    val gridState = rememberLazyGridState()
    val nearEnd by remember {
        derivedStateOf {
            val last = gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            last >= 0 && last >= gridState.layoutInfo.totalItemsCount - 1 - ChatGifPickerState.loadMoreThreshold
        }
    }
    LaunchedEffect(nearEnd, state.generation, state.items.count) {
        if (nearEnd && state.canLoadMore && !state.loadMoreFailed) loadMore()
    }

    val navigation = WindowInsets.navigationBars.asPaddingValues()
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ConclaveSearchField(
            query = query,
            onQueryChange = { query = it },
            identifier = "chat.gifs.search",
            modifier = Modifier.padding(horizontal = 16.dp),
            placeholder = gifSearchPrompt(kind),
            resultCount = if (state.phase == ChatGifPickerPhase.results || state.phase == ChatGifPickerPhase.empty) state.items.count else null,
        )
        ConclaveSegmentedRow(
            options = gifKindOptions(),
            selectedId = kindId,
            identifier = "chat.gifs.kind",
            onSelect = { selected ->
                kindId = selected
                start(ChatGifKind.init(rawValue = selected) ?: ChatGifKind.gif, query)
            },
            modifier = Modifier.padding(horizontal = 16.dp),
            fallback = ConclaveSegmentedFallback.menu,
        )
        when (state.phase) {
            ChatGifPickerPhase.loading -> Box(Modifier.fillMaxWidth().padding(vertical = 48.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            ChatGifPickerPhase.empty -> GifPickerStatus(gifEmptyText(kind), "chat.gifs.empty", null)
            ChatGifPickerPhase.error -> GifPickerStatus(gifErrorText(kind), "chat.gifs.error") { start(kind, query) }
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(104.dp),
                state = gridState,
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp + navigation.calculateBottomPadding()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth().testTag("chat.gifs.grid"),
            ) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    ConclaveTipCard(
                        id = OneTimeTipID.gifPicker.rawValue,
                        title = conclaveString("chat_gif_tip_title"),
                        body = conclaveString("chat_gif_tip_body"),
                        icon = ConclaveIcons.GifBoxFill0,
                        identifier = "chat.gifs.tip",
                    )
                }
                itemsIndexed(state.items.toList(), key = { _, gif -> gif.id }) { _, gif ->
                    GifTile(gif, kind) {
                        presenter.sendGif(gif)
                        onPicked()
                    }
                }
                item(span = { GridItemSpan(maxLineSpan) }) {
                    GifPickerFooter(state.loadMoreFailed, state.isLoadingMore) { loadMore() }
                }
            }
        }
    }
}

@Composable
private fun GifTile(gif: ChatGifAttachment, kind: ChatGifKind, onSend: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val still = gif.previewUrl?.ifEmpty { null } ?: gif.url
    val label = ChatMediaCopyAndroid.gifLabel(gif.title, kind)
    val hint = conclaveString("chat_gif_send_hint")
    Box(
        Modifier.size(104.dp).testTag("chat.gifs.tile.${gif.id}").clearAndSetSemantics {
            contentDescription = label
            role = Role.Button
            onClick(label = hint) {
                onSend()
                true
            }
        },
        contentAlignment = Alignment.Center,
    ) {
        ChatImageBox(
            url = still, width = 104.dp, height = 104.dp, shape = RoundedCornerShape(12.dp),
            placeholder = if (kind == ChatGifKind.sticker) scheme.surfaceContainerLow else scheme.surfaceContainerHighest,
            animate = kind != ChatGifKind.clip, onOpen = onSend,
        )
        if (kind == ChatGifKind.clip) {
            Surface(shape = CircleShape, color = scheme.surface) {
                Icon(ConclaveIcons.PlayArrowFill1, contentDescription = null, tint = scheme.onSurface, modifier = Modifier.padding(8.dp).size(20.dp))
            }
        }
    }
}

@Composable
private fun GifPickerStatus(text: String, identifier: String, onRetry: (() -> Unit)?) {
    Column(
        Modifier.fillMaxWidth().padding(24.dp).testTag(identifier).semantics { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ConclaveText(text, line = "$identifier.text", style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
        if (onRetry != null) {
            FilledTonalButton(onClick = onRetry, modifier = Modifier.testTag("$identifier.retry")) {
                ConclaveText(conclaveString("ds_try_again"), line = "$identifier.retry.label")
            }
        }
    }
}

@Composable
private fun GifPickerFooter(loadMoreFailed: Boolean, isLoadingMore: Boolean, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (loadMoreFailed) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.testTag("chat.gifs.moreFailed")) {
                ConclaveText(conclaveString("chat_gif_more_failed"), line = "chat.gifs.moreFailed.text",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = onRetry) { ConclaveText(conclaveString("ds_retry"), line = "chat.gifs.moreFailed.retry") }
            }
        } else if (isLoadingMore) {
            CircularProgressIndicator(Modifier.size(24.dp))
        }
        ConclaveText(conclaveString("chat_gif_attribution"), line = "chat.gifs.attribution", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("chat.gifs.attribution"))
    }
}

@Composable
private fun gifKindOptions(): List<ConclaveSegmentModel> = listOf(
    ConclaveSegmentModel(id = ChatGifKind.gif.rawValue, title = conclaveString("chat_gif_kind_gifs"), isEnabled = true),
    ConclaveSegmentModel(id = ChatGifKind.sticker.rawValue, title = conclaveString("chat_gif_kind_stickers"), isEnabled = true),
    ConclaveSegmentModel(id = ChatGifKind.clip.rawValue, title = conclaveString("chat_gif_kind_clips"), isEnabled = true),
)

@Composable
private fun gifSearchPrompt(kind: ChatGifKind): String = when (kind) {
    ChatGifKind.sticker -> conclaveString("chat_gif_search_stickers")
    ChatGifKind.clip -> conclaveString("chat_gif_search_clips")
    else -> conclaveString("chat_gif_search_gifs")
}

@Composable
private fun gifEmptyText(kind: ChatGifKind): String = when (kind) {
    ChatGifKind.sticker -> conclaveString("chat_gif_empty_stickers")
    ChatGifKind.clip -> conclaveString("chat_gif_empty_clips")
    else -> conclaveString("chat_gif_empty_gifs")
}

@Composable
private fun gifErrorText(kind: ChatGifKind): String = when (kind) {
    ChatGifKind.sticker -> conclaveString("chat_gif_error_stickers")
    ChatGifKind.clip -> conclaveString("chat_gif_error_clips")
    else -> conclaveString("chat_gif_error_gifs")
}
