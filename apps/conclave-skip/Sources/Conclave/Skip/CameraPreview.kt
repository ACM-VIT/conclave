package conclave.module

import android.Manifest
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

/// A live front-camera preview for the pre-join screen, mirrored to match the
/// iOS AVCaptureSession path. Sets up CameraX (ProcessCameraProvider + a Preview
/// use case bound to the front camera) and hosts a PreviewView via AndroidView.
///
/// Requests CAMERA at runtime (the permission is declared in the manifest for
/// calls); until granted the surface stays blank, never a crash. The use case is
/// unbound when the Composable leaves the tree (camera toggled off / view gone).
@Composable
internal fun CameraPreviewView() {
    val context = LocalContext.current
    val lifecycleOwner = context as? LifecycleOwner

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
    }

    LaunchedEffect(hasPermission) {
        if (!hasPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
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
        DisposableEffect(previewView) {
            val providerFuture = ProcessCameraProvider.getInstance(context)
            var boundProvider: ProcessCameraProvider? = null

            val listener = Runnable {
                val cameraProvider = providerFuture.get()
                boundProvider = cameraProvider

                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }

                val selector = CameraSelector.DEFAULT_FRONT_CAMERA

                try {
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(lifecycleOwner, selector, preview)
                } catch (t: Throwable) {
                    logger.error("CameraPreviewView bind failed: ${t}")
                }
            }
            providerFuture.addListener(listener, ContextCompat.getMainExecutor(context))

            onDispose {
                boundProvider?.unbindAll()
            }
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { previewView }
    )
}
