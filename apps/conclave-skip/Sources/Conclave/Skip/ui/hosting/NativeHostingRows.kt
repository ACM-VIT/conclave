package conclave.module

// Only Kotlin scalars cross into the row composables. No Skip collection is
// declared stable, and the backing list never escapes this snapshot.
internal data class NativeHostingPerson(
    val id: String,
    val name: String,
    val detail: String,
    val isSelected: Boolean,
)

/**
 * Per-row reuse (PS 8.8, P1): a row whose Swift value is unchanged keeps the previous snapshot's exact
 * instance, found by ID, so only the mutated row's composables see a new value.
 */
internal class NativeHostingRows(source: NativeHostingRowsState, previous: NativeHostingRows? = null) {
    val revision: Int = source.revision
    val selectedCount: Int = source.selectedCount
    private val people: List<NativeHostingPerson> = buildList {
        val prior = previous?.people?.associateBy { it.id }
        for (row in source.rows) {
            val reused = prior?.get(row.id)
            if (reused != null && reused.name == row.name && reused.detail == row.detail && reused.isSelected == row.isSelected) {
                add(reused)
            } else {
                add(NativeHostingPerson(row.id, row.name, row.detail, row.isSelected))
            }
        }
    }
    val size: Int get() = people.size
    operator fun get(index: Int): NativeHostingPerson = people[index]
}

/** One cache per presenter lifetime. Scalar changes reuse the exact row snapshot; row changes reuse rows. */
internal class NativeHostingRowsCache(private val presenter: NativeHostingPresenter) {
    private var cached: NativeHostingRows? = null

    fun current(): NativeHostingRows {
        // Always read the observed property, even on a cache hit, to keep Compose subscribed.
        val state = presenter.rowsState
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return NativeHostingRows(state, previous).also { cached = it }
    }
}

/** Opt-in gallery seam; row snapshots above remain independent of icon state. */
@androidx.compose.runtime.Composable
internal fun NativeHostingIconSection(controller: NativeIconRasterController) {
    NativeIconGalleryControls(controller)
}
