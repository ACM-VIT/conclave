package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.key
import androidx.compose.ui.semantics.hideFromAccessibility
import java.util.UUID
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/** Called only by MainActivity's explicit debug launch route, outside SkipUI PresentationRoot. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativeHostingPreviewRoot(onClose: () -> Unit) {
    val presenter = remember { NativeHostingPresenter() }
    // Intentionally inert: the real mapper runs, but this sink never invokes hardware.
    val delivery = remember(presenter) { NativeFeedbackDelivery(presenter, sink = {}) }
    val lifetime = remember(presenter) { NativePanelOverlayLifetime(presenter.panels) }
    val stageLifetime = remember { NativeHostingStageLifetime() }
    var mount by remember { mutableIntStateOf(0) }
    val panelState = presenter.panels.snapshot
    key(mount) { NativeFeedbackConsumer(presenter, delivery, mount) }
    BackHandler {
        if (presenter.panels.snapshot.current != null) presenter.panels.dismiss(cancelPending = true) else onClose()
    }
    Box(Modifier.fillMaxSize()) {
        NativeHostingStage(presenter, delivery, stageLifetime, panelState.current != null,
            onRemount = { mount++ }, onClose = onClose)
        val request = panelState.current
        if (request != null && !panelState.isDismissing) {
            key(panelState.session, request.presentationID) {
                NativeHostingPanel(presenter, request,
                    onMounted = { lifetime.mounted(panelState.session, request.presentationID) },
                    onDisposed = { lifetime.disposed(panelState.session, request.presentationID) })
            }
        }
        SideEffect { lifetime.acknowledgeAbsent() }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NativeHostingStage(
    presenter: NativeHostingPresenter, delivery: NativeFeedbackDelivery,
    lifetime: NativeHostingStageLifetime, covered: Boolean, onRemount: () -> Unit, onClose: () -> Unit,
) {
    val instance = remember { lifetime.create() }
    val cache = remember(presenter) { NativeHostingRowsCache(presenter) }
    val rows = cache.current()
    val showsDetails = presenter.showsDetails
    HostingTheme {
        Scaffold(
            modifier = Modifier.semantics { if (covered) hideFromAccessibility() },
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
                item(key = "stage") {
                    Box(Modifier.fillMaxWidth().heightIn(min = 80.dp)
                        .background(Color(DesignTokens.androidExtendedStage)).padding(16.dp)) {
                        Text("Inert stage $instance; instances ${lifetime.creations}",
                            color = Color(DesignTokens.paper), modifier = Modifier.testTag("fixture.stage"))
                    }
                }
                item(key = "panels") {
                    Column {
                        TextButton(onClick = { presenter.panels.present(MeetingPanel.participants, from = PanelInvoker.call) },
                            modifier = Modifier.testTag("panel.open.participants")) { Text("Participants panel") }
                        TextButton(onClick = { presenter.panels.present(MeetingPanel.settings, from = PanelInvoker.settings) },
                            modifier = Modifier.testTag("panel.open.settings")) { Text("Settings panel") }
                        TextButton(onClick = { rapidPanels(presenter) }, modifier = Modifier.testTag("panel.rapid")) { Text("Rapid replacement") }
                    }
                }
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

private fun rapidPanels(presenter: NativeHostingPresenter) {
    presenter.panels.present(MeetingPanel.participants, from = PanelInvoker.call)
    presenter.panels.present(MeetingPanel.settings, from = PanelInvoker.settings)
    presenter.panels.present(MeetingPanel.participants, from = PanelInvoker.more)
}

@Composable
private fun NativeHostingPanel(
    presenter: NativeHostingPresenter, request: PanelRequest,
    onMounted: () -> Unit, onDisposed: () -> Unit,
) {
    val cache = remember(presenter) { NativeHostingRowsCache(presenter) }
    val rows = cache.current()
    var text by remember { mutableStateOf("") }
    val settings = request.panel == MeetingPanel.settings
    InCallPage(
        title = if (settings) "Settings" else "Participants",
        hasComposer = settings,
        onClose = { presenter.panels.dismiss(cancelPending = true) },
        onMounted = onMounted,
        onDisposed = onDisposed,
        composer = {
            OutlinedTextField(value = text, onValueChange = { text = it },
                label = { Text("Sample text") }, modifier = Modifier.fillMaxWidth().testTag("panel.input"))
        },
    ) {
        Text("Presentation ${request.presentationID}; from ${request.invoker.rawValue}", modifier = Modifier.testTag("panel.identity"))
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
            presenter.panels.present(if (settings) MeetingPanel.participants else MeetingPanel.settings,
                from = if (settings) PanelInvoker.settings else PanelInvoker.more)
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
}

private class NativeHostingStageLifetime {
    var creations = 0
        private set
    fun create(): String {
        creations++
        return UUID.randomUUID().toString().take(8)
    }
}
