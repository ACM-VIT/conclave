package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
internal fun AppWheelPage(host: AppHostPresenter, reservation: PaddingValues) {
    val wheel = host.wheel
    var draft by rememberSaveable { mutableStateOf("") }
    var confirmClear by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { host.refreshRoster() }
    val addDraft: () -> Unit = {
        if (draft.isBlank()) {
            draft = ""
        } else if (host.addWheelNames(draft) == ActivityTapResult.dispatched) {
            draft = ""
        }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("app.wheel.page"), contentPadding = reservation) {
        if (!wheel.isReady) {
            item(key = "closed") { AppPageClosed("wheel") }
        } else {
            if (wheel.canEdit) {
                item(key = "add") {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { value ->
                            draft = value

                            if (value.contains('\n')) addDraft()
                        },
                        label = { Text(conclaveString("app_wheel_add_name")) },
                        singleLine = false,
                        maxLines = 4,
                        enabled = !wheel.isFull,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { addDraft() }),
                        supportingText = if (wheel.isFull) ({ Text(conclaveString("app_wheel_full")) }) else null,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("app.wheel.add"),
                    )
                }
                item(key = "everyone") {
                    val pending = wheel.isPending(AppPageCommandKind.addEntries, target = "everyone")
                    val missing = wheel.missingNames.count
                    val enabled = missing > 0 && !wheel.isFull
                    ListItem(
                        headlineContent = { Text(conclaveString("app_wheel_add_everyone")) },
                        trailingContent = {
                            if (pending) {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            } else {
                                Text(conclavePlural("app_wheel_missing", missing, missing), style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                        modifier = Modifier.testTag("app.wheel.addEveryone").clickable(enabled = enabled, role = Role.Button) {
                            host.addEveryoneToWheel()
                        },
                    )
                }
            }
            if (wheel.entries.count == 0) {
                item(key = "empty") { AppPlainRow(conclaveString("app_wheel_empty"), "app.wheel.empty") }
            } else {
                items(wheel.entries.toList(), key = { "e:" + it.id }) { entry ->
                    val removing = wheel.isPending(AppPageCommandKind.removeEntry, target = entry.id)
                    AppSwipeToRemove(enabled = wheel.canEdit && !removing, onRemove = { host.removeWheelEntry(entry.id) }) {
                        ListItem(
                            headlineContent = { Text(entry.label) },
                            trailingContent = if (removing) ({ CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }) else null,
                            modifier = Modifier.testTag("app.wheel.entry"),
                        )
                    }
                }
            }
            if (wheel.canEdit) {
                item(key = "actions") {
                    Column {
                        AppActionRow(conclaveString("app_wheel_shuffle"), "app.wheel.shuffle",
                            enabled = wheel.entries.count >= 2, pending = wheel.isPending(AppPageCommandKind.shuffle)) { host.shuffleWheel() }
                        AppActionRow(conclaveString("app_wheel_sort"), "app.wheel.sort",
                            enabled = wheel.entries.count >= 2, pending = wheel.isPending(AppPageCommandKind.sort)) { host.sortWheel() }
                        AppActionRow(conclaveString("app_wheel_clear_names"), "app.wheel.clear", enabled = wheel.entries.count > 0,
                            pending = wheel.isPending(AppPageCommandKind.clearEntries), destructive = true) { confirmClear = true }
                        AppSwitchRow(conclaveString("app_wheel_remove_winner"), conclaveString("app_wheel_remove_winner_detail"),
                            checked = wheel.removeWinner, enabled = !wheel.isPending(AppPageCommandKind.setRemoveWinner),
                            identifier = "app.wheel.removeWinner") { value -> host.setWheelRemoveWinner(value) }
                    }
                }
            }
            item(key = "sounds") {
                AppSwitchRow(conclaveString("app_wheel_sounds"), "", checked = wheel.sounds,
                    enabled = !wheel.isPending(AppPageCommandKind.setSounds), identifier = "app.wheel.sounds") { value -> host.setWheelSounds(value) }
            }
            if (wheel.results.count > 0) {
                item(key = "h:results") { ConclaveSectionHeader(conclaveString("app_wheel_results"), "app.wheel.header.results") }
                items(wheel.results.toList(), key = { "r:" + it.id }) { result ->
                    ListItem(
                        headlineContent = { Text(result.label) },
                        supportingContent = if (result.byName.isEmpty()) null else ({ Text(result.byName) }),
                        modifier = Modifier.testTag("app.wheel.result"),
                    )
                }
                if (wheel.canEdit) {
                    item(key = "results.clear") {
                        AppActionRow(conclaveString("app_wheel_clear_results"), "app.wheel.clearResults", enabled = true,
                            pending = wheel.isPending(AppPageCommandKind.clearResults)) { host.clearWheelResults() }
                    }
                }
            }
        }
    }
    if (confirmClear) {
        val scheme = MaterialTheme.colorScheme
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text(conclaveString("app_wheel_clear_title")) },
            text = { Text(conclaveString("app_wheel_clear_message")) },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    host.clearWheelNames()
                }, colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text(conclaveString("app_wheel_clear_confirm")) }
            },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text(conclaveString("ds_cancel")) } },
        )
    }
}

@Composable
internal fun AppWatchPage(host: AppHostPresenter, reservation: PaddingValues) {
    val watch = host.watch
    var query by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(Unit) { host.loadWatchTrending() }
    Column(Modifier.fillMaxSize().testTag("app.watch.page")) {
        if (watch.isReady) {
            ConclaveSearchField(
                query = query,
                onQueryChange = { value ->
                    query = value
                    if (value.isEmpty()) host.clearWatchSearch()
                },
                identifier = "app.watch.search",
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                placeholder = conclaveString("app_watch_search_prompt"),
                onSearch = {
                    val submitted = query
                    host.submitWatchSearch(submitted)
                    if (WatchLinkPolicy.videoId(submitted).isNotEmpty()) query = ""
                },
            )
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = reservation) {
            if (!watch.isReady) {
                item(key = "closed") { AppPageClosed("watch") }
            } else {
                if (watch.videoId.isNotEmpty()) {
                    item(key = "now") {
                        ListItem(
                            headlineContent = { Text(watch.title.ifEmpty { appHostName("watch") }, maxLines = 2) },
                            trailingContent = { Text(appWatchPlayback(watch.playback), style = MaterialTheme.typography.labelLarge) },
                            modifier = Modifier.testTag("app.watch.now"),
                        )
                    }
                } else if (!watch.canControl) {
                    item(key = "waiting") { AppPlainRow(conclaveString("app_watch_waiting"), "app.watch.waiting") }
                }
                if (watch.requestDeclined) {
                    item(key = "declined") { AppPlainRow(conclaveString("app_watch_declined"), "app.watch.declined") }
                }
                when (watch.searchPhase) {
                    WatchSearchPhase.idle -> Unit
                    WatchSearchPhase.searching -> item(key = "searching") {
                        Box(Modifier.fillMaxWidth().padding(16.dp).testTag("app.watch.searching"), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                        }
                    }
                    WatchSearchPhase.results -> items(watch.results.toList(), key = { "s:" + it.id }) { video -> AppWatchVideoItem(host, watch, video) }
                    WatchSearchPhase.empty -> item(key = "noResults") { AppPlainRow(conclaveString("ds_no_results"), "app.watch.noResults") }
                    WatchSearchPhase.unavailable -> item(key = "searchOff") { AppPlainRow(conclaveString("app_watch_search_off"), "app.watch.searchOff") }
                    WatchSearchPhase.failed -> item(key = "searchFailed") { AppPlainRow(conclaveString("app_watch_search_failed"), "app.watch.searchFailed") }
                }
                if (query.isEmpty() && watch.queue.count == 0 && watch.searchPhase == WatchSearchPhase.idle) {
                    if (watch.trending.count > 0) {
                        item(key = "h:trending") { ConclaveSectionHeader(conclaveString("app_watch_trending"), "app.watch.header.trending") }
                        items(watch.trending.toList(), key = { "t:" + it.id }) { video -> AppWatchVideoItem(host, watch, video) }
                    }
                    item(key = "h:classics") { ConclaveSectionHeader(conclaveString("app_watch_classics"), "app.watch.header.classics") }
                    items(WatchClassics.items.toList(), key = { "c:" + it.id }) { video -> AppWatchVideoItem(host, watch, video) }
                }
                item(key = "h:queue") { ConclaveSectionHeader(conclaveString("app_watch_up_next"), "app.watch.header.queue") }
                if (watch.queue.count == 0) {
                    item(key = "queue.empty") { AppPlainRow(conclaveString("app_watch_queue_empty"), "app.watch.queueEmpty") }
                } else {
                    items(watch.queue.toList(), key = { "q:" + it.id }) { item -> AppWatchQueueItem(host, watch, item) }
                }
                if (watch.isHost && watch.requests.count > 0) {
                    item(key = "h:requests") { ConclaveSectionHeader(conclaveString("app_watch_requests"), "app.watch.header.requests") }
                    items(watch.requests.toList(), key = { "rq:" + it.id }) { request -> AppWatchRequestItem(host, watch, request) }
                } else if (watch.canRequest) {
                    val mine = watch.myRequest
                    if (mine != null) {
                        item(key = "h:requests") { ConclaveSectionHeader(conclaveString("app_watch_requests"), "app.watch.header.requests") }
                        item(key = "mine") {
                            ListItem(
                                headlineContent = { Text(mine.title.ifEmpty { mine.videoId }, maxLines = 2) },
                                trailingContent = { Text(conclaveString("app_watch_pending"), style = MaterialTheme.typography.labelLarge) },
                                modifier = Modifier.testTag("app.watch.myRequest"),
                            )
                        }
                        item(key = "mine.cancel") {
                            AppActionRow(conclaveString("app_watch_cancel_request"), "app.watch.cancelRequest", enabled = true,
                                pending = watch.isPending(AppPageCommandKind.cancelRequest), destructive = true) { host.cancelWatchRequest() }
                        }
                    }
                    item(key = "f:requests") { ConclaveSectionFooter(conclaveString("app_watch_request_footer"), "app.watch.requestFooter") }
                }
                if (watch.isHost) {
                    item(key = "control") {
                        AppSwitchRow(conclaveString("app_watch_everyone_control"), "", checked = watch.everyoneCanControl,
                            enabled = !watch.lockPending, identifier = "app.watch.everyoneCanControl") { value -> host.setWatchEveryoneCanControl(value) }
                    }
                    item(key = "f:control") {
                        ConclaveSectionFooter(conclaveString("app_watch_everyone_control_detail"), "app.watch.footer.control")
                    }
                }
            }
        }
    }
}

@Composable
private fun AppWatchVideoItem(host: AppHostPresenter, watch: WatchPageModel, video: WatchVideoModel) {
    val action = watch.pickAction
    val pending = watch.isPending(AppPageCommandKind.playNow, target = video.id) || watch.isPending(AppPageCommandKind.enqueue, target = video.id) ||
        watch.isPending(AppPageCommandKind.request, target = video.id)
    var menu by remember { mutableStateOf(false) }
    val base = Modifier.testTag("app.watch.video")
    ListItem(
        headlineContent = { Text(video.title.ifEmpty { video.id }, maxLines = 2) },
        supportingContent = if (video.channel.isEmpty()) null else ({ Text(video.channel, maxLines = 1) }),
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (pending) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else if (action != WatchPickAction.none) {
                    TextButton(onClick = { host.pickWatchVideo(video, action = action) }, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(appWatchPick(action), maxLines = 1)
                    }
                }
                if (action == WatchPickAction.enqueue && !pending) {
                    Box {
                        IconButton(onClick = { menu = true }) {
                            Icon(ConclaveIcons.MoreVertFill0, contentDescription = conclaveString("ds_more_options"),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        ConclaveDropdownMenu(expanded = menu, onDismissRequest = { menu = false }, identifier = "app.watch.video.menu") {
                            ConclaveMenuItem(title = conclaveString("app_watch_play_now"), identifier = "app.watch.video.playNow", onClick = {
                                menu = false
                                host.pickWatchVideo(video, action = WatchPickAction.playNow)
                            })
                        }
                    }
                }
            }
        },
        modifier = if (action == WatchPickAction.none) base.semantics(mergeDescendants = true) {} else base,
    )
}

@Composable
private fun AppWatchQueueItem(host: AppHostPresenter, watch: WatchPageModel, item: WatchItemModel) {
    val pending = watch.isPending(AppPageCommandKind.playNow, target = item.id) || watch.isPending(AppPageCommandKind.move, target = item.id) ||
        watch.isPending(AppPageCommandKind.remove, target = item.id)
    val queue = watch.queue.toList()
    val index = queue.indexOfFirst { it.id == item.id }
    val canUp = watch.canControl && index > 0
    val canDown = watch.canControl && index >= 0 && index < queue.size - 1
    val upLabel = conclaveString("app_move_up")
    val downLabel = conclaveString("app_move_down")
    var menu by remember { mutableStateOf(false) }
    val moves = mutableListOf<CustomAccessibilityAction>()
    if (canUp) moves.add(CustomAccessibilityAction(upLabel) { host.moveQueuedVideo(item.id, direction = -1); true })
    if (canDown) moves.add(CustomAccessibilityAction(downLabel) { host.moveQueuedVideo(item.id, direction = 1); true })
    AppSwipeToRemove(enabled = watch.canControl && !pending, onRemove = { host.removeQueuedVideo(item.id) }, extraActions = moves) {
        ListItem(
            headlineContent = { Text(item.title.ifEmpty { item.videoId }, maxLines = 2) },
            supportingContent = if (item.byName.isEmpty()) null else ({ Text(item.byName, maxLines = 1) }),
            trailingContent = if (!watch.canControl) null else ({
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (pending) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(onClick = { host.playQueuedVideo(item.id) }, modifier = Modifier.heightIn(min = 48.dp).testTag("app.watch.queue.playNow")) {
                            Text(conclaveString("app_watch_play_now"), maxLines = 1)
                        }
                        Box {
                            IconButton(onClick = { menu = true }) {
                                Icon(ConclaveIcons.MoreVertFill0, contentDescription = conclaveString("ds_more_options"),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            ConclaveDropdownMenu(expanded = menu, onDismissRequest = { menu = false }, identifier = "app.watch.queue.menu") {
                                ConclaveMenuItem(title = upLabel, identifier = "app.watch.queue.up", enabled = canUp, onClick = {
                                    menu = false
                                    host.moveQueuedVideo(item.id, direction = -1)
                                })
                                ConclaveMenuItem(title = downLabel, identifier = "app.watch.queue.down", enabled = canDown, onClick = {
                                    menu = false
                                    host.moveQueuedVideo(item.id, direction = 1)
                                })
                                ConclaveMenuDivider()
                                ConclaveMenuItem(title = conclaveString("app_remove"), identifier = "app.watch.queue.remove",
                                    role = ConclaveMenuRole.Destructive, onClick = {
                                        menu = false
                                        host.removeQueuedVideo(item.id)
                                    })
                            }
                        }
                    }
                }
            }),
            modifier = Modifier.testTag("app.watch.queue.item"),
        )
    }
}

@Composable
private fun AppWatchRequestItem(host: AppHostPresenter, watch: WatchPageModel, request: WatchRequestModel) {
    val pending = watch.isPending(AppPageCommandKind.approve, target = request.id) || watch.isPending(AppPageCommandKind.decline, target = request.id)
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().testTag("app.watch.request")) {
        ListItem(
            headlineContent = { Text(request.title.ifEmpty { request.videoId }, maxLines = 2) },
            supportingContent = if (request.byName.isEmpty()) null else ({ Text(request.byName, maxLines = 1) }),
        )
        Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (pending) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                OutlinedButton(onClick = { host.answerWatchRequest(request.id, approve = true) },
                    modifier = Modifier.heightIn(min = 48.dp).testTag("app.watch.request.approve")) {
                    Text(conclaveString("app_watch_add_to_queue"))
                }
                TextButton(onClick = { host.answerWatchRequest(request.id, approve = false) },
                    colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                    modifier = Modifier.heightIn(min = 48.dp).testTag("app.watch.request.decline")) {
                    Text(conclaveString("app_watch_decline"))
                }
            }
        }
    }
}

@Composable
private fun AppPageClosed(appId: String) {
    AppPlainRow(conclaveString("app_page_closed", appHostName(appId)), "app.page.closed")
}

@Composable
private fun AppPlainRow(text: String, identifier: String) {
    ListItem(headlineContent = { Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) }, modifier = Modifier.testTag(identifier))
}

@Composable
private fun AppActionRow(
    title: String, identifier: String, enabled: Boolean, pending: Boolean, destructive: Boolean = false, onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val pendingText = conclaveString("ds_in_progress")
    val color = when {
        !enabled -> scheme.onSurfaceVariant
        destructive -> scheme.error
        else -> scheme.onSurface
    }
    ListItem(
        headlineContent = { Text(title, color = color) },
        trailingContent = if (pending) ({ CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }) else null,
        modifier = Modifier.testTag(identifier).clickable(enabled = enabled && !pending, role = Role.Button, onClick = onClick).semantics {
            if (pending) stateDescription = pendingText
        },
    )
}

@Composable
private fun AppSwitchRow(
    title: String, detail: String, checked: Boolean, enabled: Boolean, identifier: String, onCheckedChange: (Boolean) -> Unit,
) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = if (detail.isEmpty()) null else ({ Text(detail) }),
        trailingContent = { Switch(checked = checked, onCheckedChange = null, enabled = enabled) },
        modifier = Modifier.testTag(identifier).toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppSwipeToRemove(
    enabled: Boolean, onRemove: () -> Unit, extraActions: List<CustomAccessibilityAction> = emptyList(), content: @Composable () -> Unit,
) {
    if (!enabled) {
        content()
        return
    }
    val scope = rememberCoroutineScope()
    val removeLabel = conclaveString("app_remove")
    val state = rememberSwipeToDismissBoxState(initialValue = SwipeToDismissBoxValue.Settled, positionalThreshold = { distance -> distance * 0.4f })
    SwipeToDismissBox(
        state = state,
        backgroundContent = {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.errorContainer).padding(end = 16.dp), contentAlignment = Alignment.CenterEnd) {
                Icon(ConclaveIcons.DeleteFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
            }
        },
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = true,
        onDismiss = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) onRemove()
            scope.launch { state.reset() }
        },
    ) {
        Box(Modifier.semantics(mergeDescendants = true) {
            customActions = extraActions + CustomAccessibilityAction(removeLabel) { onRemove(); true }
        }) {
            content()
        }
    }
}
