package conclave.module

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

internal data class CallMiniTileModel(
    val displayName: String,
    val cameraOff: Boolean,
    val isLocal: Boolean,
    val speaking: Boolean,
)

internal fun callMiniTileBorderWidthDp(speaking: Boolean): Int = if (speaking) 2 else 1

@Composable
internal fun CallMiniTile(
    model: CallMiniTileModel,
    onReturnToCall: () -> Unit,
    modifier: Modifier = Modifier,
    video: (@Composable () -> Unit)? = null,
) {
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val shape = RoundedCornerShape(DesignTokens.radiusTile.dp)
    val description = if (model.cameraOff) conclaveString("native_panel_name_camera_off", model.displayName) else model.displayName
    val returnLabel = conclaveString("native_panel_return_to_call")
    val speakingLabel = conclaveString("native_panel_speaking")
    val borderColor = if (model.speaking) Color(DesignTokens.androidExtendedSpeaking) else MaterialTheme.colorScheme.outlineVariant
    Box(
        modifier.size(callMiniTileWidthDp(landscape).dp, callMiniTileHeightDp(landscape).dp)
            .clip(shape)
            .background(Color(DesignTokens.androidExtendedTile))
            .border(callMiniTileBorderWidthDp(model.speaking).dp, borderColor, shape)
            .testTag("call.miniTile")
            .clickable(onClickLabel = returnLabel, role = Role.Button, onClick = onReturnToCall)
            .semantics {
                contentDescription = description
                if (model.speaking) stateDescription = speakingLabel
            },
        contentAlignment = Alignment.BottomStart,
    ) {
        video?.invoke()
        Text(
            model.displayName,
            color = Color(DesignTokens.paper),
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(8.dp).clearAndSetSemantics { },
        )
    }
}
