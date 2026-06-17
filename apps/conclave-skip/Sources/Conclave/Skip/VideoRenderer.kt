package conclave.module

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.foundation.layout.fillMaxSize
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

internal object VideoRendererShared {
    val eglBase: EglBase = EglBase.create()
}

@Composable
internal fun VideoTrackView(track: VideoTrack?, mirror: Boolean, fit: Boolean = false) {
    val context = LocalContext.current
    val eglBase = VideoRendererShared.eglBase
    val renderer = remember {
        SurfaceViewRenderer(context).apply {
            init(eglBase.eglBaseContext, null)
            setEnableHardwareScaler(true)
        }
    }

    // Sink attachment is keyed on the track: when the track changes (active
    // speaker swap, camera re-toggle producing a new track, PiP's ~400ms video
    // updates) we detach the old track and attach the new one — but we must NOT
    // release the renderer here, or the SAME remembered SurfaceViewRenderer is
    // permanently torn down (EGL surface + render thread gone) and every
    // subsequent track renders black.
    DisposableEffect(track) {
        track?.addSink(renderer)
        onDispose {
            track?.removeSink(renderer)
        }
    }

    // The renderer's EGL/render-thread lifetime is tied to the composable, not
    // the track. Release exactly once, when the composable finally leaves the
    // composition.
    DisposableEffect(Unit) {
        onDispose {
            renderer.release()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { renderer },
        update = {
            it.setMirror(mirror)
            // Cameras crop-to-fill (Meet standard); a screen-share letterboxes
            // on black so it is never distorted.
            it.setScalingType(
                if (fit) RendererCommon.ScalingType.SCALE_ASPECT_FIT
                else RendererCommon.ScalingType.SCALE_ASPECT_FILL
            )
        }
    )
}
