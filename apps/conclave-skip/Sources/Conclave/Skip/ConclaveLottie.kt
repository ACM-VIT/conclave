package conclave.module

import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.dotlottie.dlplayer.Mode
import com.lottiefiles.dotlottie.core.compose.runtime.DotLottieController
import com.lottiefiles.dotlottie.core.compose.ui.DotLottieAnimation
import com.lottiefiles.dotlottie.core.util.DotLottieEventListener
import com.lottiefiles.dotlottie.core.util.DotLottieSource
import kotlin.coroutines.cancellation.CancellationException

@Composable
internal fun ConclaveLottieComposable() {
    val controller = remember { DotLottieController() }
    val mainHandler = remember { Handler(Looper.getMainLooper()) }
    val playerState by controller.currentState.collectAsState()
    var renderPlayer by remember { mutableStateOf(true) }

    fun disablePlayer(reason: String) {
        NativePerformanceDiagnostics.lottie("disable_player reason=$reason")
        if (Looper.myLooper() == Looper.getMainLooper()) {
            renderPlayer = false
        } else {
            mainHandler.post { renderPlayer = false }
        }
    }

    fun isCompositionCancellation(throwable: Throwable): Boolean {
        return throwable is CancellationException ||
            throwable.javaClass.name == "androidx.compose.runtime.LeftCompositionCancellationException"
    }

    DisposableEffect(controller) {
        val listener = object : DotLottieEventListener {
            private var loggedFirstFrame = false
            private var loggedFirstRender = false

            override fun onLoad() {
                NativePerformanceDiagnostics.lottie(
                    "loaded asset=conclave-animation.lottie frames=${controller.totalFrames} " +
                        "duration=${controller.duration} animation=${controller.activeAnimationId}"
                )
            }

            override fun onPlay() {
                NativePerformanceDiagnostics.lottie(
                    "play speed=${controller.speed} loop=${controller.loop} loaded=${controller.isLoaded}"
                )
            }

            override fun onFrame(frame: Float) {
                if (!loggedFirstFrame) {
                    loggedFirstFrame = true
                    NativePerformanceDiagnostics.lottie("first_frame frame=$frame")
                }
            }

            override fun onRender(frame: Float) {
                if (!loggedFirstRender) {
                    loggedFirstRender = true
                    NativePerformanceDiagnostics.lottie("first_render frame=$frame")
                }
            }

            override fun onLoadError() {
                NativePerformanceDiagnostics.lottieError("load_error asset=conclave-animation.lottie")
                disablePlayer("load_error")
            }

            override fun onLoadError(throwable: Throwable) {
                if (isCompositionCancellation(throwable)) {
                    NativePerformanceDiagnostics.lottie(
                        "load_cancelled asset=conclave-animation.lottie reason=composition_disposed"
                    )
                    return
                }
                NativePerformanceDiagnostics.lottieError(
                    "load_error asset=conclave-animation.lottie message=${throwable.message ?: "unknown"}",
                    throwable
                )
                disablePlayer("load_error")
            }

            override fun onError(throwable: Throwable) {
                if (isCompositionCancellation(throwable)) {
                    NativePerformanceDiagnostics.lottie("runtime_cancelled reason=composition_disposed")
                    return
                }
                NativePerformanceDiagnostics.lottieError(
                    "runtime_error message=${throwable.message ?: "unknown"}",
                    throwable
                )
                disablePlayer("runtime_error")
            }

            override fun onLoop(loopCount: Int) = Unit
            override fun onStop() = Unit
            override fun onPause() = Unit
            override fun onComplete() = Unit
            override fun onFreeze() = Unit
            override fun onUnFreeze() = Unit
            override fun onDestroy() = Unit
        }
        controller.addEventListener(listener)
        onDispose {
            controller.removeEventListener(listener)
        }
    }

    LaunchedEffect(Unit) {
        NativePerformanceDiagnostics.lottie("dotlottie-android entry animation active")
    }

    LaunchedEffect(playerState) {
        NativePerformanceDiagnostics.lottie("dotlottie-android state=$playerState")
    }

    if (renderPlayer) {
        DotLottieAnimation(
            source = DotLottieSource.Asset("conclave-animation.lottie"),
            autoplay = true,
            loop = true,
            speed = 3f,
            useFrameInterpolation = false,
            playMode = Mode.FORWARD,
            controller = controller,
            threads = 2u,
            modifier = Modifier.fillMaxSize()
        )
    }
}
