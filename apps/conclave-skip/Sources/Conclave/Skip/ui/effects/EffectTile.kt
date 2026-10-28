package conclave.module

import android.graphics.Bitmap
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/*
 * S60 0.6 L6-7 (SET-6) on Android: EffectTile, a 64 dp flat thumbnail inside a 72 dp column with its labelSmall caption,
 * a 2 dp primaryContainer ring and a check badge (primaryContainer fill, onPrimaryContainer CheckFill0) when selected,
 * and a system spinner while the engine applies it (4 d, e, h: no animation on the ring or badge). One node with the
 * radio role inside its tab's selectable group, the effect name and "Selected" or "Applying" as its state (4 i).
 * Personal tiles add a long-press menu (Change image, Remove image) mirrored as custom actions. Thumbnails are flat
 * (R12): catalog art ships with the WP10 engine, so a catalog tile shows the raised surface with a concept glyph; a
 * personal tile shows its stored JPEG decoded at tile size.
 */

internal object EffectTileMetrics {
    const val TILE_DP = 72
    const val THUMBNAIL_DP = 64
    const val BADGE_DP = 20
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun EffectTile(
    item: EffectItem,
    title: String,
    enabled: Boolean,
    onSelect: () -> Unit,
    modifier: Modifier = Modifier,
    onChangeImage: (() -> Unit)? = null,
    onRemoveImage: (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val active = enabled && !item.isBlockedBySystem
    val state = when {
        item.isProcessing -> conclaveString("fx_applying")
        item.isSelected -> conclaveString("fx_selected")
        else -> ""
    }
    val changeLabel = conclaveString("fx_change_image")
    val removeLabel = conclaveString("fx_remove_image")
    var menuOpen by remember { mutableStateOf(false) }
    val personal = item.kind == EffectKind.personal && onChangeImage != null && onRemoveImage != null
    val interaction = if (personal) {
        Modifier.combinedClickable(enabled = active, role = Role.RadioButton, onClick = onSelect, onLongClick = { menuOpen = true })
            .semantics {
                selected = item.isSelected
                customActions = listOf(
                    CustomAccessibilityAction(changeLabel) { onChangeImage?.invoke(); true },
                    CustomAccessibilityAction(removeLabel) { onRemoveImage?.invoke(); true },
                )
            }
    } else {
        Modifier.selectable(selected = item.isSelected, enabled = active, role = Role.RadioButton, onClick = onSelect)
    }
    Box(modifier) {
        Column(
            Modifier.width(EffectTileMetrics.TILE_DP.dp).testTag("effects.tile.${item.id}")
                .alpha(if (active) 1f else ConclaveDisabledOpacity.android.toFloat())
                .then(interaction)
                .semantics(mergeDescendants = true) {
                    contentDescription = title
                    if (state.isNotEmpty()) stateDescription = state
                },
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(Modifier.size(EffectTileMetrics.THUMBNAIL_DP.dp)) {
                Box(
                    Modifier.fillMaxSize().clip(MaterialTheme.shapes.medium).background(scheme.surfaceContainerHigh)
                        .then(if (item.isSelected) Modifier.border(BorderStroke(2.dp, scheme.primaryContainer), MaterialTheme.shapes.medium) else Modifier),
                    contentAlignment = Alignment.Center,
                ) {
                    EffectThumbnail(item)
                }
                if (item.isSelected) {
                    Box(
                        Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-4).dp).size(EffectTileMetrics.BADGE_DP.dp)
                            .clip(CircleShape).background(scheme.primaryContainer).clearAndSetSemantics { },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(ConclaveIcons.CheckFill0, contentDescription = null, tint = scheme.onPrimaryContainer, modifier = Modifier.size(14.dp))
                    }
                }
                if (item.isProcessing) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center).size(24.dp).clearAndSetSemantics { }, strokeWidth = 2.dp)
                }
            }
            ConclaveText(title, line = "effects.tile.${item.id}.title", style = MaterialTheme.typography.labelSmall,
                color = scheme.onSurfaceVariant, textAlign = TextAlign.Center, maxLines = 2)
        }
        if (personal) {
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(text = { ConclaveText(changeLabel, line = "effects.tile.change") }, onClick = {
                    menuOpen = false
                    onChangeImage?.invoke()
                })
                DropdownMenuItem(text = { ConclaveText(removeLabel, line = "effects.tile.remove", color = scheme.error) }, onClick = {
                    menuOpen = false
                    onRemoveImage?.invoke()
                })
            }
        }
    }
}

/** The Add photo tile (4 d): the same geometry, a button that launches the system photo picker. */
@Composable
internal fun EffectAddPhotoTile(enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val title = conclaveString("fx_add_photo")
    Column(
        modifier.width(EffectTileMetrics.TILE_DP.dp).testTag("effects.addPhoto")
            .alpha(if (enabled) 1f else ConclaveDisabledOpacity.android.toFloat())
            .selectable(selected = false, enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = title },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier.size(EffectTileMetrics.THUMBNAIL_DP.dp).clip(MaterialTheme.shapes.medium).background(scheme.surfaceContainerHigh),
            contentAlignment = Alignment.Center,
        ) {
            Icon(ConclaveIcons.ImageFill0, contentDescription = null, tint = scheme.onSurfaceVariant)
        }
        ConclaveText(title, line = "effects.addPhoto.title", style = MaterialTheme.typography.labelSmall,
            color = scheme.onSurfaceVariant, textAlign = TextAlign.Center, maxLines = 2)
    }
}

/** A personal tile's stored JPEG at tile size, else the concept glyph. */
@Composable
private fun EffectThumbnail(item: EffectItem) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    if (item.kind == EffectKind.personal) {
        val bitmap by produceState<Bitmap?>(initialValue = null, item.assetName) {
            value = EffectsPhotoStore.thumbnail(context, item.assetName, maxPixels = EffectTileMetrics.THUMBNAIL_DP * 3)
        }
        val loaded = bitmap
        if (loaded != null) {
            Image(loaded.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            return
        }
    }
    Icon(
        if (item.kind == EffectKind.none) ConclaveIcons.CloseFill0 else ConclaveIcons.ImageFill0,
        contentDescription = null,
        tint = scheme.onSurfaceVariant,
        modifier = Modifier.padding(4.dp),
    )
}
