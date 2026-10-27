package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/*
 * S40 0.9, CH22 (CHT-1 to CHT-3): the Android Debug chat fixture controls. The stage fixture root installs
 * ChatFixtureDriver into its shell's chat presenter when the intent extra `conclave.chatFixture` names a state
 * (request R3 in HD/requests/B4-T1.md); the chat panel then shows this bar above the timeline. Labels are Debug-only
 * verbatim data (the script names), tags `chat.fixture.<script>`, readouts `chat.fixture.actions` and
 * `chat.openLatency`. Never shown unless a fixture driver is installed.
 */
@Composable
internal fun ChatFixtureControlsBar(driver: ChatFixtureDriver) {
    var refresh by remember { mutableIntStateOf(0) }
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(vertical = 4.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (script in ChatFixtureScriptName.allCases) {
                TextButton(onClick = {
                    driver.run(script)
                    refresh += 1
                }, modifier = Modifier.testTag("chat.fixture." + script.rawValue)) {
                    ConclaveText(script.rawValue, line = "chat.fixture." + script.rawValue + ".label",
                        style = MaterialTheme.typography.labelSmall)
                }
            }
            val refreshLabel = "refresh"
            TextButton(onClick = { refresh += 1 }, modifier = Modifier.testTag("chat.fixture.refresh")) {
                ConclaveText(refreshLabel, line = "chat.fixture.refresh.label", style = MaterialTheme.typography.labelSmall)
            }
        }
        // Keyed by the refresh counter so a script tap re-reads the plain (unobserved) driver readouts.
        key(refresh) {
            val noActions = "actions: none"
            val actionsText = if (driver.actionsReadout.isEmpty()) noActions else driver.actionsReadout
            ConclaveText(actionsText, line = "chat.fixture.actions", style = MaterialTheme.typography.labelSmall, maxLines = 4,
                modifier = Modifier.padding(horizontal = 16.dp).testTag("chat.fixture.actions"))
            val latency = driver.openLatencyReadout + " list=" + driver.counters.count("chat.recompose.list") +
                " composer=" + driver.counters.count("chat.recompose.composer")
            ConclaveText(latency, line = "chat.openLatency", style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(horizontal = 16.dp).testTag("chat.openLatency"))
        }
    }
}
