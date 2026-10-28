package conclave.module

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * S60 4 d (SET-6) on Android: MeetingPanel.effects in the in-call theme. In compact and medium windows it ships as the
 * WP1-3c in-call bottom sheet (NativePanelHost + LayoutSheetHost, opening expanded at its content height). Because a
 * modal sheet dims the stage and has no background interaction, the sheet carries its own preview (Meet pattern, AAPPS
 * 6.15): a 3:4 card 200 dp tall bound to your local track (camera on) or the C6-8 local-only preview (after "Preview my
 * camera"), never a stage renderer moved, at most one per presentation (4 k). Then the PrimaryTabRow (Backgrounds,
 * Filters, Appearance) and one LazyVerticalGrid of 72 dp tiles (Blur, Backgrounds, Personal with Add photo), the
 * Appearance switches (Android keeps the app effects; there are no system effects here, OQ6 default A) and the
 * publish-cap footer; the header holds "Remove all" while anything is applied. The expanded side pane hosts the same
 * grid in an InCallPage. Hidden until an engine publishes `.panel` (OQ6 default A). `EffectsLobbySheet` presents the
 * same content over the lobby (RECONCILE R31) through the same sheet host.
 */

@Composable
internal fun EffectsPage(
    effects: EffectsPresenter,
    variant: InCallPageVariant,
    appearance: PanelAppearance,
    miniTile: CallMiniTileModel?,
    onClose: () -> Unit,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
    miniTileVideo: (@Composable () -> Unit)? = null,
    preview: @Composable (EffectsSnapshot) -> Unit,
) {
    val title = conclaveString("fx_title")
    DisposableEffect(Unit) {
        effects.panelDidOpen()
        onDispose { effects.panelDidClose() }
    }
    if (variant == InCallPageVariant.Sheet) {
        // The sheet variant: the host's ModalBottomSheet frames it; the page acknowledges when it disposes (C3).
        DisposableEffect(Unit) {
            onMounted()
            onDispose { onDisposed() }
        }
        Column(Modifier.fillMaxWidth().testTag("effects.sheet").semantics { paneTitle = title }) {
            EffectsGrid(effects, title, showsHeader = true, contentPadding = PaddingValues(bottom = 16.dp),
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow, preview = preview)
        }
        return
    }
    val snapshot = effects.snapshot
    InCallPage(
        title = title,
        variant = variant,
        appearance = appearance,
        hasComposer = false,
        miniTile = miniTile,
        onClose = onClose,
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        contentMode = InCallPageContent.lazyList,
        actions = {
            if (!snapshot.active.isEmpty) {
                ConclaveButton(conclaveString("fx_remove_all"), ConclaveButtonRole.Text, "effects.removeAll", onClick = { effects.clearAll() })
            }
        },
    ) { reservation ->
        EffectsGrid(effects, title, showsHeader = false, contentPadding = reservation,
            containerColor = MaterialTheme.colorScheme.surface, preview = preview)
    }
}

/**
 * RECONCILE R31, S60 4 a: the Effects content as an in-call sheet over the lobby. Choices apply to the lobby preview
 * through the one LocalPreviewController (nothing is published) and persist into the call. The lobby presents it (HD
 * request B7-T2 R7); `onClosed` runs after the sheet's hide completes and its content disposed.
 */
@Composable
internal fun EffectsLobbySheet(effects: EffectsPresenter, onClosed: () -> Unit, preview: @Composable (EffectsSnapshot) -> Unit) {
    var dismissing by remember { mutableStateOf(false) }
    LayoutSheetHost(
        dismissing = dismissing,
        skipPartiallyExpanded = true,
        inCallAppearance = true,
        onDismissRequest = { dismissing = true },
    ) {
        val title = conclaveString("fx_title")
        DisposableEffect(Unit) {
            effects.panelDidOpen()
            onDispose {
                effects.panelDidClose()
                onClosed()
            }
        }
        Column(Modifier.fillMaxWidth().testTag("effects.lobbySheet").semantics { paneTitle = title }) {
            EffectsGrid(effects, title, showsHeader = true, contentPadding = PaddingValues(bottom = 16.dp),
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow, preview = preview)
        }
    }
}

/** The one grid both hosts draw. Reads only `effects.snapshot` (4 k). */
@Composable
internal fun EffectsGrid(
    effects: EffectsPresenter,
    title: String,
    showsHeader: Boolean,
    contentPadding: PaddingValues,
    containerColor: Color,
    preview: @Composable (EffectsSnapshot) -> Unit,
) {
    val snapshot = effects.snapshot
    val haptics = rememberConclaveHaptics()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableStateOf(EffectsCatalog.backgrounds) }
    var replacingId by remember { mutableStateOf("") }
    // 4 j: the system photo picker; the URI becomes a stored JPEG off the main thread; cancelling changes nothing.
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val replacing = replacingId
        replacingId = ""
        if (uri != null) {
            val fileName = effects.nextPersonalFileName(nowMillis = System.currentTimeMillis().toDouble())
            val count = effects.snapshot.personalCount - (if (replacing.isEmpty()) 0 else 1)
            scope.launch {
                val issue = EffectsPhotoStore.store(context, uri, fileName, count)
                if (issue != EffectsIssue.none) {
                    effects.personalImageFailed(issue)
                } else {
                    if (replacing.isNotEmpty()) {
                        effects.removePersonalImage(id = replacing)
                        EffectsPhotoStore.remove(context, EffectsImagePolicy.fileName(fromPersonalId = replacing))
                    }
                    effects.personalImageImported(fileName = fileName)
                }
            }
        }
    }
    val launchPicker = { pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
    val select: (EffectItem) -> Unit = { item ->
        if (effects.select(id = item.id) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.selectionChanged)
    }
    val tabOptions = mutableListOf<ConclaveSegmentModel>()
    for (shown in snapshot.tabs) {
        tabOptions.add(ConclaveSegmentModel(id = shown.id, title = conclaveString(EffectsCopy.tabName(shown.id)), isEnabled = true))
    }
    val items = mutableListOf<EffectItem>()
    val shownTab = snapshot.tab(tab)
    if (shownTab != null) {
        for (effect in shownTab.items) items.add(effect)
    }
    val titles = HashMap<String, String>()
    for (effect in items) titles[effect.id] = effectTitle(effect)
    val sections = effectSections(tab, items)
    val sectionTitles = HashMap<String, String>()
    for (section in sections) sectionTitles[section.id] = conclaveString(section.titleName)
    LazyVerticalGrid(
        columns = GridCells.Adaptive(EffectTileMetrics.TILE_DP.dp),
        modifier = Modifier.fillMaxWidth().testTag("effects.grid").selectableGroup(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = contentPadding.calculateTopPadding(),
            bottom = contentPadding.calculateBottomPadding()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (showsHeader) {
            fullSpan("header") { EffectsHeader(effects, snapshot, title) }
        }
        fullSpan("status") { EffectsStatus(effects, snapshot) }
        fullSpan("preview") { EffectsPreviewCard(snapshot, preview) }
        fullSpan("tabs") {
            ConclaveTabSwitch(options = tabOptions, selectedId = tab, identifier = "effects.tabs", onSelect = { tab = it })
        }
        if (tab == EffectsCatalog.appearance) {
            fullSpan("appearance") { EffectsAppearanceRows(effects, snapshot, containerColor) }
        } else {
            for (section in sections) {
                if (sections.size > 1) {
                    fullSpan("section.${section.id}") {
                        ConclaveSectionHeader(sectionTitles[section.id] ?: "", "effects.section.${section.id}")
                    }
                }
                for (effect in section.items) {
                    item(key = effect.id) {
                        val personal = effect.kind == EffectKind.personal
                        EffectTile(
                            item = effect,
                            title = titles[effect.id] ?: effect.id,
                            enabled = snapshot.tilesEnabled,
                            onSelect = { select(effect) },
                            onChangeImage = if (personal) { { replacingId = effect.id; launchPicker() } } else null,
                            onRemoveImage = if (personal) {
                                {
                                    effects.removePersonalImage(id = effect.id)
                                    EffectsPhotoStore.remove(context, effect.assetName)
                                }
                            } else null,
                        )
                    }
                }
                if (section.id == "personal") {
                    item(key = "addPhoto") {
                        EffectAddPhotoTile(enabled = snapshot.canAddPersonalImage && snapshot.tilesEnabled, onClick = {
                            if (effects.canBeginAddingPersonalImage()) launchPicker()
                        })
                    }
                }
            }
            if (tab == EffectsCatalog.backgrounds && !snapshot.canAddPersonalImage) {
                fullSpan("limit") { ConclaveSectionFooter(conclaveString("fx_err_limit"), "effects.limit") }
            }
        }
        if (snapshot.showsPublishCap) {
            fullSpan("publishCap") { ConclaveSectionFooter(conclaveString("fx_publish_cap"), "effects.publishCap") }
        }
    }
}

private fun LazyGridScope.fullSpan(key: String, content: @Composable () -> Unit) {
    item(key = key, span = { GridItemSpan(maxLineSpan) }) { content() }
}

/** One grid section of the shown tab (4 d): Backgrounds splits into Blur, Backgrounds and Personal. */
internal data class EffectSection(val id: String, val titleName: String, val items: List<EffectItem>)

internal fun effectSections(tab: String, items: List<EffectItem>): List<EffectSection> {
    if (tab != EffectsCatalog.backgrounds) return listOf(EffectSection(tab, EffectsCopy.tabName(tab), items))
    val blur = items.filter { it.kind == EffectKind.none || it.kind == EffectKind.blur }
    val images = items.filter { it.kind == EffectKind.image }
    val personal = items.filter { it.kind == EffectKind.personal }
    val result = mutableListOf(EffectSection("blur", EffectsCopy.sectionName(EffectKind.blur), blur))
    if (images.isNotEmpty()) result.add(EffectSection("images", EffectsCopy.sectionName(EffectKind.image), images))
    result.add(EffectSection("personal", EffectsCopy.sectionName(EffectKind.personal), personal))
    return result
}

@Composable
private fun effectTitle(item: EffectItem): String {
    if (item.kind == EffectKind.personal) return conclaveString("fx_personal_image", item.personalIndex + 1)
    val name = EffectsCopy.itemName(item.id) ?: return item.id
    return conclaveString(name)
}

/** The sheet header (4 d): the title and "Remove all" while anything is applied (no haptic, 4 h). */
@Composable
private fun EffectsHeader(effects: EffectsPresenter, snapshot: EffectsSnapshot, title: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        ConclaveText(title, line = "effects.title", style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.weight(1f).testTag("panel.title").semantics { heading() })
        if (!snapshot.active.isEmpty) {
            ConclaveButton(conclaveString("fx_remove_all"), ConclaveButtonRole.Text, "effects.removeAll", onClick = { effects.clearAll() })
        }
    }
}

/** Preparing, the camera line with Preview and Turn on for everyone, the blocked camera's settings and the issue row. */
@Composable
private fun EffectsStatus(effects: EffectsPresenter, snapshot: EffectsSnapshot) {
    val scheme = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (snapshot.isPreparing) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.testTag("effects.preparing").semantics(mergeDescendants = true) {}) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                ConclaveText(conclaveString("fx_preparing"), line = "effects.preparing")
            }
        }
        val cameraName = EffectsCopy.cameraName(snapshot.camera)
        if (cameraName != null) {
            ConclaveText(conclaveString(cameraName), line = "effects.camera", color = scheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("effects.camera"))
        }
        if (snapshot.camera == EffectsCameraState.off) {
            val previewing = snapshot.preview == PreviewState.live || snapshot.preview == PreviewState.starting
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ConclaveButton(conclaveString(if (previewing) "fx_stop_preview" else "fx_preview"), ConclaveButtonRole.Tonal,
                    "effects.preview", onClick = { if (previewing) effects.stopPreview() else effects.startPreview() })
                if (snapshot.canTurnCameraOn) {
                    ConclaveButton(conclaveString("fx_turn_on_everyone"), ConclaveButtonRole.Primary, "effects.turnOn",
                        onClick = { effects.turnCameraOnForEveryone() })
                }
            }
        }
        if (snapshot.camera == EffectsCameraState.blocked) {
            ConclaveButton(conclaveString("ds_open_settings"), ConclaveButtonRole.Text, "effects.openSettings",
                onClick = { effects.openCameraSettings() })
        }
        val issueName = EffectsCopy.issueName(snapshot.issue)
        if (issueName != null) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("effects.issue")) {
                ConclaveText(conclaveString(issueName), line = "effects.issue", color = scheme.error,
                    style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                IconButton(onClick = { effects.dismissIssue() }) {
                    Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("ds_close"), tint = scheme.onSurfaceVariant)
                }
            }
        }
    }
}

/**
 * The in-sheet preview (4 d, k): 3:4, 200 dp tall, centered. The slot draws the local track or the local-only preview;
 * the card labels the preview "Only visible to you" and an interrupted camera "Camera paused" (4 l9).
 */
@Composable
private fun EffectsPreviewCard(snapshot: EffectsSnapshot, preview: @Composable (EffectsSnapshot) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val previewing = snapshot.camera == EffectsCameraState.off &&
        (snapshot.preview == PreviewState.live || snapshot.preview == PreviewState.starting)
    val shows = snapshot.camera == EffectsCameraState.on || previewing
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Box(
            Modifier.height(200.dp).aspectRatio(3f / 4f).clip(MaterialTheme.shapes.large).background(scheme.surfaceContainerHigh)
                .testTag("effects.previewCard"),
            contentAlignment = Alignment.BottomCenter,
        ) {
            if (shows) {
                Box(Modifier.fillMaxSize()) { preview(snapshot) }
            }
            val label = when {
                snapshot.camera == EffectsCameraState.interrupted -> conclaveString("stg_camera_paused")
                previewing -> conclaveString("fx_only_you")
                else -> null
            }
            if (label != null) {
                ConclaveText(label, line = "effects.previewCard.label", style = MaterialTheme.typography.labelMedium,
                    color = scheme.onSurface,
                    modifier = Modifier.padding(8.dp).clip(CircleShape).background(ext.labelScrim)
                        .padding(horizontal = 10.dp, vertical = 4.dp))
            }
        }
    }
}

/** The Appearance switches (4 d): Studio lighting, Studio look and Framing with Recenter; no haptic (D8). */
@Composable
private fun EffectsAppearanceRows(effects: EffectsPresenter, snapshot: EffectsSnapshot, containerColor: Color) {
    val items = snapshot.tab(EffectsCatalog.appearance)?.items
    Column(Modifier.fillMaxWidth()) {
        if (items != null) {
            for (item in items) {
                val name = EffectsCopy.itemName(item.id)
                ListItem(
                    headlineContent = { ConclaveText(if (name != null) conclaveString(name) else item.id, line = "effects.appearance.${item.id}") },
                    supportingContent = {
                        ConclaveText(conclaveString(EffectsCopy.appearanceDetailName(item.id)), line = "effects.appearance.${item.id}.detail")
                    },
                    trailingContent = { Switch(checked = item.isSelected, onCheckedChange = null, enabled = snapshot.tilesEnabled) },
                    colors = ListItemDefaults.colors(containerColor = containerColor),
                    modifier = Modifier.heightIn(min = 56.dp).testTag("effects.appearance.${item.id}")
                        .toggleable(value = item.isSelected, enabled = snapshot.tilesEnabled, role = Role.Switch,
                            onValueChange = { on -> effects.setAppearance(id = item.id, isOn = on) }),
                )
            }
        }
        var framingOn = false
        if (items != null) {
            for (row in items) {
                if (row.id == EffectsCatalog.framing && row.isSelected) framingOn = true
            }
        }
        ConclaveButton(conclaveString("fx_recenter"), ConclaveButtonRole.Text, "effects.recenter",
            onClick = { effects.recenter() }, enabled = snapshot.tilesEnabled && framingOn)
    }
}
