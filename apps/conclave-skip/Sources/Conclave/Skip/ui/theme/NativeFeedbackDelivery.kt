package conclave.module

import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * UI-owned ephemeral cursor over one outcome stream. The Debug fixture supplies a recording sink; the production root
 * (WP2-S2b, [ConclaveRootFeedback]) supplies the view's single-argument haptic, admits the source's documented kinds,
 * and records each effect for sys.feedbackRecords.
 */
internal class NativeFeedbackDelivery(
    private val source: () -> FeedbackSourceState,
    private val sink: (FeedbackKind) -> Unit,
    private val deliversKind: (FeedbackKind) -> Boolean = { true },
    private val records: FeedbackDeliveryRecords? = null,
) {
    /** The Debug hosting fixture: every kind, recording sink. */
    constructor(presenter: NativeHostingPresenter, sink: (FeedbackKind) -> Unit) : this(
        source = { FeedbackSourceState(session = presenter.feedbackState.session, token = presenter.feedbackState.token) },
        sink = sink,
    )

    private val cursor = FeedbackDeliveryCursor()
    private var active = false
    var suspended by mutableStateOf(false)
        private set
    var exposureEpoch by mutableIntStateOf(0)
        private set
    var intendedCount by mutableIntStateOf(0)
        private set
    var lastKind by mutableStateOf("none")
        private set

    private fun checkMain() = check(Looper.myLooper() == Looper.getMainLooper())
    private fun eligible() = active && !suspended

    /** The consumed stream's current state; read during composition so Compose observes it. */
    fun sourceState(): FeedbackSourceState = source()

    fun attach() {
        checkMain()
        val state = source()
        cursor.attach(session = state.session, current = state.token, eligible = eligible())
        exposureEpoch = cursor.epoch
    }

    fun setActive(value: Boolean) {
        checkMain()
        active = value
        refresh()
    }

    fun updateSuspended(value: Boolean) {
        checkMain()
        suspended = value
        refresh()
    }

    private fun refresh() {
        val state = source()
        cursor.setEligibility(session = state.session, current = state.token, eligible = eligible())
        exposureEpoch = cursor.epoch
    }

    fun observe(): FeedbackDelivery? {
        checkMain()
        refresh()
        val state = source()
        return cursor.observe(session = state.session, token = state.token,
            epoch = exposureEpoch, eligible = eligible())
    }

    fun deliver(delivery: FeedbackDelivery?) {
        checkMain()
        if (delivery == null) return
        refresh()
        val kind = cursor.take(delivery, session = source().session, eligible = eligible()) ?: return
        // Source-scoped admission keeps shell, native premeeting and native call ownership separate.
        if (!deliversKind(kind)) return
        if (ConclaveHaptics.constant(kind) == null) return
        intendedCount++
        lastKind = kind.rawValue
        records?.record(kind)
        sink(kind)
    }

    fun gesture() {
        checkMain()
        refresh()
        deliver(cursor.gesture(kind = FeedbackKind.selectionChanged,
            session = source().session, eligible = eligible()))
    }
}

/** Exactly one consumer per stream at the root, independent of panel composition. */
@Composable
internal fun NativeFeedbackConsumer(delivery: NativeFeedbackDelivery, mount: Int) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state = delivery.sourceState() // Observe generated state during composition.
    val epoch = delivery.exposureEpoch
    DisposableEffect(delivery, lifecycle, mount) {
        delivery.setActive(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        delivery.attach()
        val observer = LifecycleEventObserver { _, _ ->
            // Synchronous: pause/event/resume cannot hide behind Compose coalescing.
            delivery.setActive(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            delivery.setActive(false)
        }
    }
    LaunchedEffect(delivery, state.session, state.token.sequence, epoch, mount) {
        delivery.deliver(delivery.observe())
    }
}

/** The Debug hosting fixture's consumer (AppRoot.kt). */
@Composable
internal fun NativeFeedbackConsumer(
    presenter: NativeHostingPresenter,
    delivery: NativeFeedbackDelivery,
    mount: Int,
) {
    presenter.feedbackState // The fixture presenter's observed state.
    NativeFeedbackConsumer(delivery, mount)
}

/**
 * WP2-S2b: the single root consumer of production outcome tokens (S70 12 d; F1 rules). It delivers the shell's
 * feedbackState through the activity view's single-argument performHapticFeedback (the system touch-feedback setting
 * governs; no in-app preference, Q11), only for DeliveredTokenKinds and only while the activity is RESUMED. Main.kt
 * composes it once at the top of setContent, outside the PiP and route switch (HD request B2-T1): a PiP swap never
 * remounts it, a rotation recreates it with a baselined cursor, and tokens published while paused (PiP, background)
 * are consumed without an effect and never replayed. Public because the app module composes it.
 */
@Composable
fun ConclaveRootFeedback() {
    val shell = MeetingViewModel.shared.shell
    val view = LocalView.current
    val delivery = remember(shell, view) {
        NativeFeedbackDelivery(
            source = { FeedbackSourceState(session = shell.feedbackState.session, token = shell.feedbackState.token) },
            sink = { ConclaveHaptics.perform(view, it) },
            deliversKind = { DeliveredTokenKinds.delivers(it) },
            records = FeedbackDeliveryRecords.shared,
        )
    }
    // SYS-4 (PS 9.4): PiP (and the API 35 transition into it) suspends delivery; resuming rebaselines, nothing replays.
    val pipSuspended = PipController.feedbackSuspended
    LaunchedEffect(delivery, pipSuspended) { delivery.updateSuspended(pipSuspended) }
    NativeFeedbackConsumer(delivery, mount = 0)
    if (NativeCallFeedbackSource.isEnabled(routes = NativeRouteFlags.shared)) {
        val owner = MeetingViewModel.shared
        val sources = remember(owner) {
            NativeCallFeedbackSource.production(shell = owner.shell, stage = owner.stage, controls = owner.controls,
                people = owner.people, activitySession = owner.activitySession)
        }
        for (source in sources) {
            key(source.publisher) { NativeCallFeedbackObserver(source) }
        }
    }
}

/** The production admission/source seam, also used with a recording sink by the bridge tests. */
internal fun nativeCallFeedbackDelivery(
    source: NativeCallFeedbackSource,
    sink: (FeedbackKind) -> Unit,
    records: FeedbackDeliveryRecords,
) = NativeFeedbackDelivery(
    source = { source.state },
    sink = sink,
    deliversKind = { source.publisher.delivers(it) },
    records = records,
)

@Composable
private fun NativeCallFeedbackObserver(source: NativeCallFeedbackSource) {
    val view = LocalView.current
    val delivery = remember(source, view) {
        nativeCallFeedbackDelivery(source, sink = { ConclaveHaptics.perform(view, it) }, records = FeedbackDeliveryRecords.shared)
    }
    val pipSuspended = PipController.feedbackSuspended
    LaunchedEffect(delivery, pipSuspended) { delivery.updateSuspended(pipSuspended) }
    NativeFeedbackConsumer(delivery, mount = 0)
}
