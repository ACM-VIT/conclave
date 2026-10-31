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

        key(refresh) {
            val noActions = "actions: none"
            val actionsText = if (driver.actionsReadout.isEmpty()) noActions else driver.actionsReadout
            ConclaveText(actionsText, line = "chat.fixture.actions", style = MaterialTheme.typography.labelSmall, maxLines = 4,
                modifier = Modifier.padding(horizontal = 16.dp).testTag("chat.fixture.actions"))
            val latency = driver.openLatencyReadout + " list=" + driver.counters.count("chat.recompose.list") +
                " composer=" + driver.counters.count("chat.recompose.composer") + " " + driver.assistantAnnouncementReadout
            ConclaveText(latency, line = "chat.openLatency", style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(horizontal = 16.dp).testTag("chat.openLatency"))
        }
        ChatGateLineReadout(driver)
    }
}

@Composable
private fun ChatGateLineReadout(driver: ChatFixtureDriver) {
    ConclaveText(driver.gateLineReadout, line = "chat.composer.gateLine", style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.padding(horizontal = 16.dp).testTag("chat.composer.gateLine"))
}
