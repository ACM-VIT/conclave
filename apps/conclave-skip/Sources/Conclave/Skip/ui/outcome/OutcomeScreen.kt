package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

@Composable
internal fun OutcomeScreen(premeeting: PremeetingPresenter) {
    val outcome = premeeting.outcome ?: return
    val scheme = MaterialTheme.colorScheme
    val title = conclaveString(OutcomeUi.titleName(outcome.variant))
    val hasBody = OutcomeUi.hasBody(outcome.variant)
    val bodyName = OutcomeUi.bodyName(outcome)
    val body = if (!hasBody) "" else if (bodyName.isEmpty()) outcome.serverDetail else conclaveString(bodyName)
    val detail = if (outcome.variant == OutcomeVariant.removed && outcome.serverDetail.isNotEmpty()) {
        OutcomeUi.quoted(outcome.serverDetail)
    } else {
        ""
    }
    Scaffold(
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
        modifier = Modifier.testTag("outcome." + outcome.variant.rawValue),
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
            Column(
                modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp)
                    .semantics { paneTitle = title },
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(OutcomeUi.icon(outcome.variant), contentDescription = null, modifier = Modifier.size(48.dp),
                    tint = scheme.onSurfaceVariant)
                Spacer(Modifier.height(16.dp))
                Text(title, style = MaterialTheme.typography.headlineSmall, color = scheme.onSurface,
                    textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() }.testTag("outcome.title"))
                if (hasBody) {
                    Spacer(Modifier.height(8.dp))
                    Text(body, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant,
                        textAlign = TextAlign.Center)
                }
                if (detail.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text(detail, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant,
                        textAlign = TextAlign.Center, modifier = Modifier.testTag("outcome.detail"))
                }
                Spacer(Modifier.height(24.dp))
                if (outcome.primary != OutcomeAction.none) {
                    Button(
                        onClick = { premeeting.performOutcomeAction(outcome.primary) },
                        colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer,
                            contentColor = scheme.onPrimaryContainer),
                        modifier = Modifier.widthIn(max = 440.dp).fillMaxWidth().heightIn(min = 48.dp)
                            .testTag("outcome.primary"),
                    ) {
                        Text(conclaveString(OutcomeUi.actionName(outcome.primary)), textAlign = TextAlign.Center)
                    }
                }
                if (outcome.secondary != OutcomeAction.none) {
                    TextButton(
                        onClick = { premeeting.performOutcomeAction(outcome.secondary) },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("outcome.secondary"),
                    ) {
                        Text(conclaveString(OutcomeUi.actionName(outcome.secondary)))
                    }
                }
            }
        }
    }
}

internal object OutcomeUi {
    fun titleName(variant: OutcomeVariant): String = when (variant) {
        OutcomeVariant.removed -> "pm_removed_title"
        OutcomeVariant.denied -> "pm_denied_title"
        OutcomeVariant.connectionLost -> "pm_lost_title"
        OutcomeVariant.serverDisconnected -> "pm_disconnected_title"
        OutcomeVariant.rejoinFailed -> "pm_couldnt_rejoin"
    }

    fun hasBody(variant: OutcomeVariant): Boolean = when (variant) {
        OutcomeVariant.removed, OutcomeVariant.denied -> false
        OutcomeVariant.connectionLost, OutcomeVariant.serverDisconnected, OutcomeVariant.rejoinFailed -> true
    }

    fun bodyName(outcome: OutcomeModel): String = when (outcome.variant) {
        OutcomeVariant.removed, OutcomeVariant.denied -> ""
        OutcomeVariant.connectionLost -> "pm_lost_body"
        OutcomeVariant.serverDisconnected -> "pm_disconnected_body"
        OutcomeVariant.rejoinFailed ->
            if (outcome.failure == LobbyIssue.failedServerText && outcome.serverDetail.isNotEmpty()) ""
            else entryFailureBodyName(outcome.failure)
    }

    fun actionName(action: OutcomeAction): String = when (action) {
        OutcomeAction.rejoin -> "pm_rejoin"
        OutcomeAction.tryAgain -> "ds_try_again"
        OutcomeAction.backHome, OutcomeAction.none -> "pm_back_home"
    }

    fun icon(variant: OutcomeVariant): ImageVector = when (variant) {
        OutcomeVariant.removed -> ConclaveIcons.PersonRemoveFill0
        OutcomeVariant.denied -> ConclaveIcons.DoNotTouchFill0
        OutcomeVariant.connectionLost -> ConclaveIcons.WifiOffFill0
        OutcomeVariant.serverDisconnected, OutcomeVariant.rejoinFailed -> ConclaveIcons.WarningFill1
    }

    fun quoted(detail: String): String = "“" + detail + "”"
}
