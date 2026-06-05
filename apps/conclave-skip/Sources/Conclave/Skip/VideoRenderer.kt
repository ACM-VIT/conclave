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

    DisposableEffect(track) {
        track?.addSink(renderer)
        onDispose {
            track?.removeSink(renderer)
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
