package conclave.module

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
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
        StageSlot.activityId -> StageActivityCard(stage.layout.activityKind, modifier)
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
    Box(modifier) {
        ConclaveTileChrome(
            model = model,
            speaking = speaking,
            identifier = "stage.tile.${slot.id}",
            modifier = Modifier.fillMaxSize(),
            variant = if (role.isSelfView) ConclaveTileVariant.SelfView else ConclaveTileVariant.Grid,
            spotlight = role == StageSlotRole.spotlightMain,
            cornerRadius = stageCornerRadius(role),
        ) {
            StageRendererSlot(slot.id, slot.userId, model.isLocal, isShare, slot.fit, binding, stage, renderers,
                Modifier.fillMaxSize().graphicsLayer { alpha = if (minimized) 0f else 1f })
        }
        if (minimized) {
            ConclaveStageChip(title = conclaveString("ds_you"), identifier = "stage.selfView.minimized",
                modifier = Modifier.align(Alignment.Center), onClick = { stage.setSelfViewMode("floating") })
        }
    }
}

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

/** The activity card placeholder (S20 11): a flat raised surface; STG-9 hosts the content. */
@Composable
private fun StageActivityCard(kind: String, modifier: Modifier) {
    val ext = LocalConclaveExtendedColors.current
    Surface(
        modifier = modifier.testTag("stage.activity.$kind"),
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, ext.border),
    ) {}
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
