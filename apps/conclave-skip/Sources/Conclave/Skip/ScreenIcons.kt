package conclave.module

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons

import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.automirrored.rounded.ViewSidebar
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.ClosedCaption
import androidx.compose.material.icons.rounded.Gif
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Cameraswitch
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CloseFullscreen
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.EmojiEmotions
import androidx.compose.material.icons.rounded.FeaturedVideo
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.HelpOutline
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.ListAlt
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.NorthEast
import androidx.compose.material.icons.rounded.NorthWest
import androidx.compose.material.icons.rounded.OpenInFull
import androidx.compose.material.icons.rounded.PanTool
import androidx.compose.material.icons.rounded.PictureInPictureAlt
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PersonAdd
import androidx.compose.material.icons.rounded.PersonRemove
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material.icons.rounded.ScreenShare
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.SouthEast
import androidx.compose.material.icons.rounded.SouthWest
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material.icons.rounded.Stop
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

private val meetingIconsWarmLock = Any()
@Volatile private var meetingIconsWarmStarted = false

internal fun meetingIconVector(name: String): ImageVector = when (name) {
    "mic"             -> Icons.Rounded.Mic
    "mic.off"         -> Icons.Rounded.MicOff
    "video"           -> Icons.Rounded.Videocam
    "video.off"       -> Icons.Rounded.VideocamOff
    "camera.flip"     -> Icons.Rounded.Cameraswitch
    "screen.share"    -> Icons.Rounded.ScreenShare
    "screen.share.off" -> Icons.Rounded.StopScreenShare
    "hangup"          -> Icons.Rounded.CallEnd
    "more"            -> Icons.Rounded.MoreHoriz
    "chat"            -> Icons.AutoMirrored.Rounded.Chat
    "chat.outline"    -> Icons.Outlined.ChatBubbleOutline
    "reply"           -> Icons.AutoMirrored.Rounded.Reply
    "participants"    -> Icons.Rounded.Groups
    "grid"            -> Icons.Rounded.GridView
    "sidebar"         -> Icons.AutoMirrored.Rounded.ViewSidebar
    "spotlight"       -> Icons.Rounded.FeaturedVideo
    "pip"             -> Icons.Rounded.PictureInPictureAlt
    "collapse"        -> Icons.Rounded.CloseFullscreen
    "settings"        -> Icons.Rounded.Settings
    "raise.hand"      -> Icons.Rounded.PanTool
    "raise.hand.off"  -> Icons.Outlined.PanTool
    "reactions"       -> Icons.Rounded.EmojiEmotions
    "lock"            -> Icons.Rounded.Lock
    "lock.open"       -> Icons.Rounded.LockOpen
    "send"            -> Icons.AutoMirrored.Rounded.Send
    "close"           -> Icons.Rounded.Close
    "copy"            -> Icons.Rounded.ContentCopy
    "description"     -> Icons.Rounded.Description
    "list"            -> Icons.Rounded.ListAlt
    "delete"          -> Icons.Rounded.Delete
    "pin.off"         -> Icons.Outlined.PushPin
    "ghost"           -> Icons.Rounded.VisibilityOff
    "host"            -> Icons.Rounded.WorkspacePremium
    "key"             -> Icons.Rounded.Key
    "link"            -> Icons.Rounded.Link
    "public"          -> Icons.Rounded.Public
    "person.add"      -> Icons.Rounded.PersonAdd
    "remove.person"   -> Icons.Rounded.PersonRemove
    "arrow.forward"   -> Icons.AutoMirrored.Rounded.ArrowForward
    "back"            -> Icons.AutoMirrored.Rounded.ArrowBack
    "account"         -> Icons.Outlined.AccountCircle
    "block"           -> Icons.Rounded.Block
    "forum"           -> Icons.Rounded.Forum
    "play"            -> Icons.Rounded.PlayArrow
    "pause"           -> Icons.Rounded.Pause
    "stop"            -> Icons.Rounded.Stop
    "refresh"         -> Icons.Rounded.Refresh
    "share"           -> Icons.Rounded.Share
    "sports_esports"  -> Icons.Rounded.SportsEsports
    "group"           -> Icons.Rounded.Groups
    "check"           -> Icons.Rounded.CheckCircle
    "volume"          -> Icons.AutoMirrored.Rounded.VolumeUp
    "volume.off"      -> Icons.AutoMirrored.Rounded.VolumeOff
    "add"             -> Icons.Rounded.Add
    "remove"          -> Icons.Rounded.Remove
    "minus"           -> Icons.Rounded.Remove
    "info"            -> Icons.Rounded.Info
    "shield"          -> Icons.Rounded.Shield
    "gif"             -> Icons.Rounded.Gif
    "search"          -> Icons.Rounded.Search
    "closed_caption"  -> Icons.Rounded.ClosedCaption
    "warning"         -> Icons.Rounded.Warning
    "open.in.full"    -> Icons.Rounded.OpenInFull
    "north.east"      -> Icons.Rounded.NorthEast
    "north.west"      -> Icons.Rounded.NorthWest
    "south.east"      -> Icons.Rounded.SouthEast
    "south.west"      -> Icons.Rounded.SouthWest
    else              -> Icons.Rounded.HelpOutline
}

internal fun meetingIconTint(key: String): Color = when (key) {
    "text", "white" -> Color(0xFFFAFAFA)
    "muted"         -> Color(0xBDFAFAFA)
    "faint"         -> Color(0x8FFAFAFA)
    "amber"         -> Color(0xF2FBBF24)
    "danger", "error" -> Color(0xFFEA4335)
    "accent", "orange" -> Color(0xFFF95F4A)
    "pink"          -> Color(0xFFFF007A)
    "success", "green" -> Color(0xFF22C55E)
    "black"         -> Color(0xFF0A0A0B)
    else            -> Color(0xFFFAFAFA)
}

fun warmMeetingIcons() {
    synchronized(meetingIconsWarmLock) {
        if (meetingIconsWarmStarted) return
        meetingIconsWarmStarted = true
    }

    val warm = Thread {
        val startedAt = System.nanoTime()
        val keys = listOf(
            "mic", "mic.off", "video", "video.off", "screen.share", "screen.share.off",
            "hangup", "more", "chat", "chat.outline", "participants", "grid", "sidebar", "spotlight", "pip",
            "collapse", "settings",
            "raise.hand", "raise.hand.off", "reactions", "lock", "lock.open", "send", "reply",
            "close", "copy", "description", "list", "pause", "stop", "refresh", "share", "delete", "pin.off", "ghost", "host", "person.add", "remove.person",
            "key", "link", "public", "arrow.forward", "back", "account", "block", "forum", "play",
            "sports_esports", "group", "volume",
            "volume.off", "add", "remove", "minus", "info", "shield", "gif", "search", "closed_caption", "warning", "check", "open.in.full",
            "north.east", "north.west", "south.east", "south.west"
        )
        for (k in keys) {

            meetingIconVector(k)
        }
        NativePerformanceDiagnostics.timingAlways(
            "meeting_icon_prewarm",
            startedAt,
            "count=${keys.size}"
        )
    }
    warm.isDaemon = true
    warm.name = "meeting-icon-warm"
    warm.start()
}

@Composable
internal fun MeetingIcon(name: String, size: Double, tint: String = "text", modifier: Modifier = Modifier) {
    Icon(
        imageVector = meetingIconVector(name),
        contentDescription = name,
        tint = meetingIconTint(tint),
        modifier = modifier.size(size.dp)
    )
}
