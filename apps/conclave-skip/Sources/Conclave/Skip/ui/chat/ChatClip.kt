package conclave.module

import android.graphics.Matrix
import android.view.TextureView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
import coil3.compose.AsyncImage
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import skip.lib.Array as SwiftArray

private val LocalChatClipPool = staticCompositionLocalOf<ChatClipPool?> { null }

internal interface ChatClipPlayback {
    val id: String
    fun play()
    fun stop()
}

internal class ChatClipPool {
    private val clips = linkedMapOf<String, ChatClipPlayback>()
    private var visible = emptyList<String>()
    private val visibleAttachments = mutableSetOf<String>()
    private var requested = emptyList<String>()
    private var active = false
    private var reduceMotion = false

    fun register(clip: ChatClipPlayback) {
        clips[clip.id]?.takeIf { it !== clip }?.stop()
        clips[clip.id] = clip
        reconcile()
    }

    fun remove(clip: ChatClipPlayback) {
        clip.stop()
        if (clips[clip.id] === clip) {
            clips.remove(clip.id)
            visibleAttachments.remove(clip.id)
            requested = requested.filterNot { it == clip.id }
        }
        reconcile()
    }

    fun visibility(ids: List<String>) {
        visible = ids
        requested = requested.filter { it in ids }
        reconcile()
    }

    fun attachmentVisibility(id: String, visible: Boolean) {
        val changed = if (visible) visibleAttachments.add(id) else visibleAttachments.remove(id)
        if (changed) {
            if (!visible) requested = requested.filterNot { it == id }
            reconcile()
        }
    }

    fun lifecycle(active: Boolean, reduceMotion: Boolean) {
        this.active = active
        this.reduceMotion = reduceMotion
        if (!active) requested = emptyList()
        reconcile()
    }

    fun request(id: String) {
        requested = listOf(id) + requested.filterNot { it == id }
        reconcile()
    }

    private fun reconcile() {
        val selected = ChatClipPlaybackPolicy.playingIDs(
            visibleIDs = SwiftArray(visible.filter { it in clips && it in visibleAttachments }), requestedIDs = SwiftArray(requested),
            reduceMotion = reduceMotion, panelOpen = active, appActive = active).toList()
        clips.values.filter { it.id !in selected }.forEach { it.stop() }
        selected.forEach { clips[it]?.play() }
    }
}

@Composable
internal fun ChatClipPlaybackHost(listState: LazyListState, content: @Composable () -> Unit) {
    val pool = remember { ChatClipPool() }
    val reduceMotion = rememberReduceMotion()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(pool, lifecycle, reduceMotion) {
        fun update() = pool.lifecycle(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED), reduceMotion)
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer)
        update()
        onDispose {
            lifecycle.removeObserver(observer)
            pool.lifecycle(false, reduceMotion)
        }
    }
    LaunchedEffect(pool, listState) {
        snapshotFlow {
            val layout = listState.layoutInfo
            layout.visibleItemsInfo.filter {
                val visibleSize = minOf(it.offset + it.size, layout.viewportEndOffset) - maxOf(it.offset, layout.viewportStartOffset)
                visibleSize > 0
            }.map { it.key.toString() }
        }.collect { pool.visibility(it) }
    }
    CompositionLocalProvider(LocalChatClipPool provides pool, content = content)
}

internal class ChatClipController(override val id: String, private val url: String, private val context: android.content.Context) : ChatClipPlayback {
    var ready by mutableStateOf(false)
        private set
    var playing by mutableStateOf(false)
        private set
    var muted by mutableStateOf(true)
        private set
    private var player: ExoPlayer? = null
    private var texture: TextureView? = null
    private var videoSize = VideoSize.UNKNOWN

    fun attach(view: TextureView) {
        texture = view
        view.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fit() }
        player?.setVideoTextureView(view)
    }

    override fun play() {
        if (playing) return
        val next = ExoPlayer.Builder(context)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), false)
            .build()
        next.volume = if (muted) 0f else 1f
        next.repeatMode = Player.REPEAT_MODE_ONE
        next.addListener(object : Player.Listener {
            override fun onRenderedFirstFrame() { if (player === next) ready = true }
            override fun onVideoSizeChanged(size: VideoSize) {
                if (player === next) {
                    videoSize = size
                    fit()
                }
            }
        })
        player = next
        texture?.let { next.setVideoTextureView(it) }
        next.setMediaItem(MediaItem.fromUri(url))
        playing = true
        next.prepare()
        next.play()
    }

    private fun fit() {
        val view = texture ?: return
        if (view.width <= 0 || view.height <= 0 || videoSize.height <= 0) return
        val videoAspect = videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height
        val viewAspect = view.width.toFloat() / view.height
        val matrix = Matrix()
        if (videoAspect > viewAspect) matrix.setScale(1f, viewAspect / videoAspect, view.width / 2f, view.height / 2f)
        else matrix.setScale(videoAspect / viewAspect, 1f, view.width / 2f, view.height / 2f)
        view.setTransform(matrix)
    }

    fun toggleMute() {
        muted = !muted
        player?.volume = if (muted) 0f else 1f
    }

    override fun stop() {
        player?.pause()
        player?.clearVideoTextureView(texture)
        player?.release()
        player = null
        playing = false
        ready = false
        muted = true
    }

    fun detach() {
        stop()
        texture = null
    }
}

@Composable
internal fun ChatClipAttachment(row: ChatRowModel, modifier: Modifier = Modifier) {
    val context = LocalContext.current.applicationContext
    val pool = LocalChatClipPool.current
    val url = row.gifVideoURL.ifEmpty { row.gifURL }
    val clip = remember(row.id, url) { ChatClipController(row.id, url, context) }
    val width = ChatMediaGeometry.gifWidth.dp
    val height = ChatMediaGeometry.gifHeight(row.gifAspect).dp
    val density = LocalDensity.current
    val widthPx = with(density) { width.roundToPx() }
    val heightPx = with(density) { height.roundToPx() }
    val poster = row.gifPreviewURL.ifEmpty { row.gifURL }
    val posterRequest = remember(context, poster, widthPx, heightPx) {
        ChatImageRequests.request(context, poster, widthPx, heightPx, false, 0)
    }
    DisposableEffect(clip, pool) {
        pool?.register(clip)
        onDispose {
            pool?.remove(clip)
            clip.detach()
        }
    }
    Box(modifier.size(width, height).clipToBounds().background(Color.Black).onGloballyPositioned { coordinates ->
        val bounds = coordinates.boundsInWindow()
        pool?.attachmentVisibility(row.id, bounds.width > 0 && bounds.height > 0 && bounds.height >= coordinates.size.height * 0.5f)
    }, contentAlignment = Alignment.Center) {
        key(clip) {
            AndroidView(factory = { TextureView(it).also { view -> clip.attach(view) } }, modifier = Modifier.size(width, height))
        }
        if (!clip.ready) AsyncImage(model = posterRequest, contentDescription = null,
            contentScale = ContentScale.Fit, modifier = Modifier.size(width, height))
        if (!clip.playing) ChatClipButton(conclaveString("chat_clip_play"), Modifier.testTag("chat.row.${row.id}.clip.play"), { pool?.request(row.id) }) {
            Icon(ConclaveIcons.PlayArrowFill1, contentDescription = it, tint = Color.White, modifier = Modifier.size(20.dp))
        }
        ChatClipButton(conclaveString(if (clip.muted) "chat_clip_unmute" else "chat_clip_mute"),
            Modifier.align(Alignment.BottomEnd).padding(8.dp).testTag("chat.row.${row.id}.clip.mute"), {
                pool?.request(row.id)
                clip.toggleMute()
            }) {
            Icon(if (clip.muted) ConclaveIcons.VolumeOffFill1 else ConclaveIcons.VolumeUpFill0,
                contentDescription = it, tint = Color.White, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun ChatClipButton(label: String, modifier: Modifier, onClick: () -> Unit, icon: @Composable (String) -> Unit) {
    val border = with(LocalDensity.current) { 1f.toDp() }
    Surface(onClick = onClick, modifier = modifier.size(36.dp), shape = CircleShape,
        color = Color(0xFF141414), border = BorderStroke(border, Color.White.copy(alpha = 0.35f))) {
        Box(contentAlignment = Alignment.Center) { icon(label) }
    }
}
