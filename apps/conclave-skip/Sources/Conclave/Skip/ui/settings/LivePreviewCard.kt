package conclave.module

import android.content.Context
import android.view.ViewGroup
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

/*
 * S60 0.6 L6-3 (SET-3; C6-3, C6-8; 1 d, 1 f, 1 i, 1 k, 1 l11, 1 l12; RECONCILE R22) on Android: the dark 4:3
 * LivePreviewCard inside the system-appearance Settings list, composed in HostingTheme(inCall = true). It reads
 * settings.video only. The capture belongs to the one WP3 LocalPreviewController (the presenter asks it through
 * previewHooks); this card draws the surface and offers Start preview and Stop preview. The local preview keeps one
 * PreviewView per panel presentation (SettingsPreviewRenderers, keyed by the presentation id that SettingsPage provides):
 * the LazyColumn item leaving composition detaches it from the controller and its parent, and the item coming back
 * re-attaches the same view. The item's composition reports on and off screen (30 s off screen stops the preview,
 * C6-8). While the meeting camera is on the card shows the sent track ("Visible to everyone") through VideoTrackView,
 * outside the stage renderer ledger. Mirroring follows Mirror my video for the front camera only (C6-3).
 */

/** The Settings panel presentation id, so the card keeps one PreviewView per presentation (0 outside the panel). */
internal val LocalSettingsPresentationId = staticCompositionLocalOf { 0 }

@Composable
internal fun LivePreviewCard(settings: SettingsPresenter, modifier: Modifier = Modifier) {
    val video = settings.video
    DisposableEffect(settings) {
        settings.previewCardVisible(true)
        onDispose { settings.previewCardVisible(false) }
    }
    val label = conclaveString("set_camera_preview")
    val value = livePreviewValue(video)
    val startLabel = conclaveString("set_start_preview")
    val stopLabel = conclaveString("set_stop_preview")
    val canStop = SettingsPreviewPolicy.canStop(state = video.preview)
    HostingTheme(inCall = true) {
        val ext = LocalConclaveExtendedColors.current
        val shape = RoundedCornerShape(DesignTokens.radiusTile.dp)
        Box(
            modifier.fillMaxWidth().aspectRatio(4f / 3f).clip(shape).border(1.dp, ext.border, shape).background(ext.tile)
                .semantics {
                    contentDescription = label
                    stateDescription = value
                    customActions = when {
                        video.canStartPreview -> listOf(CustomAccessibilityAction(startLabel) { settings.startPreview(); true })
                        canStop -> listOf(CustomAccessibilityAction(stopLabel) { settings.stopPreview(); true })
                        else -> emptyList()
                    }
                }
                .testTag("settings.preview.card"),
            contentAlignment = Alignment.Center,
        ) {
            LivePreviewSurfaceOrIdle(settings, video)
            if (video.preview == PreviewState.starting) {
                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onSurface)
            }
            if (video.preview == PreviewState.interrupted) {
                LivePreviewCaption(conclaveString("stg_camera_paused"), "settings.preview.paused")
            }
            if (video.preview == PreviewState.blocked) {
                LivePreviewBlocked(settings)
            }
            val status = SettingsCopy.previewStatusName(video.preview)
            if (status != null) {
                LivePreviewCaption(conclaveString(status), "settings.preview.status", Modifier.align(Alignment.TopStart).padding(12.dp))
            }
            LivePreviewButton(settings, video, Modifier.align(Alignment.BottomEnd).padding(12.dp))
        }
    }
}

@Composable
private fun livePreviewValue(video: SettingsVideo): String {
    val reason = SettingsCopy.previewReasonName(video.previewReason)
    if (reason != null) return conclaveString(reason)
    val status = SettingsCopy.previewStatusName(video.preview)
    if (status != null) return conclaveString(status)
    return conclaveString("set_camera_off_preview")
}

@Composable
private fun LivePreviewSurfaceOrIdle(settings: SettingsPresenter, video: SettingsVideo) {
    val mirrored = LocalVideoMirrorPolicy.mirrors(isFront = video.cameraFacing == "front", preference = video.mirrorsSelfView)
    val local = video.preview == PreviewState.live || video.preview == PreviewState.interrupted || video.preview == PreviewState.starting
    when {
        settings.usesLiveRenderers && local -> LivePreviewLocalSurface()
        settings.usesLiveRenderers && video.preview == PreviewState.published -> LivePreviewSentTrack(mirrored)
        video.preview != PreviewState.blocked -> LivePreviewIdle(video)
    }
}

/** The local preview: the presentation's PreviewView, attached to the one controller while composed. */
@Composable
private fun LivePreviewLocalSurface() {
    val presentationId = LocalSettingsPresentationId.current
    AndroidView(
        factory = { context ->
            val view = SettingsPreviewRenderers.previewView(context, presentationId)
            (view.parent as? ViewGroup)?.removeView(view)
            LocalPreviewController.shared.attach(view)
            view
        },
        modifier = Modifier.fillMaxSize().clearAndSetSemantics { }.testTag("settings.preview.surface"),
        onRelease = { view ->
            LocalPreviewController.shared.detach(view)
            (view.parent as? ViewGroup)?.removeView(view)
        },
    )
}

/** The sent track while the meeting camera is on, outside the stage renderer ledger (stage.renderers unchanged). */
@Composable
private fun LivePreviewSentTrack(mirrored: Boolean) {
    val presentationId = LocalSettingsPresentationId.current
    // Read on every composition (a camera restart makes a new track); VideoTrackView moves the sink only on a change.
    val track = (MeetingViewModel.shared.webRTCClient.getLocalVideoTrack() as? VideoTrackWrapper)?.rtcVideoTrack
    CompositionLocalProvider(LocalRendererLedger provides null) {
        VideoTrackView(track = track, mirror = mirrored, fit = false, rendererKey = "settings:preview:$presentationId",
            clearBeforeAttach = true)
    }
}

@Composable
private fun LivePreviewIdle(video: SettingsVideo) {
    val scheme = MaterialTheme.colorScheme
    val off = video.isAudioOnly || video.preview == PreviewState.unavailable
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(horizontal = 24.dp),
    ) {
        Icon(if (off) ConclaveIcons.VideocamOffFill1 else ConclaveIcons.VideocamFill1, contentDescription = null,
            tint = scheme.onSurfaceVariant)
        if (video.preview == PreviewState.unavailable) {
            ConclaveText(conclaveString("set_camera_unavailable"), line = "settings.preview.unavailable",
                style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        if (video.isAudioOnly) {
            ConclaveText(conclaveString("set_audio_only_reason"), line = "settings.preview.audioOnly",
                style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun LivePreviewCaption(text: String, identifier: String, modifier: Modifier = Modifier) {
    val ext = LocalConclaveExtendedColors.current
    ConclaveText(text, line = identifier, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface,
        maxLines = 2,
        modifier = modifier.clip(CircleShape).background(ext.labelScrim).padding(horizontal = 10.dp, vertical = 4.dp).testTag(identifier))
}

/** "Camera access is off" with Open settings (F00 C18 intrinsic copy). */
@Composable
private fun LivePreviewBlocked(settings: SettingsPresenter) {
    val scheme = MaterialTheme.colorScheme
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(horizontal = 24.dp),
    ) {
        ConclaveText(conclaveString("set_camera_access_off"), line = "settings.preview.blocked",
            style = MaterialTheme.typography.bodyMedium, color = scheme.onSurface, textAlign = TextAlign.Center)
        TextButton(onClick = { settings.openCameraSettings() }, modifier = Modifier.heightIn(min = 48.dp).testTag("settings.preview.openSettings")) {
            ConclaveText(conclaveString("ds_open_settings"), line = "settings.preview.openSettings.title", color = scheme.primary)
        }
    }
}

/** Start preview or Stop preview: a flat pill on the scrim, 48 dp tall; disabled while interrupted (1 l11). */
@Composable
private fun LivePreviewButton(settings: SettingsPresenter, video: SettingsVideo, modifier: Modifier) {
    val stopping = SettingsPreviewPolicy.canStop(state = video.preview)
    val offersStart = !stopping && video.preview != PreviewState.published && video.preview != PreviewState.blocked
    if (!stopping && !offersStart) return
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val enabled = stopping || video.canStartPreview
    val identifier = if (stopping) "settings.preview.stop" else "settings.preview.start"
    Box(
        modifier.heightIn(min = 48.dp).clip(CircleShape).background(ext.labelScrim).border(1.dp, ext.border, CircleShape)
            .clickable(enabled = enabled, role = Role.Button) {
                if (stopping) settings.stopPreview() else settings.startPreview()
            }
            .padding(horizontal = 16.dp)
            .testTag(identifier),
        contentAlignment = Alignment.Center,
    ) {
        ConclaveText(conclaveString(if (stopping) "set_stop_preview" else "set_start_preview"), line = "$identifier.title",
            style = MaterialTheme.typography.labelLarge,
            color = if (enabled) scheme.onSurface else scheme.onSurface.copy(alpha = ConclaveDisabledOpacity.android.toFloat()))
    }
}

/** One PreviewView per Settings presentation; a new presentation makes a new view and drops the old one (1 l12). */
internal object SettingsPreviewRenderers {
    private var key = -1
    private var view: PreviewView? = null

    /** Debug renderer counter: views created; scrolling out and back keeps it unchanged. */
    internal var creationCount: Int = 0
        private set

    fun previewView(context: Context, presentationId: Int): PreviewView {
        val current = view
        if (current != null && key == presentationId) return current
        if (current != null) {
            LocalPreviewController.shared.detach(current)
            (current.parent as? ViewGroup)?.removeView(current)
        }
        val made = LocalPreviewController.shared.makePreviewView(context.applicationContext ?: context)
        creationCount += 1
        key = presentationId
        view = made
        return made
    }

    /** The panel closed: the view is detached and dropped. */
    fun release(presentationId: Int) {
        if (key != presentationId) return
        val current = view ?: return
        LocalPreviewController.shared.detach(current)
        (current.parent as? ViewGroup)?.removeView(current)
        view = null
        key = -1
    }
}
