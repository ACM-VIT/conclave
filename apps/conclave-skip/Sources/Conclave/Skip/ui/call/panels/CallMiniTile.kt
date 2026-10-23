package conclave.module

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** Inert sample only: no video track, renderer, capture or second call owner. */
@Composable
internal fun CallMiniTile(modifier: Modifier = Modifier) {
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    Box(
        modifier.size(if (landscape) 128.dp else 96.dp, if (landscape) 96.dp else 128.dp)
            .clip(RoundedCornerShape(DesignTokens.radiusTile.dp))
            .background(Color(DesignTokens.androidExtendedTile))
            .testTag("call.miniTile")
            .semantics { contentDescription = "Sample call tile, camera off" },
        contentAlignment = Alignment.Center,
    ) {
        Text("Sample", color = Color(DesignTokens.paper))
    }
}
