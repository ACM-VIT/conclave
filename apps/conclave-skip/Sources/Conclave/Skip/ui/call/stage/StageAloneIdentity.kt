package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun StageAloneIdentity(alone: StageAloneSnapshot, viewport: StageViewport, modifier: Modifier = Modifier) {
    val identity = remember(alone.seed) { ConclaveAvatarIdentity.fromSeed(alone.seed) }
    val density = LocalDensity.current
    val titleLine = with(density) { StageAlonePolicy.titleLineHeight.sp.toDp().value.toDouble() }
    val statusLine = with(density) { StageAlonePolicy.statusLineHeight.sp.toDp().value.toDouble() }
    val compact = StageAlonePolicy.usesCompactLayout(viewport, titleLine = titleLine, statusLine = statusLine)
    val titleLines = StageAlonePolicy.titleLineLimit(viewport, titleLine = titleLine, statusLine = statusLine)
    Box(modifier.fillMaxSize()) {
        val placement = Modifier.align(Alignment.BottomStart)
            .padding(
                start = (viewport.insetLeading + StageAlonePolicy.edgeInset).dp,
                top = StageAlonePolicy.topPadding(viewport).dp,
                end = (viewport.insetTrailing + StageAlonePolicy.edgeInset).dp,
                bottom = StageAlonePolicy.bottomPadding(viewport).dp,
            )
            .semantics(mergeDescendants = true) { }
            .testTag("stage.alone")
        if (compact) {
            Row(placement, horizontalArrangement = Arrangement.spacedBy(StageAlonePolicy.avatarSpacing.dp),
                verticalAlignment = Alignment.CenterVertically) {
                ConclaveAvatar(identity, StageAlonePolicy.compactAvatarDiameter.dp)
                StageAloneLabels(alone.roomLabel, titleLines)
            }
        } else {
            Column(placement, verticalArrangement = Arrangement.spacedBy(StageAlonePolicy.avatarSpacing.dp)) {
                ConclaveAvatar(identity, StageAlonePolicy.avatarDiameter.dp)
                StageAloneLabels(alone.roomLabel, titleLines)
            }
        }
    }
}

@Composable
private fun StageAloneLabels(roomLabel: String, titleLines: Int) {
    val scheme = MaterialTheme.colorScheme
    val status = conclaveString("stg_waiting_for_others")
    Column(verticalArrangement = Arrangement.spacedBy(StageAlonePolicy.lineSpacing.dp)) {
        ConclaveText(roomLabel, line = "stage.alone.title", style = MaterialTheme.typography.titleLarge,
            color = scheme.onSurface, maxLines = titleLines, overflow = TextOverflow.Ellipsis)
        ConclaveText(status, line = "stage.alone.status", style = MaterialTheme.typography.bodyMedium,
            color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
