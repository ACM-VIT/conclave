package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/// The minimal Picture-in-Picture layout: ONLY the active speaker's video (or
/// their avatar when their camera is off) on the Carbon background — no chrome.
/// Mute / Leave live in the system PiP action bar (PipManager RemoteActions).
@Composable
fun PipContent() {
    val track = PipController.pipVideoTrack
    val cameraOff = PipController.pipVideoIsCameraOff
    val name = PipController.pipDisplayName

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0A0B)),
        contentAlignment = Alignment.Center
    ) {
        if (track != null && !cameraOff) {
            VideoTrackView(track = track, mirror = false, fit = false)
        } else {
            PipAvatar(name)
        }
    }
}

@Composable
private fun PipAvatar(name: String) {
    val initial = name.trim().take(1).uppercase().ifEmpty { "?" }
    Box(
        modifier = Modifier
            .size(72.dp)
            .clip(CircleShape)
            .background(Color(0xFF232327)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = initial,
            color = Color(0xFFFAFAFA),
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
    }
}
