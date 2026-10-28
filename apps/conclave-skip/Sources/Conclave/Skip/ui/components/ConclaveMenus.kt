package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.dp

/*
 * Menus (F00 C16): an anchored M3 DropdownMenu from the shared MenuSectionModel, so the iOS menu, the iOS fallback
 * sheet and this menu read one model. Flat: extraSmall shape, surfaceContainer, no tonal or shadow elevation, a
 * 1 dp outlineVariant border. Sections are separated by dividers; destructive items take the error color and sit
 * last (the model's order); a toggle item is a Checkbox node with a trailing check while on; an unavailable item
 * stays, disabled, with its reason as a second line and in its state description (R10). The anchor's owner opens
 * it (by tap or by long press through combinedClickable, which plays `longPress`). Content composes only while
 * expanded. The menu window registers with the Debug semantics exporter and exposes test tags as resource ids.
 */

/** The Material glyph for a manifest concept used in menus, null for none. Screens may pass their own. */
internal fun conclaveMenuIcon(concept: String): ImageVector? = when (concept) {
    "raise_hand" -> ConclaveIcons.FrontHandFill0
    "share_screen" -> ConclaveIcons.PresentToAllFill0
    "stop_sharing" -> ConclaveIcons.CancelPresentationFill1
    "captions" -> ConclaveIcons.ClosedCaptionFill0
    "settings" -> ConclaveIcons.SettingsFill0
    "participants" -> ConclaveIcons.GroupFill0
    "lock_meeting" -> ConclaveIcons.LockFill1
    "pin" -> ConclaveIcons.KeepFill0
    "unpin" -> ConclaveIcons.KeepOffFill0
    "mute_person" -> ConclaveIcons.MicOffFill1
    "camera_off_person" -> ConclaveIcons.VideocamOffFill1
    "remove_person" -> ConclaveIcons.PersonRemoveFill0
    "more" -> ConclaveIcons.MoreVertFill0
    "chat" -> ConclaveIcons.ChatBubbleFill0
    "copy_link" -> ConclaveIcons.ContentCopyFill0
    "invite" -> ConclaveIcons.ShareFill0
    "reactions" -> ConclaveIcons.AddReactionFill0
    "activities_games" -> ConclaveIcons.SportsEsportsFill0
    "info" -> ConclaveIcons.InfoFill0
    "search" -> ConclaveIcons.SearchFill0
    "host" -> ConclaveIcons.ShieldPersonFill0
    "delete" -> ConclaveIcons.DeleteFill0
    "private_message" -> ConclaveIcons.LockFill1
    "hide_sender" -> ConclaveIcons.VisibilityOffFill0
    "visibility" -> ConclaveIcons.VisibilityFill0
    "change_name" -> ConclaveIcons.EditFill0
    "lower_hand" -> ConclaveIcons.DoNotTouchFill0
    "request_declined" -> ConclaveIcons.DoNotTouchFill0
    "speaker_off" -> ConclaveIcons.VolumeOffFill1
    "move_to_audience" -> ConclaveIcons.MoveDownFill0
    "admit" -> ConclaveIcons.CheckFill0
    "bring_on_stage" -> ConclaveIcons.MoveUpFill0
    "close" -> ConclaveIcons.CloseFill0
    "flip_camera" -> ConclaveIcons.CameraswitchFill0
    "self_view_minimize" -> ConclaveIcons.PictureInPictureAltFill0
    "picture_in_picture" -> ConclaveIcons.PictureInPictureAltFill0
    "fit_video" -> ConclaveIcons.FitScreenFill0
    "fill_video" -> ConclaveIcons.CropFill0
    else -> null
}

@Composable
internal fun ConclaveDropdownMenu(
    expanded: Boolean, onDismissRequest: () -> Unit, sections: List<MenuSectionModel>, identifier: String,
    onSelect: (MenuItemModel) -> Unit, modifier: Modifier = Modifier,
    icon: (MenuItemModel) -> ImageVector? = { conclaveMenuIcon(it.concept) },
) {
    val scheme = MaterialTheme.colorScheme
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismissRequest,
        modifier = modifier.testTag(identifier).semantics { testTagsAsResourceId = true },
        shape = MaterialTheme.shapes.extraSmall,
        containerColor = scheme.surfaceContainer,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
        border = BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        // The menu's own window registers with the Debug semantics exporter (S40 R40-11).
        NativeSemanticsPopupRoot(identifier)
        for ((index, section) in sections.withIndex()) {
            if (index > 0) HorizontalDivider(color = scheme.outlineVariant)
            for (item in section.items) {
                ConclaveMenuRow(item, icon(item), "$identifier.${item.id}", onSelect)
            }
        }
    }
}

@Composable
private fun ConclaveMenuRow(item: MenuItemModel, icon: ImageVector?, identifier: String, onSelect: (MenuItemModel) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val destructive = item.role == MenuItemRole.destructive
    val toggle = item.role == MenuItemRole.toggle
    val reason = if (!item.isEnabled && item.disabledReason.isNotEmpty()) item.disabledReason else null
    DropdownMenuItem(
        text = {
            Column {
                ConclaveText(item.title, line = "$identifier.title")
                if (reason != null) {
                    ConclaveText(reason, line = "$identifier.reason", style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                }
            }
        },
        onClick = { onSelect(item) },
        modifier = Modifier.testTag(identifier).semantics {
            if (toggle) {
                role = Role.Checkbox
                toggleableState = ToggleableState(item.isOn)
            }
            if (reason != null) stateDescription = reason
        },
        leadingIcon = if (icon != null) { { Icon(icon, contentDescription = null) } } else null,
        trailingIcon = if (toggle && item.isOn) { { Icon(ConclaveIcons.CheckFill0, contentDescription = null) } } else null,
        enabled = item.isEnabled,
        colors = if (destructive) MenuDefaults.itemColors(textColor = scheme.error, leadingIconColor = scheme.error) else MenuDefaults.itemColors(),
    )
}
