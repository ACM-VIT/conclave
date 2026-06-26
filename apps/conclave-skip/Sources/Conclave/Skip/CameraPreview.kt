package conclave.module

import android.Manifest
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner

object CameraPreviewController {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var activeProvider: ProcessCameraProvider? = null
    private var activePreview: Preview? = null
    private var releaseGeneration = 0L

    fun releasePreview() {
        val action = Runnable {
            releaseGeneration += 1
            val provider = activeProvider
            val preview = activePreview
            activeProvider = null
            activePreview = null
            if (provider != null && preview != null) {
                try {
                    provider.unbind(preview)
                } catch (error: Throwable) {
                    debugLog("[CameraPreview] Failed to unbind preview: ${error}")
                }
            }
        }

        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run()
        } else {
            mainHandler.post(action)
        }
    }

    internal fun markBound(provider: ProcessCameraProvider, preview: Preview) {
        activeProvider = provider
        activePreview = preview
    }

    internal fun bindingGeneration(): Long = releaseGeneration

    internal fun canBindPreview(generation: Long): Boolean =
        generation == releaseGeneration

    internal fun releaseIfCurrent(provider: ProcessCameraProvider?, preview: Preview?) {
        if (activeProvider === provider && activePreview === preview) {
            releasePreview()
            return
        }
        if (provider != null && preview != null) {
            try {
                provider.unbind(preview)
            } catch (error: Throwable) {
                debugLog("[CameraPreview] Failed to unbind stale preview: ${error}")
            }
        }
    }
}

private data class PreviewCameraSelection(
    val selector: CameraSelector,
    val mirrored: Boolean,
    val facing: String
)

private fun selectPreviewCamera(cameraProvider: ProcessCameraProvider, facing: String): PreviewCameraSelection? {
    val wantsBackCamera = facing.trim().lowercase() == "back"
    val preferred = if (wantsBackCamera) {
        PreviewCameraSelection(CameraSelector.DEFAULT_BACK_CAMERA, mirrored = false, facing = "back")
    } else {
        PreviewCameraSelection(CameraSelector.DEFAULT_FRONT_CAMERA, mirrored = true, facing = "front")
    }
    val fallback = if (wantsBackCamera) {
        PreviewCameraSelection(CameraSelector.DEFAULT_FRONT_CAMERA, mirrored = true, facing = "front")
    } else {
        PreviewCameraSelection(CameraSelector.DEFAULT_BACK_CAMERA, mirrored = false, facing = "back")
    }
    val candidates = listOf(
        preferred,
        fallback
    )
    return candidates.firstOrNull { candidate ->
        try {
            cameraProvider.hasCamera(candidate.selector)
        } catch (_: Throwable) {
            false
        }
    }
}

@Composable
internal fun CameraPreviewView(
    facing: String,
    onPermissionChanged: (Boolean) -> Unit,
    onFacingResolved: (String) -> Unit = {}
) {
    val context = LocalContext.current
    val lifecycleOwner = remember(context) { context.findLifecycleOwner() }

    var hasPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
        )
    }
    var previewFailed by remember { mutableStateOf(false) }

    LaunchedEffect(facing) {
        previewFailed = false
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasPermission = granted
        previewFailed = false
        onPermissionChanged(granted)
    }

    LaunchedEffect(hasPermission, previewFailed) {
        if (!hasPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        } else if (!previewFailed) {
            onPermissionChanged(true)
        }
    }

    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    if (hasPermission && !previewFailed && lifecycleOwner != null) {
        DisposableEffect(previewView, lifecycleOwner, facing) {
            val providerFuture = ProcessCameraProvider.getInstance(context)
            var boundProvider: ProcessCameraProvider? = null
            var boundPreview: Preview? = null
            var disposed = false
            val bindingGeneration = CameraPreviewController.bindingGeneration()

            val listener = Runnable {
                try {
                    val cameraProvider = providerFuture.get()
                    if (disposed || !CameraPreviewController.canBindPreview(bindingGeneration)) {
                        return@Runnable
                    }

                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }

                    val cameraSelection = selectPreviewCamera(cameraProvider, facing)
                    if (cameraSelection == null) {
                        debugLog("[CameraPreview] No camera available for requested facing: ${facing}")
                        previewFailed = true
                        onPermissionChanged(false)
                        return@Runnable
                    }

                    boundPreview?.let { cameraProvider.unbind(it) }
                    if (disposed || !CameraPreviewController.canBindPreview(bindingGeneration)) {
                        return@Runnable
                    }
                    previewView.scaleX = if (cameraSelection.mirrored) -1f else 1f
                    boundProvider = cameraProvider
                    boundPreview = preview
                    cameraProvider.bindToLifecycle(lifecycleOwner, cameraSelection.selector, preview)
                    CameraPreviewController.markBound(cameraProvider, preview)
                    onFacingResolved(cameraSelection.facing)
                } catch (t: Throwable) {
                    if (disposed) {
                        return@Runnable
                    }
                    debugLog("[CameraPreview] Bind failed: ${t}")
                    CameraPreviewController.releaseIfCurrent(boundProvider, boundPreview)
                    previewFailed = true
                    onPermissionChanged(false)
                }
            }
            providerFuture.addListener(listener, ContextCompat.getMainExecutor(context))

            onDispose {
                disposed = true
                CameraPreviewController.releaseIfCurrent(boundProvider, boundPreview)
            }
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { previewView }
    )
}

private tailrec fun Context.findLifecycleOwner(): LifecycleOwner? {
    return when (this) {
        is LifecycleOwner -> this
        is ContextWrapper -> baseContext.findLifecycleOwner()
        else -> null
    }
}
