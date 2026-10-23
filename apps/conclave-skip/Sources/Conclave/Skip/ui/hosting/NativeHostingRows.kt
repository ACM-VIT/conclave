package conclave.module

// Only Kotlin scalars cross into the row composables. No Skip collection is
// declared stable, and the backing list never escapes this snapshot.
internal data class NativeHostingPerson(
    val id: String,
    val name: String,
    val detail: String,
    val isSelected: Boolean,
)

internal class NativeHostingRows(source: NativeHostingRowsState) {
    val revision: Int = source.revision
    val selectedCount: Int = source.selectedCount
    private val people: List<NativeHostingPerson> = buildList {
        for (row in source.rows) {
            add(NativeHostingPerson(row.id, row.name, row.detail, row.isSelected))
        }
    }
    val size: Int get() = people.size
    operator fun get(index: Int): NativeHostingPerson = people[index]
}

/** One cache per presenter lifetime. Scalar changes reuse the exact row snapshot. */
internal class NativeHostingRowsCache(private val presenter: NativeHostingPresenter) {
    private var cached: NativeHostingRows? = null

    fun current(): NativeHostingRows {
        // Always read the observed property, even on a cache hit, to keep Compose subscribed.
        val state = presenter.rowsState
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return NativeHostingRows(state).also { cached = it }
    }
}
