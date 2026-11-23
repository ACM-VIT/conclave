package conclave.module

internal enum class StageVideoBacking {
    Surface,

    OverlaySurface,

    Texture,
}

internal object StageVideoBackingPolicy {
    fun backing(role: StageSlotRole, hasRail: Boolean, fadesWithChrome: Boolean): StageVideoBacking = when (role) {
        StageSlotRole.grid, StageSlotRole.gridWide, StageSlotRole.spotlightMain, StageSlotRole.programFeed ->
            StageVideoBacking.Surface
        StageSlotRole.rail -> if (fadesWithChrome) StageVideoBacking.Texture else StageVideoBacking.OverlaySurface
        StageSlotRole.selfFloating, StageSlotRole.speakerInset ->
            if (hasRail) StageVideoBacking.Texture else StageVideoBacking.OverlaySurface
        else -> StageVideoBacking.Texture
    }

    fun hasRail(slots: Iterable<StageSlot>): Boolean = slots.any { it.role == StageSlotRole.rail }
}
