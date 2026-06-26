package conclave.module

import skip.lib.*
import skip.model.*
import skip.foundation.*
import skip.ui.*

import android.app.Application
import android.content.Intent
import android.graphics.Color as AndroidColor
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.setContent
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.ComponentActivity
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.material3.MaterialTheme

internal val logger: SkipLogger = SkipLogger(subsystem = "conclave.module", category = "Conclave")

private typealias AppRootView = ConclaveRootView
private typealias AppDelegate = ConclaveAppDelegate
private const val FULL_ROOT_SAVEABLE_KEY = "conclave-full-root"

open class AndroidAppMain: Application {
    constructor() {
    }

    override fun onCreate() {
        super.onCreate()
        ProcessInfo.launch(applicationContext)
        AppDelegate.shared.onInit()
        // Prebuild the meeting icon vectors on a background thread now, so the
        // first sheet/controls render reuses the cached vectors instead of
        // building ~12 of them on the main thread mid-open (the sheet-content lag).
        warmMeetingIcons()
    }

    companion object {
    }
}

open class MainActivity: AppCompatActivity {
    constructor() {
    }

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        UIApplication.launch(this)
        // Register the MediaProjection consent launcher (must happen at onCreate
        // before the Activity reaches STARTED) so screen-share can request it.
        ScreenCaptureManager.register(this)
        enableEdgeToEdge()

        setContent {
            val saveableStateHolder = rememberSaveableStateHolder()
            if (PipController.inPipMode && PipController.isInCall) {
                PipContent()
            } else {
                saveableStateHolder.SaveableStateProvider(FULL_ROOT_SAVEABLE_KEY) {
                    PresentationRootView(ComposeContext())
                }
            }
        }

        AppDelegate.shared.onLaunch()
        handleIncomingDeepLink(intent)
    }

    override fun onResume() {
        super.onResume()
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            PipManager.handleActivityResumed(this)
        }
        AppDelegate.shared.onResume()
    }

    override fun onPause() {
        super.onPause()
        AppDelegate.shared.onPause()
    }

    override fun onStop() {
        super.onStop()
        AppDelegate.shared.onStop()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (
            PipController.isInCall &&
            !PipController.inPipMode &&
            !ScreenCaptureManager.isRequestingCapture() &&
            android.os.Build.VERSION.SDK_INT >= 26
        ) {
            PipController.refreshPipContent()
            CallActionDispatcher.pictureInPictureContentRefresh()
            Handler(Looper.getMainLooper()).post {
                if (
                    PipController.isInCall &&
                    !PipController.inPipMode &&
                    !ScreenCaptureManager.isRequestingCapture() &&
                    !isFinishing &&
                    !isDestroyed &&
                    !isInPictureInPictureMode
                ) {
                    PipManager.enterPip(this, PipController.muted)
                } else if (!isInPictureInPictureMode) {
                    PipController.inPipMode = false
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingDeepLink(intent)
    }

    private fun handleIncomingDeepLink(intent: Intent?) {
        val urlString = intent?.dataString?.trim() ?: return
        if (urlString.isEmpty()) return
        AppDelegate.shared.onOpenURL(urlString)
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        PipController.inPipMode = isInPictureInPictureMode
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            PipManager.handlePictureInPictureModeChanged(
                this,
                isInPictureInPictureMode,
                PipController.muted
            )
        }
        if (isInPictureInPictureMode) {
            CallActionDispatcher.pictureInPictureEntered()
        }
    }

    override fun onDestroy() {
        if (isFinishing) {
            NativeGoogleSignInBridge.cancel()
        }
        super.onDestroy()
        AppDelegate.shared.onDestroy()
    }

    override fun onLowMemory() {
        super.onLowMemory()
        AppDelegate.shared.onLowMemory()
    }

    override fun onSaveInstanceState(outState: android.os.Bundle): Unit = super.onSaveInstanceState(outState)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: kotlin.Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        PermissionHelper.handleRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (NativeGoogleSignInBridge.handleActivityResult(requestCode, resultCode, data)) {
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    companion object {
    }
}

@Composable
internal fun SyncSystemBarsWithTheme() {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f

    val transparent = AndroidColor.TRANSPARENT
    val style = if (dark) {
        SystemBarStyle.dark(transparent)
    } else {
        SystemBarStyle.light(transparent, transparent)
    }

    val activity = LocalActivity.current as? ComponentActivity
    DisposableEffect(style) {
        activity?.enableEdgeToEdge(
            statusBarStyle = style,
            navigationBarStyle = style
        )
        onDispose { }
    }
}

@Composable
internal fun PresentationRootView(context: ComposeContext) {
    val colorScheme = if (isSystemInDarkTheme()) ColorScheme.dark else ColorScheme.light
    PresentationRoot(defaultColorScheme = colorScheme, context = context) { ctx ->
        SyncSystemBarsWithTheme()
        val contentContext = ctx.content()
        Box(modifier = ctx.modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            AppRootView().Compose(context = contentContext)
        }
    }
}
