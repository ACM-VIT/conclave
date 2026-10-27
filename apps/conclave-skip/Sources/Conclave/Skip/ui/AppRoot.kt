package conclave.module

import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import java.util.UUID

/**
 * Whether an in-call strip reaches the bottom edge behind the navigation bar. In this fixture the stage strip
 * sits above a system-surface navigation inset (A11), so the navigation bar keeps the system scheme.
 */
private const val NATIVE_HOSTING_STRIP_REACHES_BOTTOM_EDGE = false

/** Called only by MainActivity's explicit debug launch route, outside SkipUI PresentationRoot. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun NativeHostingPreviewRoot(fixtureEligible: Boolean = false, onClose: () -> Unit) {
    val iconContext = LocalContext.current.applicationContext
    val iconScope = rememberCoroutineScope()
    val icons = remember(iconContext, iconScope) { NativeIconRasterController(iconContext, iconScope) }
    val presenter = remember { NativeHostingPresenter() }
    // Intentionally inert: the real mapper runs, but this sink never invokes hardware.
    val delivery = remember(presenter) { NativeFeedbackDelivery(presenter, sink = {}) }
    val lifetime = remember(presenter) { NativePanelOverlayLifetime(presenter.panels) }
    val stageLifetime = remember { NativeHostingStageLifetime() }
    val focus = remember { PanelInvokerFocus() }
    val readout = remember { PanelHostReadout() }
    var mount by remember { mutableIntStateOf(0) }
    val exporter = remember(iconContext) { NativeSemanticsExporter(iconContext) }
    val panelState = presenter.panels.snapshot
    val systemDark = isSystemInDarkTheme()
    NativeSemanticsExportReceiver(exporter)
    NativeIconRasterBinding(icons, fixtureEligible && panelState.current == null)
    key(mount) { NativeFeedbackConsumer(presenter, delivery, mount) }
    // Closes the preview only while no panel is current; the panel host's back handler, registered later,
    // closes an open panel first (PS 8.5).
    BackHandler(enabled = panelState.current == null) {
        icons.cancel("preview Back")
        onClose()
    }
    CompositionLocalProvider(LocalRendererLedger provides presenter.renderers) {
        // Debug-only route: uiautomator dumps expose test tags as resource IDs (PS 8.9).
        Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
            NativePanelHost(
                panels = presenter.panels,
                lifetime = lifetime,
                focus = focus,
                readout = readout,
                systemBars = { inputs ->
                    // The one system-bar owner here: a system-themed root plus the host's overlay inputs (PS 8.7).
                    ConclaveSystemBars(SystemBarPolicy.resolve(rootDark = systemDark, overlayVisible = inputs.overlayVisible,
                        overlayInCall = inputs.overlayInCall, bottomStripInCall = NATIVE_HOSTING_STRIP_REACHES_BOTTOM_EDGE,
                        systemDark = systemDark))
                },
                stage = { _ ->
                    NativeHostingStage(presenter, delivery, stageLifetime, focus, readout,
                        onRemount = { mount++ }, onClose = { icons.cancel("preview Close"); onClose() }, icons = icons,
                        exporter = exporter)
                },
                panel = { session, request, decision, variant ->
                    NativeHostingPanel(presenter, delivery, readout, session, request, decision, variant,
                        onMounted = { readout.mounted(); lifetime.mounted(session, request.presentationID) },
                        onDisposed = { readout.disposed(); lifetime.disposed(session, request.presentationID) })
                },
            )
        }
    }
}

/** One monotonic clock for the diagnostic open timer. */
private fun hostingUptime(): Double = SystemClock.uptimeMillis() / 1000.0

/**
 * The retained call root of the fixture: the controls list, then the stage strip as a fixed sibling below it,
 * never a lazy-list item, so no scroll can dispose and recreate the stage (PS 8.3, the Android form of L1).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NativeHostingStage(
    presenter: NativeHostingPresenter, delivery: NativeFeedbackDelivery,
    lifetime: NativeHostingStageLifetime, focus: PanelInvokerFocus, readout: PanelHostReadout,
    onRemount: () -> Unit, onClose: () -> Unit,
    icons: NativeIconRasterController, exporter: NativeSemanticsExporter,
) {
    var componentsExpanded by rememberSaveable { mutableStateOf(false) }
    val gallery = rememberNativeComponentGalleryState()
    val cache = remember(presenter) { NativeHostingRowsCache(presenter) }
    val rows = cache.current()
    val showsDetails = presenter.showsDetails
    HostingTheme {
        Column(Modifier.fillMaxSize()) {
            Scaffold(
                modifier = Modifier.weight(1f),
                // The bottom inset belongs to the strips below, not to the controls list.
                contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
                topBar = {
                    TopAppBar(
                        title = { Text("Hosting preview") },
                        actions = {
                            TextButton(onClick = onClose, modifier = Modifier.testTag("hosting.close")) {
                                Text("Close")
                            }
                        },
                    )
                },
            ) { insets ->
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(insets),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item(key = "introduction") {
                        Text(
                            "Sample people for the native hosting preview. Changes stay in this preview.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    item(key = "panels") {
                        Column {
                            TextButton(onClick = {
                                focus.invoked("panel.open.participants")
                                presenter.presentPanel(MeetingPanel.participants, from = PanelInvoker.call, at = hostingUptime())
                            }, modifier = Modifier.testTag("panel.open.participants")
                                .panelInvoker(focus, "panel.open.participants")) { Text("Participants panel") }
                            TextButton(onClick = {
                                focus.invoked("panel.open.settings")
                                presenter.presentPanel(MeetingPanel.settings, from = PanelInvoker.settings, at = hostingUptime())
                            }, modifier = Modifier.testTag("panel.open.settings")
                                .panelInvoker(focus, "panel.open.settings")) { Text("Settings panel") }
                            TextButton(onClick = {
                                focus.invoked("panel.open.layout")
                                presenter.presentPanel(MeetingPanel.layout, from = PanelInvoker.call, at = hostingUptime())
                            }, modifier = Modifier.testTag("panel.open.layout")
                                .panelInvoker(focus, "panel.open.layout")) { Text(conclaveString("native_panel_open_layout")) }
                            TextButton(onClick = {
                                focus.invoked("panel.rapid")
                                rapidPanels(presenter)
                            }, modifier = Modifier.testTag("panel.rapid")
                                .panelInvoker(focus, "panel.rapid")) { Text("Rapid replacement") }
                        }
                    }
                    item(key = "readouts") { NativeHostingReadouts(presenter, readout) }
                    item(key = "feedback") {
                        val state = presenter.feedbackState
                        Column {
                            Text("Session ${state.session}; outcomes ${state.acceptedCount}; sequence ${state.token.sequence}; intended ${delivery.intendedCount}; ${delivery.lastKind}",
                                modifier = Modifier.testTag("feedback.status"))
                            Text("Silent fixture. No call, audio or vibration.")
                            TextButton(onClick = { presenter.completeNextFixtureAction() }, modifier = Modifier.testTag("feedback.complete")) { Text("Complete outcome") }
                            TextButton(onClick = { presenter.repeatLastFixtureCompletion() }, modifier = Modifier.testTag("feedback.duplicate")) { Text("Repeat completion") }
                            TextButton(onClick = { delivery.gesture() }, modifier = Modifier.testTag("feedback.gesture")) { Text("Selection gesture") }
                            TextButton(onClick = { delivery.updateSuspended(!delivery.suspended) }, modifier = Modifier.testTag("feedback.suspend")) { Text(if (delivery.suspended) "Resume feedback" else "Simulate background or PiP") }
                            TextButton(onClick = {
                                delivery.updateSuspended(true)
                                presenter.completeNextFixtureAction()
                                delivery.updateSuspended(false)
                            }, modifier = Modifier.testTag("feedback.coalesced")) { Text("Pause, outcome, resume") }
                            TextButton(onClick = onRemount, modifier = Modifier.testTag("feedback.remount")) { Text("Remount consumer") }
                            TextButton(onClick = { presenter.resetFixtureSession() }, modifier = Modifier.testTag("fixture.resetSession")) { Text("Reset session") }
                        }
                    }
                    // WP2-S2b Debug session readout (S1C Q8, OWNER-DEFAULTS Q16).
                    item(key = "session") { SessionReadoutSection(MeetingViewModel.shared.shell, FeedbackDeliveryRecords.shared) }
                    item(key = "icons") { NativeHostingIconSection(icons) }
                    item(key = "components.toggle") {
                        NativeComponentGalleryToggle(componentsExpanded) { componentsExpanded = it }
                    }
                    nativeComponentGalleryItems(componentsExpanded, gallery)
                    item(key = "semantics.export") { NativeSemanticsExportControls(exporter) }
                    item(key = "details") {
                        Row(
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                .testTag("hosting.details")
                                .toggleable(value = showsDetails, role = Role.Switch,
                                    onValueChange = { presenter.setDetailsVisible(it) }),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            Text("Show details", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                            Switch(checked = showsDetails, onCheckedChange = null)
                        }
                    }
                    item(key = "people-heading") {
                        HorizontalDivider()
                        Text("People", modifier = Modifier.padding(top = 16.dp).semantics { heading() },
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    items(count = rows.size, key = { rows[it].id }) { index ->
                        val row = rows[index]
                        NativeHostingPersonRow(row = row, showsDetails = showsDetails,
                            onSelection = { presenter.setRowSelected(id = row.id, selected = it) })
                    }
                    item(key = "selection") {
                        Text("Selected: ${rows.selectedCount}",
                            modifier = Modifier.testTag("hosting.selectedCount"),
                            style = MaterialTheme.typography.bodyLarge)
                    }
                    item(key = "reset") {
                        Button(
                            onClick = { presenter.resetSelection() },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("hosting.reset"),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.primaryContainer,
                                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                            ),
                        ) { Text("Reset selection") }
                    }
                }
            }
            NativeHostingStageStrip(rows, lifetime)
            // A system-surface strip behind the navigation bar, so the bar keeps the system scheme while the
            // stage strip above it stays dark (A11).
            Spacer(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)
                .windowInsetsBottomHeight(WindowInsets.navigationBars))
        }
    }
}

/**
 * The inert stage strip: the original stage line plus one tile per row, each over a renderer probe, in the
 * in-call theme. Tiles take only their row, so a row mutation recomposes its own tile and nothing else.
 */
@Composable
private fun NativeHostingStageStrip(rows: NativeHostingRows, lifetime: NativeHostingStageLifetime) {
    val instance = remember { lifetime.create() }
    // The system surface fills the horizontal safe-drawing insets, so in landscape the dark stage never reaches
    // under a side navigation bar, whose icons follow the system scheme (A11).
    Box(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
    ) {
        HostingTheme(inCall = true) {
            Column(
                Modifier.fillMaxWidth().background(Color(DesignTokens.androidExtendedStage))
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Inert stage $instance; instances ${lifetime.creations}",
                    color = Color(DesignTokens.paper), modifier = Modifier.testTag("fixture.stage"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (index in 0 until rows.size) {
                        val row = rows[index]
                        key(row.id) { NativeHostingStageTile(row, Modifier.weight(1f)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun NativeHostingStageTile(row: NativeHostingPerson, modifier: Modifier = Modifier) {
    val ledger = LocalRendererLedger.current
    // Diagnostic composition counter (P1 item 5); never part of identity.
    SideEffect { ledger?.composed(key = row.id) }
    Box(
        modifier.height(96.dp)
            .clip(RoundedCornerShape(DesignTokens.radiusTile.dp))
            .background(Color(DesignTokens.androidExtendedTile))
            .testTag("stage.tile.${row.id}")
            .semantics(mergeDescendants = true) { stateDescription = if (row.isSelected) "Selected" else "Not selected" },
        contentAlignment = Alignment.BottomStart,
    ) {
        RendererProbe(key = row.id, slot = RendererSlot.stage, modifier = Modifier.fillMaxSize())
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.name, color = Color(DesignTokens.paper), style = MaterialTheme.typography.labelLarge)
            if (row.isSelected) {
                Icon(ConclaveIcons.CheckFill0, contentDescription = null, tint = Color(DesignTokens.paper),
                    modifier = Modifier.size(16.dp))
            }
        }
    }
}

/**
 * Readouts live in the controls list, never in the stage. `panel.style` follows the host; the renderer ledger,
 * tile compositions (P1 item 5), mount counters and open timer are not observable, so they are read after the
 * first frame and on Refresh.
 */
@Composable
private fun NativeHostingReadouts(presenter: NativeHostingPresenter, readout: PanelHostReadout) {
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        withFrameNanos { }
        refresh++
    }
    val renderers = remember(refresh) { presenter.renderers.summary() }
    val compositions = remember(refresh) { presenter.renderers.compositionSummary() }
    val mounts = remember(refresh) { readout.mountsSummary() }
    val latency = remember(refresh) { "open " + presenter.openTimer.summary() }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(readout.style, modifier = Modifier.testTag("panel.style"), style = MaterialTheme.typography.bodySmall)
        Text(renderers, modifier = Modifier.testTag("stage.renderers"), style = MaterialTheme.typography.bodySmall)
        Text(compositions, modifier = Modifier.testTag("stage.compositions"), style = MaterialTheme.typography.bodySmall)
        Text(mounts, modifier = Modifier.testTag("panel.mounts"), style = MaterialTheme.typography.bodySmall)
        Text(latency, modifier = Modifier.testTag("panel.openLatency"), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { refresh++ }, modifier = Modifier.testTag("stage.renderers.refresh")) {
            Text(conclaveString("native_panel_refresh_readouts"))
        }
    }
}

/**
 * Debug readouts inside the panel (review m1): the full overlay covers the root readouts and hides them from
 * accessibility while it is open. The style follows the host live; the renderer ledger and tile compositions are
 * read after the panel's first frame and on Refresh. Machine-read, so the values are not localized.
 */
@Composable
private fun NativeHostingPanelReadouts(presenter: NativeHostingPresenter, delivery: NativeFeedbackDelivery, readout: PanelHostReadout) {
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        withFrameNanos { }
        refresh++
    }
    val renderers = remember(refresh) { presenter.renderers.summary() }
    val compositions = remember(refresh) { presenter.renderers.compositionSummary() }
    val state = presenter.feedbackState
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(readout.style, modifier = Modifier.testTag("panel.readout.style"), style = MaterialTheme.typography.bodySmall)
        Text(renderers, modifier = Modifier.testTag("panel.readout.renderers"), style = MaterialTheme.typography.bodySmall)
        Text(compositions, modifier = Modifier.testTag("panel.readout.compositions"), style = MaterialTheme.typography.bodySmall)
        Text("Session ${state.session}; outcomes ${state.acceptedCount}; sequence ${state.token.sequence}; intended ${delivery.intendedCount}; ${delivery.lastKind}",
            modifier = Modifier.testTag("panel.readout.feedback"), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { refresh++ }, modifier = Modifier.testTag("panel.readout.refresh")) {
            Text(conclaveString("native_panel_refresh_readouts"))
        }
    }
}

@Composable
private fun NativeHostingPersonRow(row: NativeHostingPerson, showsDetails: Boolean, onSelection: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .testTag("hosting.person.${row.id}")
            .toggleable(value = row.isSelected, role = Role.Checkbox, onValueChange = onSelection)
            .semantics { stateDescription = if (row.isSelected) "Selected" else "Not selected" }
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.name, style = MaterialTheme.typography.bodyLarge)
            if (showsDetails) {
                Text(row.detail, style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Checkbox(checked = row.isSelected, onCheckedChange = null)
    }
}

/**
 * Rapid Replacement goes through the timed path, so the panel it ends on reports its open latency (review
 * ISSUE 6); the presenter drops the start of the presentation it supersedes.
 */
private fun rapidPanels(presenter: NativeHostingPresenter) {
    val now = hostingUptime()
    presenter.presentPanel(MeetingPanel.participants, from = PanelInvoker.call, at = now)
    presenter.presentPanel(MeetingPanel.settings, from = PanelInvoker.settings, at = now)
    presenter.presentPanel(MeetingPanel.participants, from = PanelInvoker.more, at = now)
}

/** Layout panel options with their string resources, written out so every resource name stays greppable. */
private val NativeHostingLayoutOptions = listOf(
    "grid" to "native_panel_layout_grid",
    "spotlight" to "native_panel_layout_spotlight",
    "sidebar" to "native_panel_layout_sidebar",
)

@Composable
private fun NativeHostingPanel(
    presenter: NativeHostingPresenter, delivery: NativeFeedbackDelivery, readout: PanelHostReadout, session: Int,
    request: PanelRequest, decision: PanelHostDecision, variant: InCallPageVariant, onMounted: () -> Unit,
    onDisposed: () -> Unit,
) {
    val cache = remember(presenter) { NativeHostingRowsCache(presenter) }
    val rows = cache.current()
    var text by remember { mutableStateOf("") }
    val settings = request.panel == MeetingPanel.settings
    val layout = request.panel == MeetingPanel.layout
    LaunchedEffect(request.presentationID) {
        withFrameNanos { }
        presenter.openTimer.firstFrame(presentationID = request.presentationID, at = hostingUptime())
    }
    val title = when {
        settings -> conclaveString("native_panel_settings")
        layout -> conclaveString("native_panel_layout")
        else -> conclaveString("native_panel_participants")
    }
    InCallPage(
        title = title,
        variant = variant,
        appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,
        // Fixture-only exercise of the composer layout; production callers pass decision.hasBottomComposer.
        hasComposer = settings,
        miniTile = if (decision.showsMiniTile && rows.size > 0) {
            CallMiniTileModel(displayName = rows[0].name, cameraOff = true, isLocal = false, speaking = false)
        } else null,
        onClose = { presenter.panels.dismiss(cancelPending = true) },
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = {
            RendererProbe(key = "mini:$session:${request.presentationID}", slot = RendererSlot.miniTile,
                modifier = Modifier.fillMaxSize())
        },
        composer = {
            OutlinedTextField(value = text, onValueChange = { text = it },
                label = { Text("Sample text") }, modifier = Modifier.fillMaxWidth().testTag("panel.input"))
        },
    ) {
        Text("Presentation ${request.presentationID}; from ${request.invoker.rawValue}", modifier = Modifier.testTag("panel.identity"))
        if (layout) {
            NativeHostingLayoutChoices()
        } else {
            Text("Selected: ${rows.selectedCount}", modifier = Modifier.testTag("panel.selectedCount"))
            if (!settings) {
                for (index in 0 until rows.size) {
                    val row = rows[index]
                    NativeHostingPersonRow(row, presenter.showsDetails) { presenter.setRowSelected(id = row.id, selected = it) }
                }
            } else {
                Text("Sample settings. The text field does not send or save anything.")
            }
            TextButton(onClick = {
                presenter.presentPanel(if (settings) MeetingPanel.participants else MeetingPanel.settings,
                    from = if (settings) PanelInvoker.settings else PanelInvoker.more, at = hostingUptime())
            }, modifier = Modifier.testTag("panel.replace")) { Text(if (settings) "Open participants" else "Open settings") }
            TextButton(onClick = { rapidPanels(presenter) }, modifier = Modifier.testTag("panel.rapid")) { Text("Rapid replacement") }
            TextButton(onClick = {
                presenter.panels.present(if (settings) MeetingPanel.participants else MeetingPanel.settings, from = PanelInvoker.more)
                presenter.panels.dismiss(cancelPending = true)
            }, modifier = Modifier.testTag("panel.cancelPending")) { Text("Replace then close") }
            TextButton(onClick = {
                presenter.panels.present(if (settings) MeetingPanel.participants else MeetingPanel.settings, from = PanelInvoker.more)
                presenter.resetFixtureSession()
            }, modifier = Modifier.testTag("panel.resetDuringDismissal")) { Text("Reset during replacement") }
        }
        NativeHostingPanelReadouts(presenter, delivery, readout)
    }
}

/** One native single choice, local to the panel; it changes nothing outside it. */
@Composable
private fun NativeHostingLayoutChoices() {
    var choice by remember { mutableStateOf(NativeHostingLayoutOptions[0].first) }
    Column(Modifier.selectableGroup()) {
        for ((option, label) in NativeHostingLayoutOptions) {
            val selected = choice == option
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("panel.layout.$option")
                    .selectable(selected = selected, role = Role.RadioButton, onClick = { choice = option }),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                RadioButton(selected = selected, onClick = null)
                Text(conclaveString(label), style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

/**
 * The stage lifetime probe (S10 R12): counts stage creations so host tests and a stand-in CallRoot can prove a
 * renderer host survives panel, theme and route changes (S10 10 l4). Internal, not private, so other Debug roots and
 * the Robolectric suite reuse it; plain storage, never observed, so counting never recomposes anything.
 */
internal class NativeHostingStageLifetime {
    var creations = 0
        private set

    /** Records one stage creation and returns a short instance identity for the readout. */
    fun create(): String {
        creations++
        return UUID.randomUUID().toString().take(8)
    }
}
