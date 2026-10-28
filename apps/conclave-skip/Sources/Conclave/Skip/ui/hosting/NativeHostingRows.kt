package conclave.module

internal data class NativeHostingPerson(
    val id: String,
    val name: String,
    val detail: String,
    val isSelected: Boolean,
)

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

internal class NativeHostingRowsCache(private val presenter: NativeHostingPresenter) {
    private var cached: NativeHostingRows? = null

    fun current(): NativeHostingRows {

        val state = presenter.rowsState
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return NativeHostingRows(state, previous).also { cached = it }
    }
}

@androidx.compose.runtime.Composable
internal fun NativeHostingIconSection(controller: NativeIconRasterController) {
    NativeIconGalleryControls(controller)
}
