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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun TranscriptPage(
    presenter: TranscriptPresenter,
    panels: PanelCoordinator,
    request: PanelRequest,
    variant: InCallPageVariant,
    appearance: PanelAppearance,
    miniTile: CallMiniTileModel?,
    miniTileVideo: (@Composable () -> Unit)?,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbars = remember { SnackbarHostState() }
    val page = remember(presenter) { TranscriptPageState(presenter) }
    LaunchedEffect(request.presentationID) {
        presenter.panelDidOpen(destination = request.destination)
        page.seed()
    }
    DisposableEffect(presenter) {
        onDispose { presenter.panelDidClose() }
    }

    val destination = panels.destinationRequest
    LaunchedEffect(destination?.sequence) {
        val latest = panels.latestDestination(request.presentationID) ?: return@LaunchedEffect
        presenter.panelDidOpen(destination = latest.destination)
    }
    val snapshot = presenter.snapshot
    val tab = presenter.tab
    val copiedText = conclaveString("trn_copied")
    val shareSubject = conclaveString("trn_share_subject")
    val recapPosted = conclaveString("trn_recap_posted")
    val recapFailed = conclaveString("trn_recap_failed")
    val tryAgain = conclaveString("ds_try_again")
    val showsStartBar = TranscriptViewPolicy.showsStartBar(body = snapshot.body, offersStart = snapshot.offersStart)

    val announcement = presenter.announcement
    LaunchedEffect(announcement?.id) {
        val kind = announcement?.kind ?: return@LaunchedEffect
        if (kind == TranscriptAnnouncementKind.recapPosted) {
            snackbars.showSnackbar(recapPosted)
        } else if (kind == TranscriptAnnouncementKind.recapFailed) {
            val result = snackbars.showSnackbar(recapFailed, actionLabel = tryAgain, duration = SnackbarDuration.Long)
            if (result == SnackbarResult.ActionPerformed) presenter.postRecapToChat()
        }
    }
    InCallPage(
        title = conclaveString("trn_title"),
        variant = variant,
        appearance = appearance,
        hasComposer = true,
        miniTile = miniTile,
        onClose = { panels.dismiss(cancelPending = true) },
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        composer = {
            if (snapshot.body == TranscriptBody.content &&
                TranscriptViewPolicy.showsAskComposer(tab = tab, canAsk = snapshot.canAsk, phase = snapshot.phase)) {
                TranscriptAskComposer(presenter, snapshot, page)
            } else if (showsStartBar) {
                TranscriptStartBar(presenter, snapshot, page)
            }
        },
        composerOverlaysContent = showsStartBar,
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbars) },
        actions = {
            TranscriptOverflowMenu(presenter, snapshot, page,
                onExport = {
                    val file = TranscriptExport.build(context, presenter)
                    scope.launch {
                        val written = TranscriptExport.write(context, file) ?: return@launch
                        TranscriptExport.share(context, written, shareSubject)
                    }
                },
                onCopy = {
                    val text = presenter.copyText(labels = TranscriptExport.labels(context, presenter.inputs.roomId),
                        timeLabel = { millis -> TranscriptExport.clock(context, millis) })
                    presenter.noteCopied()
                    if (TranscriptExport.copy(context, shareSubject, text)) {
                        scope.launch { snackbars.showSnackbar(copiedText) }
                    }
                })
        },
    ) { reservation ->
        Box(Modifier.fillMaxSize().testTag("transcript.panel")) {
            Column(Modifier.fillMaxSize()) {
                when (snapshot.body) {
                    TranscriptBody.loading -> ConclaveLoadingStatus("transcript.loading", label = conclaveString("trn_loading"),
                        modifier = Modifier.padding(top = reservation.calculateTopPadding()))
                    TranscriptBody.unavailable -> ConclaveErrorStatus(
                        title = conclaveString("trn_unavailable_title"), body = conclaveString("trn_unavailable_body"),
                        icon = ConclaveIcons.ErrorFill1, identifier = "transcript.unavailable", onRetry = { presenter.retryConnection() },
                        modifier = Modifier.padding(top = reservation.calculateTopPadding()))
                    TranscriptBody.relayUnavailable -> ConclaveEmptyStatus(
                        title = conclaveString("trn_relay_unavailable_title"), body = conclaveString("trn_relay_unavailable_body"),
                        icon = ConclaveIcons.ClosedCaptionFill0, identifier = "transcript.relayUnavailable",
                        modifier = Modifier.padding(top = reservation.calculateTopPadding()))
                    TranscriptBody.startCard -> TranscriptStartCard(presenter, snapshot, page, reservation)
                    TranscriptBody.content -> {
                        TranscriptSessionHeader(presenter, snapshot, tab, page)
                        when (tab) {
                            TranscriptTab.transcript -> TranscriptFeedList(presenter.feed, reservation)
                            TranscriptTab.ask -> TranscriptAskList(presenter, page, reservation)
                            TranscriptTab.minutes -> TranscriptMinutesList(presenter, snapshot, reservation)
                        }
                    }
                }
            }
            if (showsStartBar) {
                ConclaveFloatingActionScrim(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(reservation.calculateBottomPadding()),
                    bottomPadding = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding())
            }
            TranscriptAnnouncementRegion(presenter)
            if (snapshot.body == TranscriptBody.content && tab == TranscriptTab.transcript && rememberSystemAccessibility().touchExploration) {
                TranscriptFinalizedRegion(presenter.feed)
            }
        }
    }
    if (snapshot.stop == StopPhase.confirming) {
        TranscriptStopDialog(presenter)
    }
}

internal class TranscriptPageState(val presenter: TranscriptPresenter) {
    var askDraft by mutableStateOf("")
    var provider by mutableStateOf(TranscriptProvider.openAI)
    var assistantModel by mutableStateOf(TranscriptConfiguration.defaultAssistantModel)
    var providerKey by mutableStateOf("")
    var assistantKey by mutableStateOf("")
    var optionsExpanded by mutableStateOf(false)
    var menuOpen by mutableStateOf(false)
    var modelDialogOpen by mutableStateOf(false)

    fun seed() {
        val drafts = presenter.drafts
        askDraft = drafts.ask
        provider = drafts.provider
        assistantModel = drafts.assistantModel
        providerKey = drafts.providerKey
        assistantKey = drafts.assistantKey
        optionsExpanded = drafts.optionsExpanded
    }

    fun updateAsk(value: String) {
        askDraft = value
        presenter.drafts.ask = value
    }

    fun updateProvider(value: TranscriptProvider) {
        provider = value
        presenter.drafts.provider = value
    }

    fun updateAssistantModel(value: String) {
        assistantModel = value
        presenter.drafts.assistantModel = value
    }

    fun updateProviderKey(value: String) {
        providerKey = value
        presenter.drafts.providerKey = value
    }

    fun updateAssistantKey(value: String) {
        assistantKey = value
        presenter.drafts.assistantKey = value
    }

    fun toggleOptions() {
        optionsExpanded = !optionsExpanded
        presenter.drafts.optionsExpanded = optionsExpanded
    }

    fun clearKeys() {
        providerKey = ""
        assistantKey = ""
    }
}

@Composable
private fun TranscriptOverflowMenu(
    presenter: TranscriptPresenter, snapshot: TranscriptSnapshot, page: TranscriptPageState, onExport: () -> Unit, onCopy: () -> Unit,
) {
    val enabled = TranscriptViewPolicy.menuEnabled(hasContent = snapshot.hasContent, canStop = snapshot.canStop,
        offersRecap = snapshot.offersRecapToChat)
    if (!enabled) return
    val scheme = MaterialTheme.colorScheme
    Box {
        IconButton(onClick = { page.menuOpen = true }, modifier = Modifier.testTag("transcript.menu")) {
            Icon(ConclaveIcons.MoreVertFill0, contentDescription = conclaveString("trn_more_actions"), tint = scheme.onSurfaceVariant)
        }
        DropdownMenu(expanded = page.menuOpen, onDismissRequest = { page.menuOpen = false }) {
            NativeSemanticsPopupRoot("transcript.menu")
            if (snapshot.hasContent) {
                DropdownMenuItem(
                    text = { ConclaveText(conclaveString("trn_export"), line = "transcript.menu.export") },
                    leadingIcon = { Icon(ConclaveIcons.ShareFill0, contentDescription = null, tint = scheme.onSurfaceVariant) },
                    onClick = {
                        page.menuOpen = false
                        onExport()
                    },
                    modifier = Modifier.testTag("transcript.menu.export"),
                )
                DropdownMenuItem(
                    text = { ConclaveText(conclaveString("trn_copy"), line = "transcript.menu.copy") },
                    leadingIcon = { Icon(ConclaveIcons.ContentCopyFill0, contentDescription = null, tint = scheme.onSurfaceVariant) },
                    onClick = {
                        page.menuOpen = false
                        onCopy()
                    },
                    modifier = Modifier.testTag("transcript.menu.copy"),
                )
            }
            if (snapshot.offersRecapToChat) {
                DropdownMenuItem(
                    text = { ConclaveText(conclaveString("trn_post_recap"), line = "transcript.menu.recap") },
                    leadingIcon = { Icon(ConclaveIcons.AutoAwesomeFill0, contentDescription = null, tint = scheme.onSurfaceVariant) },
                    enabled = snapshot.recap != RecapPhase.posting,
                    onClick = {
                        page.menuOpen = false
                        presenter.postRecapToChat()
                    },
                    modifier = Modifier.testTag("transcript.menu.recap"),
                )
            }
            if (snapshot.canStop) {
                DropdownMenuItem(
                    text = { ConclaveText(conclaveString("trn_stop_menu"), line = "transcript.menu.stop", color = scheme.error) },
                    leadingIcon = { Icon(ConclaveIcons.StopFill1, contentDescription = null, tint = scheme.error) },
                    enabled = !snapshot.controlsDisabled,
                    onClick = {
                        page.menuOpen = false
                        presenter.requestStop()
                    },
                    modifier = Modifier.testTag("transcript.menu.stop"),
                )
            }
        }
    }
}

@Composable
private fun TranscriptStopDialog(presenter: TranscriptPresenter) {
    val title = conclaveString("trn_stop_title")
    val message = conclaveString("trn_stop_message")
    val confirm = conclaveString("trn_stop_confirm")
    val model = remember(title, message, confirm) {
        ConclaveDialogModel(kind = ConclaveDialogKind.confirmation, title = title, message = message, confirmTitle = confirm,
            confirmRole = ConclaveDialogRole.destructive)
    }
    ConclaveDialog(model = model, identifier = "transcript.stopDialog", onConfirm = { presenter.confirmStop() },
        onDismiss = { presenter.cancelStop() })
}

@Composable
private fun TranscriptSessionHeader(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot, tab: TranscriptTab, page: TranscriptPageState) {
    val tabs = snapshot.tabs.toList()
    if (tabs.isNotEmpty()) {
        val options = tabs.map { ConclaveSegmentModel(id = it.rawValue, title = conclaveString(TranscriptCopy.tab(it)), isEnabled = true) }
        ConclaveTabSwitch(options = options, selectedId = tab.rawValue, identifier = "transcript.tabs",
            onSelect = { raw -> presenter.select(TranscriptTab.init(rawValue = raw) ?: TranscriptTab.transcript) })
    }
    TranscriptStatusRow(presenter, snapshot, page)
    TranscriptIssueBanner(presenter, snapshot)
    if (TranscriptDiagnostics.driver != null) {
        TranscriptFixtureBar()
    }
}

@Composable
private fun TranscriptStatusRow(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot, page: TranscriptPageState) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val statusName = TranscriptCopy.status(snapshot.status)
    val hostName = TranscriptCopy.host(snapshot.host)
    val hostText = when {
        hostName == null -> null
        snapshot.host == TranscriptHostKind.named -> conclaveString(hostName, snapshot.controllerName)
        else -> conclaveString(hostName)
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (snapshot.status) {
                TranscriptStatusKind.live -> Box(Modifier.size(8.dp).background(ext.live, CircleShape))
                TranscriptStatusKind.paused -> Box(Modifier.size(8.dp).background(ext.warning, CircleShape))
                TranscriptStatusKind.starting, TranscriptStatusKind.stopping, TranscriptStatusKind.reconnecting ->
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                else -> Unit
            }
            Row(Modifier.weight(1f).semantics(mergeDescendants = true) {}.testTag("transcript.status"),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (statusName != null) {
                    ConclaveText(conclaveString(statusName), line = "transcript.status.text", style = MaterialTheme.typography.titleSmall)
                }
                if (hostText != null) {
                    ConclaveText(hostText, line = "transcript.status.host", style = MaterialTheme.typography.bodyMedium,
                        color = scheme.onSurfaceVariant, maxLines = 2)
                }
            }
        }
        if (snapshot.canPause || snapshot.canStop || (snapshot.status == TranscriptStatusKind.ended && snapshot.offersStart)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                if (snapshot.status == TranscriptStatusKind.ended && snapshot.offersStart) {
                    val drafts = presenter.drafts
                    val ready = TranscriptKeyPolicy.hasRequiredKeys(provider = drafts.provider, keysKnown = snapshot.keysKnown,
                        openAICovered = snapshot.openAICovered, sarvamCovered = snapshot.sarvamCovered,
                        providerKey = drafts.providerKey, assistantKey = drafts.assistantKey)
                    ConclaveButton(title = conclaveString("trn_start"), role = ConclaveButtonRole.Primary,
                        identifier = "transcript.status.start", enabled = ready, onClick = {
                            presenter.start(options = TranscriptKeyPolicy.options(provider = drafts.provider,
                                assistantModel = drafts.assistantModel, openAICovered = snapshot.openAICovered,
                                sarvamCovered = snapshot.sarvamCovered, providerKey = drafts.providerKey,
                                assistantKey = drafts.assistantKey))
                            page.clearKeys()
                        })
                }
                if (snapshot.canPause) {
                    val paused = snapshot.phase == LiveNotesPhase.paused
                    OutlinedButton(
                        onClick = { if (paused) presenter.resume() else presenter.pause() },
                        enabled = !snapshot.controlsDisabled,
                        modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.status.pause"),
                    ) { ConclaveText(conclaveString(if (paused) "trn_resume" else "trn_pause"), line = "transcript.status.pause") }
                }
                if (snapshot.canStop) {
                    val stopLabel = conclaveString("trn_stop_confirm")
                    OutlinedButton(
                        onClick = { presenter.requestStop() },
                        enabled = !snapshot.controlsDisabled,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = scheme.error),
                        modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.status.stop")
                            .semantics { contentDescription = stopLabel },
                    ) { ConclaveText(conclaveString("trn_stop"), line = "transcript.status.stop") }
                }
            }
        }
    }
}

@Composable
private fun TranscriptIssueBanner(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot) {
    val tryAgain = conclaveString("ds_try_again")
    if (snapshot.stop == StopPhase.failed) {
        ConclaveBanner(kind = ConclaveBannerKind.Error, text = conclaveString("trn_issue_stop_failed"), identifier = "transcript.stopFailed",
            inCall = false, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            actions = listOf(ConclaveBannerAction(tryAgain, "transcript.stopFailed.retry") { presenter.confirmStop() }))
        return
    }
    if (snapshot.issue == TranscriptIssue.none) return
    val name = TranscriptCopy.issue(snapshot.issue)
    val text = if (name != null) conclaveString(name) else snapshot.issueServerText
    if (text.isEmpty()) return
    val actions = if (snapshot.issue == TranscriptIssue.relayFailed) {
        listOf(ConclaveBannerAction(tryAgain, "transcript.issue.retry") { presenter.retryConnection() })
    } else emptyList()
    ConclaveBanner(
        kind = if (snapshot.issue == TranscriptIssue.controlsReconnecting) ConclaveBannerKind.Reconnecting else ConclaveBannerKind.Warning,
        text = text, identifier = "transcript.issue", inCall = false, maxLines = 4, actions = actions,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun TranscriptStartCard(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot, page: TranscriptPageState, reservation: PaddingValues) {
    val scheme = MaterialTheme.colorScheme
    val typography = MaterialTheme.typography
    val coverage = TranscriptKeyPolicy.coverage(provider = page.provider, keysKnown = snapshot.keysKnown,
        openAICovered = snapshot.openAICovered, sarvamCovered = snapshot.sarvamCovered)
    val blurb = TranscriptViewPolicy.blurb(kind = snapshot.startKind, coverage = coverage, isViewOnly = snapshot.isViewOnly)
    val needsProviderKey = TranscriptKeyPolicy.needsProviderKey(provider = page.provider, openAICovered = snapshot.openAICovered,
        sarvamCovered = snapshot.sarvamCovered)
    val needsAssistantKey = TranscriptKeyPolicy.needsAssistantKey(provider = page.provider, openAICovered = snapshot.openAICovered)
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("transcript.startCard"),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp + reservation.calculateTopPadding(),
            bottom = 16.dp + reservation.calculateBottomPadding()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item(key = "header", contentType = "header") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ConclaveText(conclaveString(TranscriptCopy.startTitle(snapshot.startKind)), line = "transcript.startTitle",
                    style = typography.headlineSmall, modifier = Modifier.semantics { heading() })
                ConclaveText(conclaveString(TranscriptCopy.blurb(blurb)), line = "transcript.blurb", style = typography.bodyMedium,
                    color = scheme.onSurfaceVariant)
                if (snapshot.isViewOnly) TranscriptTag(conclaveString("trn_view_only"), "transcript.viewOnly")
            }
        }
        if (snapshot.offersStart) {
            item(key = "provider", contentType = "segmented") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ConclaveText(conclaveString("trn_provider"), line = "transcript.provider.label", style = typography.labelLarge,
                        color = scheme.onSurfaceVariant)
                    val options = TranscriptConfiguration.providers.toList().map {
                        ConclaveSegmentModel(id = it.rawValue, title = it.label, isEnabled = true)
                    }
                    ConclaveSegmentedRow(options = options, selectedId = page.provider.rawValue, identifier = "transcript.options.provider",
                        onSelect = { raw -> page.updateProvider(TranscriptProvider.init(rawValue = raw) ?: TranscriptProvider.openAI) },
                        fallback = ConclaveSegmentedFallback.menu)
                }
            }
            if (needsProviderKey) {
                item(key = "providerKey", contentType = "field") {
                    TranscriptKeyField(conclaveString("trn_provider_key", page.provider.label), page.providerKey,
                        { page.updateProviderKey(it) }, "transcript.options.providerKey")
                }
            }
            if (needsAssistantKey) {
                item(key = "assistantKey", contentType = "field") {
                    TranscriptKeyField(conclaveString("trn_assistant_key"), page.assistantKey, { page.updateAssistantKey(it) },
                        "transcript.options.assistantKey")
                }
            }
            item(key = "optionsToggle", contentType = "button") {
                TextButton(onClick = { page.toggleOptions() }, modifier = Modifier.heightIn(min = 48.dp).testTag("transcript.options")) {
                    ConclaveText(conclaveString(if (page.optionsExpanded) "trn_hide_options" else "trn_show_options"), line = "transcript.options")
                }
            }
            if (page.optionsExpanded) {
                item(key = "assistant", contentType = "listItem") {
                    val label = TranscriptConfiguration.assistantModels.toList().firstOrNull { it.id == page.assistantModel }?.label
                        ?: page.assistantModel
                    ListItem(
                        headlineContent = { ConclaveText(conclaveString("trn_assistant"), line = "transcript.assistant.label") },
                        supportingContent = { ConclaveText(label, line = "transcript.assistant.value", color = scheme.onSurfaceVariant) },
                        colors = ListItemDefaults.colors(containerColor = scheme.surface),
                        modifier = Modifier.testTag("transcript.options.assistant").semantics { role = Role.Button }
                            .clickable { page.modelDialogOpen = true },
                    )
                }
            }
            item(key = "coverage", contentType = "listItem") {
                ListItem(
                    leadingContent = {
                        if (coverage == KeyCoverage.unknown) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(if (coverage == KeyCoverage.covered) ConclaveIcons.CheckFill0 else ConclaveIcons.InfoFill0,
                                contentDescription = null, tint = scheme.onSurfaceVariant)
                        }
                    },
                    headlineContent = {
                        ConclaveText(conclaveString(TranscriptCopy.coverage(coverage)), line = "transcript.coverage",
                            style = typography.bodyMedium, color = scheme.onSurfaceVariant)
                    },
                    colors = ListItemDefaults.colors(containerColor = scheme.surface),
                    modifier = Modifier.semantics(mergeDescendants = true) {}.testTag("transcript.coverage"),
                )
            }
        }
    }
    if (page.modelDialogOpen) {
        TranscriptModelDialog(page)
    }
}

@Composable
private fun TranscriptModelDialog(page: TranscriptPageState) {
    AlertDialog(
        onDismissRequest = { page.modelDialogOpen = false },
        title = {
            NativeSemanticsPopupRoot("transcript.modelDialog")
            ConclaveText(conclaveString("trn_assistant"), line = "transcript.modelDialog.title")
        },
        text = {
            Column {
                for (model in TranscriptConfiguration.assistantModels.toList()) {
                    val selected = model.id == page.assistantModel
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) {
                            this.selected = selected
                            role = Role.RadioButton
                        }.clickable {
                            page.updateAssistantModel(model.id)
                            page.modelDialogOpen = false
                        }.testTag("transcript.modelDialog." + model.id),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = selected, onClick = null)
                        ConclaveText(model.label, line = "transcript.modelDialog." + model.id, modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { page.modelDialogOpen = false }) {
                ConclaveText(conclaveString("ds_cancel"), line = "transcript.modelDialog.cancel")
            }
        },
        modifier = Modifier.testTag("transcript.modelDialog"),
    )
}

@Composable
private fun TranscriptKeyField(label: String, value: String, onValueChange: (String) -> Unit, identifier: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth().testTag(identifier),
        label = { ConclaveText(label, line = "$identifier.label") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
            keyboardType = KeyboardType.Password),
    )
}

@Composable
private fun TranscriptTag(text: String, identifier: String) {
    val scheme = MaterialTheme.colorScheme
    Surface(color = scheme.surfaceContainerHighest, contentColor = scheme.onSurfaceVariant, shape = CircleShape,
        modifier = Modifier.testTag(identifier)) {
        ConclaveText(text, line = identifier, style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

@Composable
private fun TranscriptStartBar(presenter: TranscriptPresenter, snapshot: TranscriptSnapshot, page: TranscriptPageState) {
    val ready = TranscriptKeyPolicy.hasRequiredKeys(provider = page.provider, keysKnown = snapshot.keysKnown,
        openAICovered = snapshot.openAICovered, sarvamCovered = snapshot.sarvamCovered, providerKey = page.providerKey,
        assistantKey = page.assistantKey)
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        ConclaveButton(
            title = conclaveString(TranscriptCopy.startButton(snapshot.startKind)),
            role = ConclaveButtonRole.Primary,
            identifier = "transcript.start",
            enabled = ready,
            onClick = {
                val options = TranscriptKeyPolicy.options(provider = page.provider, assistantModel = page.assistantModel,
                    openAICovered = snapshot.openAICovered, sarvamCovered = snapshot.sarvamCovered, providerKey = page.providerKey,
                    assistantKey = page.assistantKey)
                if (presenter.start(options = options)) page.clearKeys()
            },
        )
    }
}

@Composable
private fun TranscriptAnnouncementRegion(presenter: TranscriptPresenter) {
    val announcement = presenter.announcement ?: return
    val name = TranscriptCopy.announcement(announcement.kind) ?: return
    val text = conclaveString(name)
    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = text
    })
}

@Composable
private fun TranscriptFinalizedRegion(feed: TranscriptFeed) {
    var spoken by remember { mutableStateOf("") }
    var lastSpokenAt by remember { mutableStateOf(0L) }
    val line = feed.finalized
    val speaker = if (line.speakerName.isEmpty()) conclaveString("trn_speaker") else line.speakerName
    LaunchedEffect(line.serial) {
        if (line.serial <= 0 || line.text.isEmpty()) return@LaunchedEffect
        val wait = 2_000L - (System.currentTimeMillis() - lastSpokenAt)
        if (wait > 0) delay(wait)
        lastSpokenAt = System.currentTimeMillis()
        spoken = speaker + ": " + line.text
    }
    if (spoken.isEmpty()) return
    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = spoken
    })
}

@Composable
private fun TranscriptFixtureBar() {
    var refresh by remember { mutableStateOf(0) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (script in TranscriptFixtureScriptName.allCases) {
                TextButton(onClick = {
                    TranscriptDiagnostics.driver?.run(script)
                    refresh += 1
                }, modifier = Modifier.testTag("transcript.fixture." + script.rawValue)) {
                    ConclaveText(script.rawValue, line = "transcript.fixture." + script.rawValue, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        val readout = TranscriptDiagnostics.readout() + (if (refresh >= 0) "" else "")
        ConclaveText(readout, line = "transcript.calls", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("transcript.calls"))
    }
}
