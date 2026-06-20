package conclave.module

import skip.lib.*
import skip.model.*
import skip.foundation.*
import skip.ui.*

import android.app.Application
import android.content.Intent
import android.graphics.Color as AndroidColor
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.ComponentActivity
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.MaterialTheme

internal val logger: SkipLogger = SkipLogger(subsystem = "conclave.module", category = "Conclave")

private typealias AppRootView = ConclaveRootView
private typealias AppDelegate = ConclaveAppDelegate

/// AndroidAppMain is the `android.app.Application` entry point, and must match `application android:name` in AndroidManifest.xml.
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

/// MainActivity is the initial `androidx.appcompat.app.AppCompatActivity`, and must match `activity android:name` in AndroidManifest.xml.
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
            // While in Picture-in-Picture, render ONLY the minimal active-speaker
            // layout (no controls/chrome — Mute/Leave live in the system PiP
            // action bar). Restore the full meeting UI when leaving PiP. Reading
            // PipController.inPipMode (a Compose mutableState) recomposes on the
            // PiP-mode transition.
            if (PipController.inPipMode && PipController.isInCall) {
                PipContent()
            } else {
                val saveableStateHolder = rememberSaveableStateHolder()
                saveableStateHolder.SaveableStateProvider(true) {
                    PresentationRootView(ComposeContext())
                    SideEffect { saveableStateHolder.removeState(true) }
                }
            }
        }

        AppDelegate.shared.onLaunch()
        handleIncomingDeepLink(intent)
    }

    override fun onResume() {
        super.onResume()
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

    /// Fired when the user is leaving the activity (Home / Recents). If a call is
    /// active, enter Picture-in-Picture showing the active speaker's video so the
    /// call stays visible. The foreground service already keeps audio alive.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (
            PipController.isInCall &&
            !ScreenCaptureManager.isRequestingCapture() &&
            android.os.Build.VERSION.SDK_INT >= 26
        ) {
            PipManager.enterPip(this, PipController.muted)
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
        // Swap the Compose content to / from the minimal PiP layout.
        PipController.inPipMode = isInPictureInPictureMode
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

    val activity = LocalContext.current as? ComponentActivity
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
