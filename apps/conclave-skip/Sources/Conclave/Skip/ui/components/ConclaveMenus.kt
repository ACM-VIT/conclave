package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.MenuItemColors
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.PopupProperties

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

internal object ConclaveMenuDefaults {
    val MinWidth = 200.dp
    val ItemInset = 8.dp
    val ContentPadding = PaddingValues(horizontal = 8.dp)
    val DividerInset = 16.dp
    val BarGap = 16.dp
    val LightShadowElevation = 0.dp
    val shape: Shape
        @Composable get() = MaterialTheme.shapes.large
    val itemShape: Shape
        @Composable get() = MaterialTheme.shapes.small
}

internal sealed interface ConclaveMenuRole {
    object Plain : ConclaveMenuRole
    object Destructive : ConclaveMenuRole
    class Toggle(val on: Boolean) : ConclaveMenuRole
    class Single(val selected: Boolean) : ConclaveMenuRole
}

private val ConclaveMenuHeaderMaxWidth = 296.dp
private val ConclaveMenuItemTextPadding = 8.dp

@Composable
internal fun ConclaveDropdownMenu(
    expanded: Boolean, onDismissRequest: () -> Unit, identifier: String, modifier: Modifier = Modifier,
    offset: DpOffset = DpOffset(0.dp, 0.dp), properties: PopupProperties = PopupProperties(focusable = true),
    content: @Composable ColumnScope.() -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismissRequest,
        modifier = modifier.widthIn(min = ConclaveMenuDefaults.MinWidth).testTag(identifier).semantics { testTagsAsResourceId = true },
        offset = offset,
        properties = properties,
        shape = ConclaveMenuDefaults.shape,
        containerColor = conclaveMenuContainerColor(),
        tonalElevation = 0.dp,
        shadowElevation = conclaveMenuShadowElevation(),
        border = BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        NativeSemanticsPopupRoot(identifier)
        content()
    }
}

@Composable
internal fun ConclaveDropdownMenu(
    expanded: Boolean, onDismissRequest: () -> Unit, sections: List<MenuSectionModel>, identifier: String,
    onSelect: (MenuItemModel) -> Unit, modifier: Modifier = Modifier,
    icon: (MenuItemModel) -> ImageVector? = { conclaveMenuIcon(it.concept) },
    offset: DpOffset = DpOffset(0.dp, 0.dp), header: (@Composable () -> Unit)? = null,
) {
    ConclaveDropdownMenu(expanded = expanded, onDismissRequest = onDismissRequest, identifier = identifier, modifier = modifier, offset = offset) {
        if (header != null) header()
        for ((index, section) in sections.withIndex()) {
            if (index > 0) ConclaveMenuDivider()
            for (item in section.items) {
                ConclaveMenuItem(
                    title = item.title,
                    identifier = "$identifier.${item.id}",
                    onClick = { onSelect(item) },
                    role = conclaveMenuRole(item),
                    leadingIcon = icon(item),
                    supporting = if (!item.isEnabled && item.disabledReason.isNotEmpty()) item.disabledReason else null,
                    enabled = item.isEnabled,
                )
            }
        }
    }
}

private fun conclaveMenuRole(item: MenuItemModel): ConclaveMenuRole = when (item.role) {
    MenuItemRole.normal -> ConclaveMenuRole.Plain
    MenuItemRole.destructive -> ConclaveMenuRole.Destructive
    MenuItemRole.toggle -> ConclaveMenuRole.Toggle(item.isOn)
}

@Composable
internal fun ConclaveMenuItem(
    title: String, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    role: ConclaveMenuRole = ConclaveMenuRole.Plain, leadingIcon: ImageVector? = null,
    leadingContent: (@Composable () -> Unit)? = null, supporting: String? = null, enabled: Boolean = true,
) {
    val scheme = MaterialTheme.colorScheme
    val toggle = role as? ConclaveMenuRole.Toggle
    val single = role as? ConclaveMenuRole.Single
    val checked = (toggle != null && toggle.on) || (single != null && single.selected)
    val reason = if (!enabled && supporting != null) supporting else null
    val leading: (@Composable () -> Unit)? = when {
        leadingContent != null -> leadingContent
        leadingIcon != null -> { { Icon(leadingIcon, contentDescription = null) } }
        else -> null
    }
    DropdownMenuItem(
        text = {
            Box(Modifier.padding(vertical = ConclaveMenuItemTextPadding)) {
                Column {
                    ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.bodyLarge)
                    if (supporting != null) {
                        ConclaveText(supporting, line = "$identifier.supporting", style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                    }
                }
            }
        },
        onClick = onClick,
        modifier = conclaveMenuRowModifier().then(modifier).testTag(identifier).semantics {
            if (toggle != null) {
                this.role = Role.Checkbox
                toggleableState = ToggleableState(toggle.on)
            }
            if (single != null) {
                this.role = Role.RadioButton
                selected = single.selected
            }
            if (reason != null) stateDescription = reason
        },
        leadingIcon = leading,
        trailingIcon = if (checked) { { Icon(ConclaveIcons.CheckFill0, contentDescription = null) } } else null,
        enabled = enabled,
        colors = conclaveMenuItemColors(role),
        contentPadding = ConclaveMenuDefaults.ContentPadding,
    )
}

@Composable
internal fun ConclaveMenuHeader(title: String, identifier: String, avatar: ConclaveAvatarIdentity? = null) {
    val scheme = MaterialTheme.colorScheme
    val frame = Modifier.widthIn(max = ConclaveMenuHeaderMaxWidth).padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp).testTag(identifier)
    if (avatar == null) {
        ConclaveText(title, line = identifier, modifier = frame.semantics { heading() }, style = MaterialTheme.typography.labelLarge,
            color = scheme.onSurfaceVariant)
        return
    }
    Row(frame.semantics(mergeDescendants = true) { heading() }, horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        ConclaveAvatar(avatar, ConclaveAvatarSize.mention.diameter.dp)
        ConclaveText(title, line = identifier, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, maxLines = 1,
            overflow = TextOverflow.Ellipsis)
    }
    ConclaveMenuDivider()
}

@Composable
internal fun ConclaveMenuDivider() {
    HorizontalDivider(Modifier.padding(horizontal = ConclaveMenuDefaults.DividerInset, vertical = 4.dp))
}

@Composable
internal fun conclaveMenuRowModifier(): Modifier = Modifier.padding(horizontal = ConclaveMenuDefaults.ItemInset).clip(ConclaveMenuDefaults.itemShape)

@Composable
internal fun conclaveMenuItemColors(role: ConclaveMenuRole): MenuItemColors {
    val scheme = MaterialTheme.colorScheme
    return when (role) {
        ConclaveMenuRole.Plain -> MenuDefaults.itemColors()
        ConclaveMenuRole.Destructive -> MenuDefaults.itemColors(textColor = scheme.error, leadingIconColor = scheme.error)
        is ConclaveMenuRole.Toggle, is ConclaveMenuRole.Single -> MenuDefaults.itemColors(trailingIconColor = scheme.onSurface)
    }
}

@Composable
private fun conclaveMenuIsDark(): Boolean = MaterialTheme.colorScheme.surface.luminance() < 0.5f

@Composable
internal fun conclaveMenuContainerColor(): Color {
    val scheme = MaterialTheme.colorScheme
    return if (conclaveMenuIsDark()) scheme.surfaceContainerHigh else scheme.surfaceContainerLowest
}

@Composable
internal fun conclaveMenuShadowElevation(): Dp = if (conclaveMenuIsDark()) 0.dp else ConclaveMenuDefaults.LightShadowElevation
