package conclave.module

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.drawable.Animatable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.widget.ImageView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap

/**
 * Animated GIF surface for the custom meeting reactions. SkipUI's generic
 * AsyncImage currently decodes these URLs as a static bitmap on Android, and
 * the old Swift branch replaced them with text entirely. ImageDecoder keeps
 * the GIF animated on Android 9+; older supported devices get its first frame.
 */
@Composable
internal fun AnimatedReactionAsset(
    urlString: String,
    contentDescription: String
) {
    val context = LocalContext.current
    var drawable by remember(urlString) { mutableStateOf<Drawable?>(null) }
    var didFail by remember(urlString) { mutableStateOf(false) }

    LaunchedEffect(urlString) {
        drawable = null
        didFail = false
        val loaded = withContext(Dispatchers.IO) {
            runCatching {
                val bytes = ReactionAssetLoader.load(urlString)
                decodeReactionDrawable(context, bytes)
            }.getOrNull()
        }
        drawable = loaded
        didFail = loaded == null
    }

    val currentDrawable = drawable
    if (currentDrawable != null) {
        AndroidView(
            factory = { imageContext ->
                ImageView(imageContext).apply {
                    scaleType = ImageView.ScaleType.CENTER_INSIDE
                    this.contentDescription = contentDescription
                }
            },
            update = { imageView ->
                imageView.contentDescription = contentDescription
                if (imageView.drawable !== currentDrawable) {
                    (imageView.drawable as? Animatable)?.stop()
                    imageView.setImageDrawable(currentDrawable)
                }
                (currentDrawable as? Animatable)?.start()
            },
            modifier = Modifier.fillMaxSize()
        )

        DisposableEffect(currentDrawable) {
            (currentDrawable as? Animatable)?.start()
            onDispose {
                (currentDrawable as? Animatable)?.stop()
            }
        }
    } else {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Transparent),
            contentAlignment = Alignment.Center
        ) {
            if (didFail) {
                Text(
                    text = contentDescription.take(1).uppercase().ifEmpty { "✦" },
                    color = Color(0xFFF95F4A)
                )
            } else {
                CircularProgressIndicator(
                    color = Color(0xFFF95F4A),
                    strokeWidth = 1.5.dp
                )
            }
        }
    }
}

private fun decodeReactionDrawable(context: Context, bytes: ByteArray): Drawable? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        return ImageDecoder.decodeDrawable(
            ImageDecoder.createSource(ByteBuffer.wrap(bytes))
        )
    }
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
    return BitmapDrawable(context.resources, bitmap)
}

private object ReactionAssetLoader {
    private val client = OkHttpClient.Builder().build()
    private val memoryCache = ConcurrentHashMap<String, ByteArray>()

    fun load(urlString: String): ByteArray {
        memoryCache[urlString]?.let { return it }
        val request = Request.Builder()
            .url(urlString)
            .header("Accept", "image/gif,image/webp,image/*")
            .build()
        val bytes = client.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Reaction asset request failed (${response.code})" }
            response.body?.bytes() ?: error("Reaction asset response was empty")
        }
        memoryCache[urlString] = bytes
        return bytes
    }
}
