package conclave.module

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
// Rounded Material variants read closest to iOS SF Symbols (soft, rounded
// terminals) so the Android glyphs match the iOS ones. Outlined variants are
// kept only where the icon is intentionally an outline state.
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.EmojiEmotions
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.HelpOutline
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.NorthEast
import androidx.compose.material.icons.rounded.NorthWest
import androidx.compose.material.icons.rounded.PanTool
import androidx.compose.material.icons.rounded.PersonRemove
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.ScreenShare
import androidx.compose.material.icons.rounded.SouthEast
import androidx.compose.material.icons.rounded.SouthWest
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.StopScreenShare
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material.icons.rounded.WorkspacePremium
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
    "mic"             -> Icons.Rounded.Mic
    "mic.off"         -> Icons.Rounded.MicOff
    "video"           -> Icons.Rounded.Videocam
    "video.off"       -> Icons.Rounded.VideocamOff
    "screen.share"    -> Icons.Rounded.ScreenShare
    "screen.share.off" -> Icons.Rounded.StopScreenShare
    "hangup"          -> Icons.Rounded.CallEnd
    "more"            -> Icons.Rounded.MoreHoriz   // iOS ellipsis is horizontal
    "chat"            -> Icons.AutoMirrored.Rounded.Chat
    "chat.outline"    -> Icons.Outlined.ChatBubbleOutline
    "participants"    -> Icons.Rounded.Groups
    "settings"        -> Icons.Rounded.Settings
    "raise.hand"      -> Icons.Rounded.PanTool
    "raise.hand.off"  -> Icons.Outlined.PanTool
    "reactions"       -> Icons.Rounded.EmojiEmotions
    "lock"            -> Icons.Rounded.Lock
    "lock.open"       -> Icons.Rounded.LockOpen
    "send"            -> Icons.AutoMirrored.Rounded.Send
    "close"           -> Icons.Rounded.Close
    "copy"            -> Icons.Rounded.ContentCopy
    "pin.off"         -> Icons.Outlined.PushPin
    "ghost"           -> Icons.Rounded.VisibilityOff
    "host"            -> Icons.Rounded.WorkspacePremium
    "key"             -> Icons.Rounded.Key
    "link"            -> Icons.Rounded.Link
    "public"          -> Icons.Rounded.Public
    "remove.person"   -> Icons.Rounded.PersonRemove
    "arrow.forward"   -> Icons.AutoMirrored.Rounded.ArrowForward
    "back"            -> Icons.AutoMirrored.Rounded.ArrowBack
    "account"         -> Icons.Outlined.AccountCircle
    "block"           -> Icons.Rounded.Block
    "forum"           -> Icons.Rounded.Forum
    "check"           -> Icons.Rounded.CheckCircle
    "volume"          -> Icons.AutoMirrored.Rounded.VolumeUp
    "volume.off"      -> Icons.AutoMirrored.Rounded.VolumeOff
    "add"             -> Icons.Rounded.Add
    "info"            -> Icons.Rounded.Info
    "warning"         -> Icons.Rounded.Warning
    "north.east"      -> Icons.Rounded.NorthEast
    "north.west"      -> Icons.Rounded.NorthWest
    "south.east"      -> Icons.Rounded.SouthEast
    "south.west"      -> Icons.Rounded.SouthWest
    else              -> Icons.Rounded.HelpOutline
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

/// Pre-builds every meeting ImageVector off the UI thread so the first sheet /
/// controls render doesn't stall on the lazy `material-icons-extended` build.
/// Each `Icons.Rounded.X` getter lazily constructs its ImageVector and caches it
/// in a top-level backing field on first access; touching them all once at app
/// start populates that process-global cache, so every later `MeetingIcon`
/// reuses the prebuilt vector instead of building ~12 of them synchronously while
/// a sheet is opening. Building an ImageVector is pure data (no Android UI / main
/// thread dependency), and the getter is idempotent, so warming on a background
/// thread is safe. Fire-and-forget — returns immediately.
fun warmMeetingIcons() {
    val warm = Thread {
        val keys = listOf(
            "mic", "mic.off", "video", "video.off", "screen.share", "screen.share.off",
            "hangup", "more", "chat", "chat.outline", "participants", "settings",
            "raise.hand", "raise.hand.off", "reactions", "lock", "lock.open", "send",
            "close", "copy", "pin.off", "ghost", "host", "remove.person",
            "key", "link", "public", "arrow.forward", "back", "account", "block", "forum", "volume",
            "volume.off", "add", "info", "warning", "check",
            "north.east", "north.west", "south.east", "south.west"
        )
        for (k in keys) {
            // Touch the vector so its backing field initializes; result unused.
            meetingIconVector(k)
        }
    }
    warm.isDaemon = true
    warm.name = "meeting-icon-warm"
    warm.start()
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
