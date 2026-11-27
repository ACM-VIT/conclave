package conclave.module

import android.view.TextureView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import org.webrtc.EglBase
import org.webrtc.VideoTrack

internal object VideoRendererShared {
    val eglBase: EglBase = EglBase.create()
}

internal val LocalRendererFrameSizes = staticCompositionLocalOf<RendererFrameSizeStore?> { null }

@Composable
internal fun VideoTrackView(
    track: VideoTrack?,
    mirror: Boolean,
    fit: Boolean = false,
    useOverlaySurface: Boolean = false,
    rendererKey: Any? = null,
    clearBeforeAttach: Boolean = true,
    backing: StageVideoBacking = StageVideoBacking.Texture,
    cornerRadiusPx: Float = 0f,
) {
    val rendererLifecycleKey = rendererKey ?: if (useOverlaySurface) "overlay" else "meeting"
    if (backing != StageVideoBacking.Texture && track == null) {
        Box(Modifier.fillMaxSize().background(Color(DesignTokens.androidInCallBackground)))
        return
    }
    HostedVideoTrack(track, mirror, fit, rendererLifecycleKey, clearBeforeAttach, backing, cornerRadiusPx)
}

@Composable
private fun HostedVideoTrack(
    track: VideoTrack?, mirror: Boolean, fit: Boolean, rendererLifecycleKey: Any, clearBeforeAttach: Boolean,
    backing: StageVideoBacking, cornerRadiusPx: Float,
) {
    val context = LocalContext.current
    val ledger = LocalRendererLedger.current
    val host = remember(context, rendererLifecycleKey, backing) {
        val created: VideoHost = when (backing) {
            StageVideoBacking.Surface -> SurfaceVideoHost(context, VideoRenderLoop(), overlay = false)
            StageVideoBacking.OverlaySurface -> SurfaceVideoHost(context, VideoRenderLoop(), overlay = true)
            StageVideoBacking.Texture -> TextureVideoHost(context, VideoRenderLoop())
        }
        created.attachIdentity(ledger, rendererLifecycleKey.toString())
        created
    }

    DisposableEffect(track, host, clearBeforeAttach) {
        if (clearBeforeAttach || track == null) {
            host.clearImage()
        }
        val attachment = VideoSinkAttachment.attach(track, host.sink)
        onDispose {
            attachment.detach()
        }
    }

    DisposableEffect(host) {
        onDispose {
            host.releaseIdentity()
            host.clearImage()
            host.release()
        }
    }

    val frameSizes = LocalRendererFrameSizes.current
    val frameSlotId = RendererFrameSizeStore.slotId(rendererKey = rendererLifecycleKey.toString())
    DisposableEffect(host, frameSizes, frameSlotId) {
        host.attachFrameSizes(frameSizes, frameSlotId)
        onDispose { host.detachFrameSizes() }
    }

    key(host) {
        Box(Modifier.fillMaxSize()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { host.view },
                update = {
                    host.setMirror(mirror)
                    host.setFit(fit)
                    host.setCornerRadius(if (backing == StageVideoBacking.OverlaySurface) cornerRadiusPx else 0f)
                    if (it is TextureView) {
                        if (!it.isOpaque) {
                            it.isOpaque = true
                        }
                        if (it.alpha != 1f) {
                            it.alpha = 1f
                        }
                    }
                }
            )
            if (!host.hasFrame) {
                Box(Modifier.fillMaxSize().background(Color(DesignTokens.androidInCallBackground)))
            }
        }
    }
}
