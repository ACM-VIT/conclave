package conclave.module

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/*
 * The one-time tip (F00 C25; RECONCILE R39): an inline dismissible card inside the content of the panel where the
 * feature lives, never a popup, tooltip or coachmark over the stage or the control bar. The C09 surface treatment:
 * surfaceContainerHigh, medium shape, a 1 dp outlineVariant border, the concept glyph in onSurfaceVariant, the title
 * in titleSmall and the body in bodyMedium. The text merges into one node read in content order (never announced on
 * appear, never focused); Dismiss is its own 48 dp button. Dismissal is stored once per tip id under
 * `conclave.tip.<id>` (OneTimeTipPolicy.storeKey) and the card is never composed again on this install. The store is
 * the app's SharedPreferences file "conclave.tips" (DataStore is not a declared dependency of this module); one read
 * per composition of the card, no timer. The hosting screen owns the copy and decides eligibility with
 * OneTimeTipPolicy.isEligible (at most one tip per panel presentation, hidden while the panel is loading, empty for
 * another reason or in an error state).
 */

/** Dismissed tips, one Boolean per tip id. */
internal object ConclaveTipStore {
    const val PREFERENCES = "conclave.tips"

    fun isDismissed(context: Context, id: String): Boolean =
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(OneTimeTipPolicy.storeKey(id), false)

    fun dismiss(context: Context, id: String) {
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putBoolean(OneTimeTipPolicy.storeKey(id), true).apply()
    }

    /** Debug galleries only: shows every tip again. */
    fun reset(context: Context) {
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().clear().apply()
    }
}

/**
 * The inline tip card for tip [id] (a OneTimeTipID raw value). It shows until dismissed, then stores the dismissal,
 * removes itself (instant, no exit motion) and calls [onDismiss].
 */
@Composable
internal fun ConclaveTipCard(
    id: String, title: String, body: String, icon: ImageVector, identifier: String, modifier: Modifier = Modifier,
    onDismiss: () -> Unit = {},
) {
    val context = LocalContext.current
    var visible by remember(id) { mutableStateOf(!ConclaveTipStore.isDismissed(context, id)) }
    if (!visible) return
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = modifier.fillMaxWidth().testTag(identifier),
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, scheme.outlineVariant),
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
    ) {
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            Row(Modifier.weight(1f).semantics(mergeDescendants = true) { }, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(icon, contentDescription = null, tint = scheme.onSurfaceVariant)
                Column(Modifier.weight(1f)) {
                    ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.titleSmall, color = scheme.onSurface)
                    ConclaveText(body, line = "$identifier.body", style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                }
            }
            IconButton(
                onClick = {
                    ConclaveTipStore.dismiss(context, id)
                    visible = false
                    onDismiss()
                },
                modifier = Modifier.testTag("$identifier.dismiss"),
            ) {
                Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("ds_dismiss_tip"))
            }
        }
    }
}
