package conclave.module

import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/** UI-owned ephemeral cursor. The fixture supplies a recording sink, never a physical effect. */
internal class NativeFeedbackDelivery(
    private val presenter: NativeHostingPresenter,
    private val sink: (FeedbackKind) -> Unit,
) {
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

    fun attach() {
        checkMain()
        val state = presenter.feedbackState
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
        val state = presenter.feedbackState
        cursor.setEligibility(session = state.session, current = state.token, eligible = eligible())
        exposureEpoch = cursor.epoch
    }

    fun observe(): FeedbackDelivery? {
        checkMain()
        refresh()
        val state = presenter.feedbackState
        return cursor.observe(session = state.session, token = state.token,
            epoch = exposureEpoch, eligible = eligible())
    }

    fun deliver(delivery: FeedbackDelivery?) {
        checkMain()
        if (delivery == null) return
        refresh()
        val kind = cursor.take(delivery, session = presenter.feedbackState.session, eligible = eligible()) ?: return
        if (ConclaveHaptics.constant(kind) == null) return
        intendedCount++
        lastKind = kind.rawValue
        sink(kind)
    }

    fun gesture() {
        checkMain()
        refresh()
        deliver(cursor.gesture(kind = FeedbackKind.selectionChanged,
            session = presenter.feedbackState.session, eligible = eligible()))
    }
}

/** Exactly one consumer at the root, independent of panel composition. */
@Composable
internal fun NativeFeedbackConsumer(
    presenter: NativeHostingPresenter,
    delivery: NativeFeedbackDelivery,
    mount: Int,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state = presenter.feedbackState // Observe generated state during composition.
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
