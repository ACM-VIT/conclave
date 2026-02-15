package conclave.module

import android.media.projection.MediaProjection

object ScreenCaptureManager {
    private var mediaProjection: MediaProjection? = null
    private var onMediaProjectionReady: ((MediaProjection?) -> Unit)? = null
    private var onMediaProjectionStopped: (() -> Unit)? = null
    
    fun setCallbacks(
        onReady: (MediaProjection?) -> Unit,
        onStopped: () -> Unit
    ) {
        onMediaProjectionReady = onReady
        onMediaProjectionStopped = onStopped
        
        mediaProjection?.let {
            onReady(it)
        }
    }
    
    fun clearCallbacks() {
        onMediaProjectionReady = null
        onMediaProjectionStopped = null
    }
    
    fun onMediaProjectionReady(projection: MediaProjection?) {
        mediaProjection = projection
        onMediaProjectionReady?.invoke(projection)
    }
    
    fun onMediaProjectionStopped() {
        mediaProjection = null
        onMediaProjectionStopped?.invoke()
    }
    
    fun getMediaProjection(): MediaProjection? = mediaProjection
}
