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

/**
 * S70 4 d (SYS-5, SX5): the Android proximity controller. The shared edge writer (CallScreenAwakeState in
 * S/Core/Call/CallScreenAwake.swift) calls [setArmed] once per edge of CallPresenceSnapshot.proximityArmed
 * (ProximityPolicy: receiver route, camera off, not presenting, not in PiP, app active). While armed and with an
 * activity resumed it holds PROXIMITY_SCREEN_OFF_WAKE_LOCK ("conclave:proximity"), only where the level is supported
 * (a tablet without a sensor never holds it), and releases it with RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY so the screen
 * does not flash on at the ear. It reports whether it holds the lock back to the shared writer (the `sys.proximity`
 * readout); near and far come from a sensor listener registered only in debuggable builds and only while the lock
 * is held, and never reach the presence snapshot. Event driven, no polling (4 k). Main thread only.
 *
 * Under Core-Telecom (SY5 spike, not merged) the route rule would read the call endpoint type instead.
 */
object ProximityController {
    /** The wake lock tag `dumpsys power` lists (S70 4 l2). */
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

    /** Whether the proximity wake lock is held now (Robolectric and the fixture readout). */
    val isHeld: Boolean
        get() = wakeLock?.isHeld == true

    /** Called by the shared writer on each edge of the arming rule. */
    fun setArmed(armed: Boolean) {
        observeHostLifecycle()
        wanted = armed
        applyWanted()
    }

    /**
     * The task was removed (CallForegroundService.onTaskRemoved): release at once, without waiting for the sensor,
     * and stay released until the next arming edge.
     */
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
        // Adding the observer replays the events up to the current state (ON_RESUME when an activity is resumed).
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
            // Untimed on purpose: held only while the arming rule holds, released on every edge and on task removal.
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

    /** Near and far for the Debug readout only (debuggable builds, while the lock is held). */
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
        // Without a Handler the events arrive on the main looper, like every other call here.
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

/**
 * Reference-counted View.keepScreenOn holds, so two native roots composed at once (the premeeting host and the call
 * root inside it, or a cross-fade) never clear each other. Main thread only.
 */
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

/**
 * S70 4 d: the Compose-scoped equivalent of FLAG_KEEP_SCREEN_ON. View.keepScreenOn on the content view makes the
 * window carry the flag while any hold is on; the legacy route's SkipUI window flag is independent of it.
 */
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

/**
 * The native roots' keep awake (S70 4 d): follows CallPresenceSnapshot.keepsScreenAwake through the shared edge
 * writer, so it recomposes only on the rule's edges (waiting, connecting, live, recovering and on hold keep the
 * screen on). Request lines in K/ui/home/PremeetingHost.kt, K/ui/call/stage/CallRoot.kt and the system fixture root.
 */
@Composable
fun CallKeepScreenOnEffect() {
    KeepScreenOnEffect(CallScreenAwakeState.shared.keepsScreenAwake)
}

/** The S70 SX1 readouts `sys.awake` and `sys.proximity` for the Debug system fixture, as test tags with ASCII values. */
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
