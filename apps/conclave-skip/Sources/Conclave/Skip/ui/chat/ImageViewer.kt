package conclave.module

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import coil3.compose.AsyncImage
import coil3.compose.AsyncImagePainter
import coil3.decode.BitmapFactoryDecoder
import coil3.request.ImageRequest
import coil3.request.crossfade
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import skip.ui.UIApplication

internal object ChatPhotoCodec {

    @JvmStatic
    fun transcodeToJpeg(inputPath: String, outputPath: String, maxDimension: Int, quality: Int): Int {
        return try {
            val source = ImageDecoder.createSource(File(inputPath))
            val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                val width = info.size.width
                val height = info.size.height
                val longest = maxOf(width, height)
                if (longest > maxDimension && longest > 0) {
                    val scale = maxDimension.toDouble() / longest.toDouble()
                    decoder.setTargetSize(maxOf(1, (width * scale).toInt()), maxOf(1, (height * scale).toInt()))
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
            val output = File(outputPath)
            output.parentFile?.mkdirs()
            val written = FileOutputStream(output).use { stream -> bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream) }
            bitmap.recycle()
            if (!written) -1 else output.length().toInt()
        } catch (failure: Throwable) {
            -1
        }
    }
}

internal class ChatPickedFile(val fileUrl: String, val mimeType: String, val fileName: String)

internal object ChatPhotoFiles {

    fun authority(context: Context): String = context.packageName + ".fileprovider"

    fun directory(context: Context): File = File(context.cacheDir, ChatPhotoPreparer.directoryName).apply { mkdirs() }

    suspend fun copyToCache(context: Context, uri: Uri, tooLarge: () -> Unit): ChatPickedFile? = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        var name = "photo"
        var size = -1L
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
                }
            }
        }
        if (size > ChatPhotoPolicy.maxInputBytes.toLong()) {
            withContext(Dispatchers.Main) { tooLarge() }
            return@withContext null
        }
        val mime = resolver.getType(uri) ?: "image/jpeg"
        val extension = name.substringAfterLast('.', "").lowercase().ifEmpty { "jpg" }
        val target = File(directory(context), UUID.randomUUID().toString() + "." + extension)
        val copied = runCatching {
            resolver.openInputStream(uri)?.use { input -> FileOutputStream(target).use { output -> input.copyTo(output) } } != null
        }.getOrDefault(false)
        if (!copied) {
            target.delete()
            return@withContext null
        }
        ChatPickedFile(Uri.fromFile(target).toString(), mime, name)
    }

    suspend fun shareFile(context: Context, url: String): File? = withContext(Dispatchers.IO) {
        runCatching {
            val folder = File(directory(context), "share").apply { mkdirs() }
            val target = File(folder, "photo-" + url.hashCode().toUInt().toString() + ".img")
            val parsed = Uri.parse(url)
            if (parsed.scheme == "file") {
                File(parsed.path ?: "").inputStream().use { input -> FileOutputStream(target).use { input.copyTo(it) } }
            } else {
                java.net.URL(url).openStream().use { input -> FileOutputStream(target).use { input.copyTo(it) } }
            }
            target
        }.getOrNull()
    }

    fun share(context: Context, file: File, title: String): Boolean {
        return try {
            val uri = FileProvider.getUriForFile(context, authority(context), file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "image/*"
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri(title, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, null)
            val activity = UIApplication.shared.androidActivity
            if (activity != null) {
                PipManager.suppressNextAutoEnter("photo_share")
                activity.startActivity(chooser)
            } else {
                context.startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            true
        } catch (failure: Throwable) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            false
        }
    }
}

internal object ChatImageRequests {

    fun request(context: Context, url: String, widthPx: Int, heightPx: Int, animate: Boolean, crossfadeMillis: Int): ImageRequest {
        val builder = ImageRequest.Builder(context)
            .data(url)
            .size(maxOf(1, widthPx), maxOf(1, heightPx))
            .crossfade(crossfadeMillis)
        if (!animate) builder.decoderFactory(BitmapFactoryDecoder.Factory())
        return builder.build()
    }
}

@Composable
internal fun ChatImageBox(
    url: String, width: Dp, height: Dp, modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(8.dp),
    placeholder: Color = MaterialTheme.colorScheme.surfaceContainerHighest, failureText: String = "", retriesOnTap: Boolean = false,
    animate: Boolean = false, description: String? = null, onOpen: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val reduceMotion = rememberReduceMotion()
    var attempt by remember(url) { mutableIntStateOf(0) }
    var phase by remember(url) { mutableIntStateOf(0) }
    val widthPx = with(density) { width.roundToPx() }
    val heightPx = with(density) { height.roundToPx() }
    val playing = animate && !reduceMotion
    val request = remember(url, widthPx, heightPx, attempt, playing) {
        ChatImageRequests.request(context, url, widthPx, heightPx, playing, if (reduceMotion) 0 else 150)
    }
    val retryLabel = conclaveString("chat_ax_retry_photo")
    val failed = phase == 2
    val tap: Modifier = when {
        failed && retriesOnTap -> Modifier.clickable(role = Role.Button, onClickLabel = retryLabel) {
            phase = 0
            attempt += 1
        }
        !failed && phase == 1 && onOpen != null -> Modifier.clickable(role = Role.Button) { onOpen() }
        else -> Modifier
    }
    val semantics = if (description != null) {
        Modifier.semantics {
            contentDescription = description
            if (failed && retriesOnTap) {
                customActions = listOf(CustomAccessibilityAction(retryLabel) {
                    phase = 0
                    attempt += 1
                    true
                })
            }
        }
    } else Modifier
    Box(modifier.size(width, height).clip(shape).background(placeholder).then(tap).then(semantics),
        contentAlignment = Alignment.Center) {
        AsyncImage(
            model = request,
            contentDescription = null,
            modifier = Modifier.size(width, height).clearAndSetSemantics { },
            contentScale = ContentScale.Crop,
            onState = { state ->
                phase = when (state) {
                    is AsyncImagePainter.State.Success -> 1
                    is AsyncImagePainter.State.Error -> 2
                    else -> if (phase == 1) 1 else 0
                }
            },
        )
        if (phase == 0) CircularProgressIndicator(Modifier.size(24.dp).clearAndSetSemantics { })
        if (failed) {
            Column(Modifier.padding(8.dp).clearAndSetSemantics { }, horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(ConclaveIcons.ImageFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                if (failureText.isNotEmpty()) {
                    ConclaveText(failureText, line = "chat.media.failed", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, maxLines = 3)
                }
            }
        }
    }
}

internal object ChatMediaCopyAndroid {
    @Composable
    fun failureReason(failure: ChatFailure): String = when (failure) {
        ChatFailure.photoTooLarge -> conclaveString("chat_fail_photo_too_large")
        ChatFailure.photoType -> conclaveString("chat_fail_photo_type")
        ChatFailure.photoUnavailable -> conclaveString("chat_fail_photo_unavailable")
        ChatFailure.photoBlocked -> conclaveString("chat_fail_photo_blocked")
        ChatFailure.photoRateLimited -> conclaveString("chat_fail_photo_rate")
        ChatFailure.photosDisabled -> conclaveString("chat_fail_photos_disabled")
        else -> ChatCopyAndroid.failureReason(failure)
    }

    @Composable
    fun attachReason(reason: String): String = when (reason) {
        "privateTextOnly" -> conclaveString("chat_reason_private_text")
        "photosDisabled" -> conclaveString("chat_reason_photos_off")
        "voiceDisabled" -> conclaveString("chat_reason_voice_off")
        else -> ""
    }

    @Composable
    fun attachmentStatus(attachment: ChatAttachmentState): String = when (attachment.phase) {
        ChatAttachmentPhase.preparing -> conclaveString("chat_attachment_preparing")
        ChatAttachmentPhase.uploading -> if (attachment.progress < 0) conclaveString("chat_attachment_uploading_indeterminate")
            else conclaveString("chat_attachment_uploading", (attachment.progress * 100).toInt())
        ChatAttachmentPhase.ready -> conclaveString("chat_attachment_ready")
        ChatAttachmentPhase.failed -> failureReason(attachment.failure)
        else -> ""
    }

    @Composable
    fun photoLabel(row: ChatRowModel): String {
        val label = conclaveString("chat_photo_label", ChatCopyAndroid.senderName(row))
        return if (row.photoCaptionIsEmpty || row.plainText.isEmpty()) label else label + ", " + row.plainText
    }

    @Composable
    fun gifLabel(title: String, kind: ChatGifKind): String {
        val trimmed = title.trim()
        if (trimmed.isNotEmpty()) return trimmed
        return when (kind) {
            ChatGifKind.sticker -> conclaveString("chat_sticker")
            ChatGifKind.clip -> conclaveString("chat_clip")
            else -> conclaveString("chat_reply_gif")
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatImageViewer(presenter: ChatPresenter, rowId: String, onDismiss: () -> Unit) {
    val row = presenter.rows.entry(rowId).row
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var immersive by remember(rowId) { mutableStateOf(false) }
    var shareFile by remember(rowId) { mutableStateOf<File?>(null) }
    var attempt by remember(rowId) { mutableIntStateOf(0) }
    var phase by remember(rowId) { mutableIntStateOf(0) }
    var scale by remember(rowId) { mutableFloatStateOf(1f) }
    var offset by remember(rowId) { mutableStateOf(Offset.Zero) }
    var box by remember(rowId) { mutableStateOf(IntSize.Zero) }
    LaunchedEffect(rowId) { shareFile = ChatPhotoFiles.shareFile(context, row.photoURL) }
    val shareTitle = conclaveString("chat_action_share_photo")
    Dialog(onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        HostingTheme {
            val dark = conclaveUsesDarkAppearance()
            val view = LocalView.current
            SideEffect {
                val window = (view.parent as? DialogWindowProvider)?.window
                if (window != null) {
                    val controller = WindowCompat.getInsetsController(window, view)
                    controller.isAppearanceLightStatusBars = !dark && !immersive
                    controller.isAppearanceLightNavigationBars = !dark && !immersive
                }
            }
            val scheme = MaterialTheme.colorScheme
            val backdrop = if (immersive) Color(DesignTokens.neutralBlack) else scheme.surface
            val subtitle = conclaveString("chat_photo_subtitle", ChatCopyAndroid.senderName(row), ChatCopyAndroid.time(context, row.timestampMillis))
            Scaffold(
                modifier = Modifier.fillMaxSize().testTag("chat.photoViewer").semantics { testTagsAsResourceId = true },
                containerColor = backdrop,
                contentWindowInsets = WindowInsets.safeDrawing,
                topBar = {
                    if (!immersive) {
                        TopAppBar(
                            title = {
                                Column {
                                    ConclaveText(conclaveString("chat_photo_title"), line = "chat.photoViewer.title")
                                    ConclaveText(subtitle, line = "chat.photoViewer.subtitle", style = MaterialTheme.typography.bodySmall,
                                        color = scheme.onSurfaceVariant, maxLines = 1)
                                }
                            },
                            navigationIcon = {
                                IconButton(onClick = onDismiss, modifier = Modifier.testTag("chat.photoViewer.back")) {
                                    Icon(ConclaveIcons.ArrowBackFill0, contentDescription = conclaveString("ds_back"))
                                }
                            },
                            actions = {
                                val file = shareFile
                                IconButton(onClick = { if (file != null) ChatPhotoFiles.share(context, file, shareTitle) },
                                    enabled = file != null, modifier = Modifier.testTag("chat.photoViewer.share")) {
                                    Icon(ConclaveIcons.ShareFill0, contentDescription = shareTitle)
                                }
                            },
                            colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),
                        )
                    }
                },
            ) { padding ->
                Column(Modifier.fillMaxSize().padding(padding)) {
                    Box(Modifier.weight(1f).fillMaxWidth().onSizeChanged { box = it }, contentAlignment = Alignment.Center) {
                        val widthPx = maxOf(1, box.width)
                        val heightPx = maxOf(1, box.height)
                        val request = remember(row.photoURL, widthPx, heightPx, attempt) {
                            ChatImageRequests.request(context, row.photoURL, widthPx, heightPx, animate = true, crossfadeMillis = 0)
                        }
                        val label = ChatMediaCopyAndroid.photoLabel(row)
                        AsyncImage(
                            model = request,
                            contentDescription = label,
                            modifier = Modifier.fillMaxSize()
                                .pointerInput(rowId) {
                                    detectTransformGestures { _, pan, zoom, _ ->
                                        scale = (scale * zoom).coerceIn(1f, 4f)
                                        val limitX = box.width * (scale - 1f) / 2f
                                        val limitY = box.height * (scale - 1f) / 2f
                                        offset = if (scale <= 1f) Offset.Zero
                                            else Offset((offset.x + pan.x).coerceIn(-limitX, limitX), (offset.y + pan.y).coerceIn(-limitY, limitY))
                                    }
                                }
                                .pointerInput(rowId) {
                                    detectTapGestures(
                                        onDoubleTap = {
                                            scale = if (scale > 1f) 1f else 2.5f
                                            offset = Offset.Zero
                                        },
                                        onTap = { immersive = !immersive },
                                    )
                                }
                                .graphicsLayer {
                                    scaleX = scale
                                    scaleY = scale
                                    translationX = offset.x
                                    translationY = offset.y
                                },
                            contentScale = ContentScale.Fit,
                            onState = { state ->
                                phase = when (state) {
                                    is AsyncImagePainter.State.Success -> 1
                                    is AsyncImagePainter.State.Error -> 2
                                    else -> if (phase == 1) 1 else 0
                                }
                            },
                        )
                        if (phase == 0) CircularProgressIndicator()
                        if (phase == 2) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                ConclaveText(conclaveString("chat_photo_viewer_failed"), line = "chat.photoViewer.failed",
                                    style = MaterialTheme.typography.bodyLarge)
                                FilledTonalButton(onClick = {
                                    phase = 0
                                    attempt += 1
                                    scope.launch { shareFile = ChatPhotoFiles.shareFile(context, row.photoURL) }
                                }) {
                                    ConclaveText(conclaveString("ds_try_again"), line = "chat.photoViewer.retry")
                                }
                            }
                        }
                    }
                    if (!immersive && !row.photoCaptionIsEmpty && row.plainText.isNotEmpty()) {

                        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 160.dp).background(scheme.surface)) {
                            item {
                                ConclaveText(row.plainText, line = "chat.photoViewer.caption", style = MaterialTheme.typography.bodyLarge,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}
