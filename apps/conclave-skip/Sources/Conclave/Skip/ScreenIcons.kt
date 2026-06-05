package conclave.module

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.EmojiEmotions
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.PersonRemove
import androidx.compose.material.icons.filled.ScreenShare
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.StopScreenShare
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.WorkspacePremium
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

/// Maps the app's stable icon keys to REAL material-icons-extended ImageVectors.
/// SkipUI's `Image(systemName:)` only resolves a tiny core glyph set, so the
/// proper meeting glyphs (Mic, Videocam, ScreenShare, Chat, CallEnd, …) must be
/// referenced directly in Kotlin and rendered via a Compose `Icon`.
internal fun meetingIconVector(name: String): ImageVector = when (name) {
    "mic"             -> Icons.Filled.Mic
    "mic.off"         -> Icons.Filled.MicOff
    "video"           -> Icons.Filled.Videocam
    "video.off"       -> Icons.Filled.VideocamOff
    "screen.share"    -> Icons.Filled.ScreenShare
    "screen.share.off" -> Icons.Filled.StopScreenShare
    "hangup"          -> Icons.Filled.CallEnd
    "more"            -> Icons.Filled.MoreVert
    "chat"            -> Icons.AutoMirrored.Filled.Chat
    "chat.outline"    -> Icons.Outlined.ChatBubbleOutline
    "participants"    -> Icons.Filled.Groups
    "settings"        -> Icons.Filled.Settings
    "raise.hand"      -> Icons.Filled.PanTool
    "raise.hand.off"  -> Icons.Outlined.PanTool
    "reactions"       -> Icons.Filled.EmojiEmotions
    "lock"            -> Icons.Filled.Lock
    "lock.open"       -> Icons.Filled.LockOpen
    "send"            -> Icons.AutoMirrored.Filled.Send
    "close"           -> Icons.Filled.Close
    "copy"            -> Icons.Filled.ContentCopy
    "pin.off"         -> Icons.Outlined.PushPin
    "ghost"           -> Icons.Filled.VisibilityOff
    "host"            -> Icons.Filled.WorkspacePremium
    "remove.person"   -> Icons.Filled.PersonRemove
    "arrow.forward"   -> Icons.AutoMirrored.Filled.ArrowForward
    "back"            -> Icons.AutoMirrored.Filled.ArrowBack
    "account"         -> Icons.Outlined.AccountCircle
    "add"             -> Icons.Filled.Add
    "warning"         -> Icons.Filled.Warning
    else              -> Icons.Filled.HelpOutline
}

/// Resolves a semantic tint key to an explicit Carbon color. Relying on
/// Compose's inherited `LocalContentColor` is unreliable across SkipUI bridge
/// contexts — e.g. a `.plain` Button drives the Icon dark while coloring the
/// sibling Text correctly — so meeting icons always set an explicit `tint`.
internal fun meetingIconTint(key: String): Color = when (key) {
    "text", "white" -> Color(0xFFFAFAFA)
    "muted"         -> Color(0xBDFAFAFA)   // 74%
    "faint"         -> Color(0x8FFAFAFA)   // 56%
    "amber"         -> Color(0xF2FBBF24)   // hand-raised amber-400
    "danger", "error" -> Color(0xFFEA4335)
    "accent", "orange" -> Color(0xFFF95F4A)
    "pink"          -> Color(0xFFFF007A)
    "success", "green" -> Color(0xFF22C55E)
    "black"         -> Color(0xFF0A0A0B)
    else            -> Color(0xFFFAFAFA)
}

/// Renders a meeting icon with an EXPLICIT tint (defaults to near-white `text`).
@Composable
internal fun MeetingIcon(name: String, size: Double, tint: String = "text", modifier: Modifier = Modifier) {
    Icon(
        imageVector = meetingIconVector(name),
        contentDescription = name,
        tint = meetingIconTint(tint),
        modifier = modifier.size(size.dp)
    )
}
