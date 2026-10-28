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

/*
 * ENT-6 (S10 10 d, e, g, i; 0.6 L5): the Android outcome screen, the `OutcomeKey` page above Home in the premeeting
 * NavDisplay (`[HomeKey, OutcomeKey]`, PremeetingBackStack), so Back shows the system predictive pop preview of Home
 * and lands there through NavDisplay's onBack (`performOutcomeAction(backHome)`); no root back handler. System
 * appearance: the variant's glyph, the title as a heading and the pane title, the body, the one coral primary
 * (primaryContainer with onPrimaryContainer) and a primary-colored text button for the secondary. It reads one
 * OutcomeModel; copy and glyphs come from OutcomeUi, never from the model.
 */

@Composable
internal fun OutcomeScreen(premeeting: PremeetingPresenter) {
    val outcome = premeeting.outcome ?: return
    val scheme = MaterialTheme.colorScheme
    val title = conclaveString(OutcomeUi.titleName(outcome.variant))
    val bodyName = OutcomeUi.bodyName(outcome)
    val body = if (bodyName.isEmpty()) outcome.serverDetail else conclaveString(bodyName)
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
                Spacer(Modifier.height(8.dp))
                Text(body, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant,
                    textAlign = TextAlign.Center)
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

/** S10 10 g resource names and glyphs per variant and action (Material sentence case). */
internal object OutcomeUi {
    fun titleName(variant: OutcomeVariant): String = when (variant) {
        OutcomeVariant.removed -> "pm_removed_title"
        OutcomeVariant.denied -> "pm_denied_title"
        OutcomeVariant.connectionLost -> "pm_lost_title"
        OutcomeVariant.serverDisconnected -> "pm_disconnected_title"
        OutcomeVariant.rejoinFailed -> "pm_couldnt_rejoin"
    }

    /** The body's resource name; "" shows the clean server sentence of a failed rejoin as is (S10 10 f). */
    fun bodyName(outcome: OutcomeModel): String = when (outcome.variant) {
        OutcomeVariant.removed -> "pm_removed_body"
        OutcomeVariant.denied -> "pm_denied_body"
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

    /** Canonical outcome concepts (S10 R1). */
    fun icon(variant: OutcomeVariant): ImageVector = when (variant) {
        OutcomeVariant.removed -> ConclaveIcons.PersonRemoveFill0
        OutcomeVariant.denied -> ConclaveIcons.DoNotTouchFill0
        OutcomeVariant.connectionLost -> ConclaveIcons.WifiOffFill0
        OutcomeVariant.serverDisconnected, OutcomeVariant.rejoinFailed -> ConclaveIcons.WarningFill1
    }

    /** A host-provided reason in curly quotes (the host's own words, not a localized sentence). */
    fun quoted(detail: String): String = "“" + detail + "”"
}
