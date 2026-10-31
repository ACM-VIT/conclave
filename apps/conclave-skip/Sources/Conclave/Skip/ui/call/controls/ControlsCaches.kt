package conclave.module

internal data class CallControlUi(
    val id: String,
    val kind: CallControlKind,
    val isOn: Boolean,
    val visual: CallControlVisual,
    val isBlocked: Boolean,
    val isPending: Boolean,
    val reason: ControlBlockedReason,
    val reasonName: String,
    val appliesAfterReconnect: Boolean,
    val badgeCount: Int,
    val showsDot: Boolean,
    val hasShortcut: Boolean,
    val gesture: FeedbackKind?,
) {
    fun matches(model: CallControlModel): Boolean =
        id == model.id && kind == model.kind && isOn == model.isOn && visual == model.visual && isBlocked == model.isBlocked &&
            isPending == model.isPending && reason == model.reason && reasonName == model.reasonName &&
            appliesAfterReconnect == model.appliesAfterReconnect && badgeCount == model.badgeCount &&
            showsDot == model.showsDot && hasShortcut == model.hasShortcut

    val isLeaving: Boolean get() = reason == ControlBlockedReason.leaving

    companion object {
        fun from(model: CallControlModel): CallControlUi = CallControlUi(
            id = model.id,
            kind = model.kind,
            isOn = model.isOn,
            visual = model.visual,
            isBlocked = model.isBlocked,
            isPending = model.isPending,
            reason = model.reason,
            reasonName = model.reasonName,
            appliesAfterReconnect = model.appliesAfterReconnect,
            badgeCount = model.badgeCount,
            showsDot = model.showsDot,
            hasShortcut = model.hasShortcut,
            gesture = ControlBarPolicy.gestureKind(model),
        )
    }
}

internal class ControlBarUi(source: ControlBarSnapshot, previous: ControlBarUi? = null) {
    val snapshot: ControlBarSnapshot = source
    val revision: Int = source.revision
    val composition: ControlBarComposition = source.composition
    val axis: ControlBarAxis = source.axis
    val controls: List<CallControlUi> = buildList {
        val prior = previous?.controls?.associateBy { it.id }
        for (model in source.controls) {
            val reused = prior?.get(model.id)
            if (reused != null && reused.matches(model)) add(reused) else add(CallControlUi.from(model))
        }
    }

    fun control(kind: CallControlKind): CallControlUi? = controls.firstOrNull { it.kind == kind }
}

internal class ControlBarCache(private val presenter: CallControlsPresenter) {
    private var cached: ControlBarUi? = null

    fun current(): ControlBarUi {

        val state = presenter.bar
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return ControlBarUi(state, previous).also { cached = it }
    }
}

internal data class LeaveUi(
    val revision: Int,
    val canEndForEveryone: Boolean,
    val leavePhase: LeavePhase,
    val endPhase: EndPhase,
    val confirmationId: Int,
    val confirmationInvoker: String,
    val offersRecap: Boolean,
    val endFailure: String,
    val showsEndForEveryone: Boolean,
    val endBlockedReason: ControlBlockedReason,
    val snapshot: LeaveSnapshot,
) {
    val isLeaving: Boolean get() = leavePhase == LeavePhase.leaving

    companion object {
        fun from(snapshot: LeaveSnapshot): LeaveUi = LeaveUi(
            revision = snapshot.revision,
            canEndForEveryone = snapshot.canEndForEveryone,
            leavePhase = snapshot.leavePhase,
            endPhase = snapshot.endPhase,
            confirmationId = snapshot.confirmationId,
            confirmationInvoker = snapshot.confirmationInvoker,
            offersRecap = snapshot.offersRecap,
            endFailure = snapshot.endFailure,
            showsEndForEveryone = snapshot.showsEndForEveryone,
            endBlockedReason = snapshot.endBlockedReason,
            snapshot = snapshot,
        )
    }
}

internal class LeaveCache(private val presenter: CallControlsPresenter) {
    private var cached: LeaveUi? = null

    fun current(): LeaveUi {
        val state = presenter.leaveState
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return LeaveUi.from(state).also { cached = it }
    }
}

internal class MoreUi(source: MoreSnapshot) {
    val snapshot: MoreSnapshot = source
    val revision: Int = source.revision
    val isRecovering: Boolean = source.isRecovering
    val meetingLink: String = source.meetingLink
    val roomLabel: String = source.roomLabel
    val layoutMode: String = source.layoutMode
    val hasHostSection: Boolean = source.hasHostSection
    val tiles: List<MoreItem> = buildList { for (item in MoreMenuPolicy.tiles(source)) add(item) }
    val hostItems: List<MoreItem> = buildList { for (item in MoreMenuPolicy.hostItems(source)) add(item) }

    fun item(id: MoreItemID): MoreItem? = snapshot.item(id)

    fun opensPanel(id: MoreItemID): Boolean = MoreMenuPolicy.opensPanel(id)
}

internal class MoreCache(private val presenter: CallControlsPresenter) {
    private var cached: MoreUi? = null

    fun current(): MoreUi {

        val state = presenter.more
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return MoreUi(state).also { cached = it }
    }
}

internal class ReactionsUi(source: ReactionPaletteSnapshot) {
    val revision: Int = source.revision
    val availability: ReactionAvailability = source.availability
    val isAvailable: Boolean = source.isAvailable
    val emoji: List<ReactionOptionModel> = buildList { for (option in source.emoji) add(option) }
    val art: List<ReactionOptionModel> = buildList { for (option in source.art) add(option) }
}

internal class ReactionsCache(private val presenter: CallControlsPresenter) {
    private var cached: ReactionsUi? = null

    fun current(): ReactionsUi {
        val state = presenter.reactions
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return ReactionsUi(state).also { cached = it }
    }
}

internal class AudioRouteUi(source: AudioRouteSnapshot) {
    val snapshot: AudioRouteSnapshot = source
    val revision: Int = source.revision
    val currentId: String = source.currentId
    val pendingId: String = source.pendingId
    val phase: RouteSwitchPhase = source.phase
    val bluetoothAccess: BluetoothRouteAccess = source.bluetoothAccess
    val rows: List<AudioRouteRowModel> = buildList { for (row in RoutePickerPolicy.rows(source)) add(row) }
}

internal class AudioRouteCache(private val presenter: CallControlsPresenter) {
    private var cached: AudioRouteUi? = null

    fun current(): AudioRouteUi {

        val state = presenter.route
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return AudioRouteUi(state).also { cached = it }
    }
}

internal class MediaShortcutsUi(source: MediaShortcutSnapshot) {
    val snapshot: MediaShortcutSnapshot = source
    val revision: Int = source.revision
    val camera: List<MediaShortcutItem> = buildList { for (item in source.camera) add(item) }
    val hasEnabledCameraItem: Boolean = MediaShortcutPolicy.hasEnabledItem(source.camera)

    val accessibilityItems: List<MediaShortcutItem> = buildList { for (item in MediaShortcutPolicy.accessibilityItems(source.camera)) add(item) }
}

internal class MediaShortcutsCache(private val presenter: CallControlsPresenter) {
    private var cached: MediaShortcutsUi? = null

    fun current(): MediaShortcutsUi {

        val state = presenter.shortcuts
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return MediaShortcutsUi(state).also { cached = it }
    }
}
