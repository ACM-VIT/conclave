package conclave.module

import android.content.Context
import android.content.pm.ApplicationInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.PowerManager
import android.view.View
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import java.util.WeakHashMap
import skip.foundation.ProcessInfo

object ProximityController {

    const val WAKE_LOCK_TAG = "conclave:proximity"

    private var wanted = false
    private var hostResumed = false
    private var lifecycleObserved = false
    private var levelSupported: Boolean? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var sensorListener: SensorEventListener? = null

    private val hostObserver = LifecycleEventObserver { _, event ->
        when (event) {
            Lifecycle.Event.ON_RESUME -> {
                hostResumed = true
                applyWanted()
            }
            Lifecycle.Event.ON_PAUSE -> {
                hostResumed = false
                applyWanted()
            }
            else -> Unit
        }
    }

    val isHeld: Boolean
        get() = wakeLock?.isHeld == true

    fun setArmed(armed: Boolean) {
        observeHostLifecycle()
        wanted = armed
        applyWanted()
    }

    fun releaseNow() {
        wanted = false
        release(waitForNoProximity = false)
        report()
    }

    private fun observeHostLifecycle() {
        if (lifecycleObserved) return
        lifecycleObserved = true
        val lifecycle = ProcessLifecycleOwner.get().lifecycle
        hostResumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

        lifecycle.addObserver(hostObserver)
    }

    private fun applyWanted() {
        if (wanted && hostResumed) {
            acquire()
        } else {
            release(waitForNoProximity = true)
        }
        report()
    }

    private fun acquire() {
        if (wakeLock?.isHeld == true) return
        val power = context().getSystemService(PowerManager::class.java) ?: return
        val supported = levelSupported ?: power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK).also {
            levelSupported = it
        }
        if (!supported) return
        val lock = wakeLock ?: power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, WAKE_LOCK_TAG).also {
            it.setReferenceCounted(false)
            wakeLock = it
        }
        try {

            lock.acquire()
        } catch (t: Throwable) {
            debugLog("[Proximity] Failed to acquire the proximity wake lock: ${t}")
            return
        }
        startDebugSensor()
    }

    private fun release(waitForNoProximity: Boolean) {
        stopDebugSensor()
        val lock = wakeLock ?: return
        if (!lock.isHeld) return
        val flags = if (waitForNoProximity) PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY else 0
        try {
            lock.release(flags)
        } catch (t: Throwable) {
            debugLog("[Proximity] Failed to release the proximity wake lock: ${t}")
        }
    }

    private fun report() {
        CallScreenAwakeState.shared.reportProximityMonitoring(active = isHeld)
    }

    private fun startDebugSensor() {
        if (sensorListener != null) return
        val ctx = context()
        if ((ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) return
        val manager = ctx.getSystemService(SensorManager::class.java) ?: return
        val sensor = manager.getDefaultSensor(Sensor.TYPE_PROXIMITY) ?: return
        val maximumRange = sensor.maximumRange
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent?) {
                val distance = event?.values?.firstOrNull() ?: return
                CallScreenAwakeState.shared.reportProximityNear(distance < maximumRange)
            }

            override fun onAccuracyChanged(changed: Sensor?, accuracy: Int) = Unit
        }

        if (manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL)) {
            sensorListener = listener
        }
    }

    private fun stopDebugSensor() {
        val listener = sensorListener ?: return
        sensorListener = null
        context().getSystemService(SensorManager::class.java)?.unregisterListener(listener)
    }

    private fun context(): Context = ProcessInfo.processInfo.androidContext
}

internal object KeepScreenOnHolds {
    private val counts = WeakHashMap<View, Int>()

    fun acquire(view: View) {
        val next = (counts[view] ?: 0) + 1
        counts[view] = next
        if (next == 1) view.keepScreenOn = true
    }

    fun release(view: View) {
        val next = (counts[view] ?: 0) - 1
        if (next <= 0) {
            counts.remove(view)
            view.keepScreenOn = false
        } else {
            counts[view] = next
        }
    }

    fun holdCount(view: View): Int = counts[view] ?: 0
}

@Composable
fun KeepScreenOnEffect(on: Boolean) {
    val view = LocalView.current
    DisposableEffect(view, on) {
        if (on) KeepScreenOnHolds.acquire(view)
        onDispose {
            if (on) KeepScreenOnHolds.release(view)
        }
    }
}

@Composable
fun CallKeepScreenOnEffect() {
    KeepScreenOnEffect(CallScreenAwakeState.shared.keepsScreenAwake)
}

@Composable
fun ScreenAwakeFixtureReadouts(modifier: Modifier = Modifier) {
    val state = CallScreenAwakeState.shared
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(state.awakeReadout, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.testTag(CallScreenAwakeReadout.awakeKey))
        Text(state.proximityReadout, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.testTag(CallScreenAwakeReadout.proximityKey))
    }
}
