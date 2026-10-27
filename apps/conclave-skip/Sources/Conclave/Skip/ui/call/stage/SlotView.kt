package conclave.module

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.webrtc.VideoTrack
import skip.ui.UIApplication

/*
 * S20 SL6 (STG-1): the one constant slot structure. A `when` branch inside key(slot.id) disposes the AndroidView, so
 * every participant and share slot uses the same ConclaveTileChrome (F00 C08) for every role with the renderer as its
 * first child; role differences are parameters and graphicsLayer values (the minimized self view keeps its renderer
 * attached at alpha 0). The overflow and activity slots have their own ids, so their branch never changes for a given
 * key. Hot state stays in leaves: the tile reads its TileChromeEntry, the stroke its TileSpeakingState, the renderer
 * its RendererBinding.
 */

/** Where slot renderers come from: the fixture's counting probes or the live WebRTC renderers (WP3 bridge). */
internal class StageRenderers(val ledger: RendererIdentityLedger?, val pattern: RendererProbePattern, val usesProbes: Boolean) {
    companion object {
        fun probes(ledger: RendererIdentityLedger, pattern: RendererProbePattern): StageRenderers = StageRenderers(ledger, pattern, true)
        val live: StageRenderers = StageRenderers(null, RendererProbePattern.none, false)
    }
}

@Composable
internal fun SlotView(
    slot: StageSlot, stage: StagePresenter, renderers: StageRenderers, overflowCount: Int, overflowSeeds: List<String>,
    modifier: Modifier = Modifier,
) {
    when (slot.id) {
        StageSlot.overflowId -> {
            val identities = remember(overflowSeeds) { overflowSeeds.map { ConclaveAvatarIdentity.fromSeed(it) } }
            ConclaveOverflowTile(count = overflowCount, identities = identities, identifier = "stage.overflow",
                onClick = { stage.openPeople(destination = PanelDestination.none) }, modifier = modifier)
        }
        StageSlot.activityId -> ActivityStageCard(stage, modifier)
        else -> ParticipantTile(slot, stage.tileChrome.entry(slot.userId), stage.speaking.state(slot.userId),
            stage.bindings.binding(slot.id), stage, renderers, modifier)
    }
}

/** Full-bleed roles draw square corners (S20 2 e). */
internal fun stageCornerRadius(role: StageSlotRole): Dp = when (role) {
    StageSlotRole.spotlightMain, StageSlotRole.share, StageSlotRole.programFeed -> 0.dp
    StageSlotRole.selfMinimized -> (StageLayoutPolicy.selfMinimizedHeight / 2.0).dp
    else -> DesignTokens.radiusTile.dp
}

/** A share slot shows the screen, never the presenter's camera-off face. */
internal fun stageSlotModel(model: TileChromeModel, isShare: Boolean): TileChromeModel {
    if (!isShare) return model
    return TileChromeModel(userId = model.userId, displayName = model.displayName, avatarSeed = model.avatarSeed,
        isLocal = model.isLocal, isMuted = false, isCameraOff = false, isHandRaised = false, isPinned = false, isPresenting = true,
        isWeakConnection = model.isWeakConnection, isReconnecting = false, reconnectReason = "", isHost = model.isHost,
        isVoiceAgent = false)
}

/**
 * One participant or share slot (SL6) with the STG-2 tile anatomy: the tile menu on long press at the press point
 * (S20 3 d), its items as TalkBack custom actions, the Unpin target over the pinned badge (S20 4 d), the 1:1 camera-off
 * caption (S20 3 d) and the reconnect reason with "Back online" (S20 3 c; F00 C08 f). Every overlay is a leaf that reads
 * only what it shows and every modifier is present for every role, so the renderer's structure never changes (D15).
 */
@Composable
private fun ParticipantTile(
    slot: StageSlot, entry: TileChromeEntry, speaking: TileSpeakingState, binding: RendererBinding, stage: StagePresenter,
    renderers: StageRenderers, modifier: Modifier,
) {
    val isShare = slot.id.startsWith("share:")
    val model = stageSlotModel(entry.model, isShare)
    val role = slot.role
    val minimized = role == StageSlotRole.selfMinimized
    // stage.recompose.<slotId> (SL14): the fixture ledger counts tile compositions; production passes no ledger.
    SideEffect { renderers.ledger?.composed(key = slot.id) }
    val haptics = rememberConclaveHaptics()
    val menuState = rememberTileMenuState()
    val titles = rememberTileMenuTitles()
    val kind = stage.kind
    val menu = remember(slot, model, kind, titles) { stageTileMenu(slot, model, kind, titles) }
    val actions = remember(menu) { stageTileActions(menu, stage) }
    val actionsLabel = conclaveString("stg_tile_actions")
    Box(modifier) {
        ConclaveTileChrome(
            model = model,
            speaking = speaking,
            identifier = "stage.tile.${slot.id}",
            modifier = Modifier.fillMaxSize().tileLongPress(menu.hasItems) { at ->
                haptics.gesture(FeedbackKind.longPress)
                menuState.open(at)
            },
            variant = if (role.isSelfView) ConclaveTileVariant.SelfView else ConclaveTileVariant.Grid,
            spotlight = role == StageSlotRole.spotlightMain,
            cornerRadius = stageCornerRadius(role),
            actions = actions,
            haptics = haptics,
            accessibilityLongPressLabel = if (menu.hasItems) actionsLabel else null,
            onAccessibilityLongPress = if (menu.hasItems) { { menuState.open(Offset.Zero) } } else null,
        ) {
            StageRendererSlot(slot.id, slot.userId, model.isLocal, isShare, slot.fit, binding, stage, renderers,
                Modifier.fillMaxSize().graphicsLayer { alpha = if (minimized) 0f else 1f })
        }
        if (minimized) {
            ConclaveStageChip(title = conclaveString("ds_you"), identifier = "stage.selfView.minimized",
                modifier = Modifier.align(Alignment.Center), onClick = { stage.setSelfViewMode("floating") })
        }
        TileReconnectDetail(entry, isShare, Modifier.fillMaxSize())
        OneOnOneCameraOffCaption(slot, entry, stage, isShare, Modifier.fillMaxSize())
        TileUnpinTarget(slot, entry, stage, isShare, Modifier.align(Alignment.TopEnd))
        TileMenuAnchor(menuState, menu, stage, "stage.tile.menu.${slot.id}", Modifier.align(AbsoluteAlignment.TopLeft))
    }
}

/** Places the content horizontally centered with its top `gap` below the parent's vertical center. */
private fun Modifier.belowCenter(gap: Dp): Modifier = layout { measurable, constraints ->
    val placeable = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
    val width = constraints.maxWidth
    val height = constraints.maxHeight
    val offset = gap.roundToPx()
    layout(width, height) {
        placeable.placeRelative((width - placeable.width) / 2, height / 2 + offset)
    }
}

/**
 * The pinned badge on the spotlight main is itself an IconButton-sized (48 dp) target "Unpin %1$s" (S20 4 d): an
 * invisible Button node centered on the badge the chrome draws.
 */
@Composable
private fun TileUnpinTarget(slot: StageSlot, entry: TileChromeEntry, stage: StagePresenter, isShare: Boolean, modifier: Modifier) {
    if (slot.role != StageSlotRole.spotlightMain) return
    val model = entry.model
    if (!TileFeaturePolicy.showsUnpinTarget(role = slot.role, isPinned = model.isPinned, isShare = isShare)) return
    val size = TileFeaturePolicy.unpinTargetAndroid
    val label = conclaveString("stg_unpin_name", model.displayName)
    val top = TileFeaturePolicy.unpinTargetTopInset(density = TileChromeDensity.spotlight, targetSize = size)
    val end = TileFeaturePolicy.unpinTargetTrailingInset(model = model, density = TileChromeDensity.spotlight, targetSize = size)
    Box(
        modifier.padding(top = top.dp, end = end.dp).size(size.dp).testTag("stage.tile.unpin")
            .clickable(role = Role.Button, onClick = { stage.clearPin() })
            .clearAndSetSemantics { contentDescription = label; this.role = Role.Button },
    )
}

/**
 * 1:1 with the remote camera off (S20 3 d, 3 l4): the chrome centers the 96 dp avatar; the name (titleLarge) and
 * "Camera off" (bodyMedium, onSurfaceVariant) hang 8 dp below it. Hidden from TalkBack: the tile node says both.
 */
@Composable
private fun OneOnOneCameraOffCaption(slot: StageSlot, entry: TileChromeEntry, stage: StagePresenter, isShare: Boolean, modifier: Modifier) {
    if (slot.role != StageSlotRole.spotlightMain || isShare) return
    val model = entry.model
    if (model.isLocal || !model.isCameraOff) return
    if (!TileFeaturePolicy.showsOneOnOneCaption(kind = stage.kind, role = slot.role, isLocal = model.isLocal, isCameraOff = model.isCameraOff)) return
    val scheme = MaterialTheme.colorScheme
    val gap = (TileChromePolicy.avatarSize(TileChromeDensity.spotlight) / 2.0 + 8.0).dp
    Box(modifier.semantics { hideFromAccessibility() }) {
        Column(
            Modifier.belowCenter(gap).padding(horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ConclaveText(model.displayName, line = "stage.oneOnOne.name", style = MaterialTheme.typography.titleLarge,
                color = scheme.onSurface, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
            ConclaveText(conclaveString("stg_camera_off_caption"), line = "stage.oneOnOne.caption",
                style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
        }
    }
}

/**
 * The reconnect reason under the chrome's centered "Reconnecting" pill, then "Back online" for 4.5 s once the person is
 * back (S20 3 c; F00 C08 f; web STG-15), each change announced once through a polite live region. The pill fades
 * 120 ms. Remote tiles only; the first composition never announces.
 */
@Composable
private fun TileReconnectDetail(entry: TileChromeEntry, isShare: Boolean, modifier: Modifier) {
    val model = entry.model
    val reconnecting = model.isReconnecting && !model.isLocal && !isShare
    var backOnline by remember { mutableStateOf(false) }
    var wasReconnecting by remember { mutableStateOf(false) }
    var hasRun by remember { mutableStateOf(false) }
    var announcement by remember { mutableStateOf("") }
    val reason = tileReconnectReason(model.reconnectReason)
    val reconnectingWord = conclaveString("ds_state_reconnecting")
    val backOnlineWord = conclaveString("ds_state_back_online")
    LaunchedEffect(reconnecting) {
        val firstRun = !hasRun
        hasRun = true
        if (reconnecting) {
            wasReconnecting = true
            backOnline = false
            if (!firstRun) announcement = tileAnnouncementWords(listOf(model.displayName, reconnectingWord, reason))
            return@LaunchedEffect
        }
        if (!wasReconnecting) return@LaunchedEffect
        wasReconnecting = false
        backOnline = true
        announcement = tileAnnouncementWords(listOf(model.displayName, backOnlineWord))
        delay(TileFeaturePolicy.backOnlineMillis.toLong())
        backOnline = false
    }
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val density = LocalDensity.current
    // Half the chrome's labelMedium pill (16 sp line, 4 dp padding each side) plus 4 dp.
    val gap = with(density) { 8.sp.toDp() } + 8.dp
    Box(modifier) {
        if (reconnecting) {
            ConclaveText(reason, line = "tile.reconnect.reason", style = MaterialTheme.typography.labelSmall, color = scheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.belowCenter(gap).clip(CircleShape).background(ext.labelScrim)
                    .padding(horizontal = 8.dp, vertical = 2.dp).semantics { hideFromAccessibility() })
        }
        AnimatedVisibility(visible = backOnline, modifier = Modifier.align(Alignment.Center),
            enter = fadeIn(ConclaveMotion.fast()), exit = fadeOut(ConclaveMotion.fast())) {
            ConclaveText(backOnlineWord, line = "tile.reconnect.backOnline", style = MaterialTheme.typography.labelMedium,
                color = scheme.onSurface,
                modifier = Modifier.clip(CircleShape).background(ext.labelScrim).padding(horizontal = 8.dp, vertical = 4.dp)
                    .semantics { hideFromAccessibility() })
        }
        if (announcement.isNotEmpty()) {
            Box(Modifier.size(1.dp).semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = announcement
            })
        }
    }
}

@Composable
private fun tileReconnectReason(raw: String): String = when (TileFeaturePolicy.reconnectReasonKind(raw)) {
    "timeout" -> conclaveString("stg_reason_timeout")
    "network" -> conclaveString("stg_reason_network")
    else -> conclaveString("stg_reason_interrupted")
}

/** One announcement joined like the tile value. */
private fun tileAnnouncementWords(parts: List<String>): String = parts.filter { it.isNotEmpty() }.joinToString(", ")

/**
 * The renderer leaf: the only reader of the slot's RendererBinding (SL4); never an accessibility node, never inside a
 * lazy container or a branch that changes with the stage kind or slot role (D15). Probes and live renderers are both
 * keyed by slot id, so a promotion keeps the TextureView and swaps only the sink (SC10).
 */
@Composable
private fun StageRendererSlot(
    slotId: String, userId: String, isLocal: Boolean, isShare: Boolean, fit: StageVideoFit, binding: RendererBinding,
    stage: StagePresenter, renderers: StageRenderers, modifier: Modifier,
) {
    val videoKey = binding.videoKey
    Box(modifier.semantics { hideFromAccessibility() }) {
        if (renderers.usesProbes) {
            RendererProbe(key = slotId, slot = RendererSlot.stage, modifier = Modifier.fillMaxSize(), pattern = renderers.pattern)
        } else {
            // Only your own front camera mirrors; only your tile reads the chrome snapshot.
            val mirror = if (isLocal && !isShare) stage.chrome.isFrontCamera else false
            StageLiveVideo(slotId, userId, isLocal, isShare, videoKey, fit, mirror)
        }
    }
}

/**
 * WP3 bridge for the native call root behind the Debug `call` flag: the only stage code that reaches the live media
 * client. The track resolves again whenever the binding key changes; the renderer is keyed by slot id, so the
 * TextureView survives a consumer swap and DisposableEffect moves the sink on the main thread (RR6).
 */
@Composable
internal fun StageLiveVideo(slotId: String, userId: String, isLocal: Boolean, isShare: Boolean, videoKey: String, fit: StageVideoFit, mirror: Boolean) {
    val track = remember(videoKey, userId, isLocal, isShare) { stageLiveTrack(userId, isLocal, isShare, videoKey) }
    VideoTrackView(track = track, mirror = mirror, fit = fit == StageVideoFit.fit, rendererKey = "stage:$slotId", clearBeforeAttach = false)
}

internal fun stageLiveTrack(userId: String, isLocal: Boolean, isShare: Boolean, videoKey: String): VideoTrack? {
    if (videoKey.isEmpty()) return null
    val client = MeetingViewModel.shared.webRTCClient
    if (isLocal && !isShare) {
        return (client.getLocalVideoTrack() as? VideoTrackWrapper)?.rtcVideoTrack
    }
    val consumerUserId = if (isShare) "$userId-screen" else userId
    return client.remoteVideoTrack(forUserId = consumerUserId)?.rtcVideoTrack
}

/**
 * S20 2 d solo card (camera off, presence confirmed): Share invite through the share sheet with the F00 strings and
 * the room label as EXTRA_TITLE (no chooser title, SC21, RECONCILE R14) and Copy link through the clipboard with the
 * `linkCopied` gesture. Never the legacy MeetingShare (it plays a legacy success haptic).
 */
@Composable
internal fun StageSoloLayer(stage: StagePresenter, modifier: Modifier = Modifier) {
    val layout = stage.layout
    if (layout.kind != StageKind.solo || !layout.isAloneConfirmed || layout.meetingLink.isEmpty()) return
    val localId = if (layout.slots.count > 0) layout.slots[0].userId else return
    val entry = stage.tileChrome.entry(localId)
    if (!entry.model.isCameraOff) return
    Box(modifier.padding(start = 16.dp, end = 16.dp, bottom = StageCanvasMetrics.BAR_RESERVE_DP.dp), contentAlignment = Alignment.Center) {
        StageSoloCard(link = layout.meetingLink, roomLabel = stage.capsule.title)
    }
}

@Composable
private fun StageSoloCard(link: String, roomLabel: String) {
    val context = LocalContext.current
    val haptics = rememberConclaveHaptics()
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier.widthIn(max = 340.dp).testTag("stage.solo"),
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, ext.border),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ConclaveText(conclaveString("stg_solo_title"), line = "stage.solo.title", style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.semantics { heading() })
            ConclaveText(conclaveString("stg_solo_body"), line = "stage.solo.body", style = MaterialTheme.typography.bodyMedium,
                color = scheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = { stageShareMeetingLink(context, link, roomLabel) },
                    colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
                    modifier = Modifier.testTag("stage.solo.share"),
                ) {
                    ConclaveText(conclaveString("ds_share_invite"), line = "stage.solo.share")
                }
                TextButton(onClick = {
                    stageCopyMeetingLink(context, link, roomLabel)
                    haptics.gesture(FeedbackKind.linkCopied)
                }, modifier = Modifier.testTag("stage.solo.copy")) {
                    ConclaveText(conclaveString("stg_copy_link"), line = "stage.solo.copy", color = scheme.primary)
                }
            }
        }
    }
}

/** The localized share intent (SC21): subject and text from F00 11, EXTRA_TITLE = room label, no chooser title. */
internal fun stageShareMeetingLink(context: Context, link: String, roomLabel: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, conclaveStringOf(context, "ds_share_subject"))
        putExtra(Intent.EXTRA_TEXT, conclaveStringOf(context, "ds_share_text", link))
        putExtra(Intent.EXTRA_TITLE, roomLabel)
    }
    val chooser = Intent.createChooser(intent, null)
    val activity = UIApplication.shared.androidActivity
    try {
        if (activity != null) {
            // The chooser triggers onUserLeaveHint on several builds; keep the call full screen behind it.
            PipManager.suppressNextAutoEnter("meeting_share")
            activity.startActivity(chooser)
        } else {
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(chooser)
        }
    } catch (t: Throwable) {
        PipManager.restoreAutoEnterAfterExternalActivity()
    }
}

internal fun stageCopyMeetingLink(context: Context, link: String, roomLabel: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText(roomLabel, link))
}
