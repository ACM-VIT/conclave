package conclave.module

import android.Manifest
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
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

@Composable
internal fun CameraPreviewView(onPermissionChanged: (Boolean) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = remember(context) { context.findLifecycleOwner() }

    var hasPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasPermission = granted
        onPermissionChanged(granted)
    }

    LaunchedEffect(hasPermission) {
        if (!hasPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        } else {
            onPermissionChanged(true)
        }
    }

    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            // Mirror the front camera so the preview reads like a mirror,
            // matching the iOS scaleEffect(x: -1) path.
            scaleX = -1f
        }
    }

    if (hasPermission && lifecycleOwner != null) {
        DisposableEffect(previewView, lifecycleOwner) {
            val providerFuture = ProcessCameraProvider.getInstance(context)
            var boundProvider: ProcessCameraProvider? = null
            var boundPreview: Preview? = null
            var disposed = false

            val listener = Runnable {
                try {
                    val cameraProvider = providerFuture.get()
                    if (disposed) {
                        return@Runnable
                    }

                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }

                    val selector = CameraSelector.DEFAULT_FRONT_CAMERA

                    boundPreview?.let { cameraProvider.unbind(it) }
                    cameraProvider.bindToLifecycle(lifecycleOwner, selector, preview)
                    boundProvider = cameraProvider
                    boundPreview = preview
                } catch (t: Throwable) {
                    if (disposed) {
                        return@Runnable
                    }
                    logger.error("CameraPreviewView bind failed: ${t}")
                    hasPermission = false
                    onPermissionChanged(false)
                }
            }
            providerFuture.addListener(listener, ContextCompat.getMainExecutor(context))

            onDispose {
                disposed = true
                boundPreview?.let { preview ->
                    boundProvider?.unbind(preview)
                }
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
