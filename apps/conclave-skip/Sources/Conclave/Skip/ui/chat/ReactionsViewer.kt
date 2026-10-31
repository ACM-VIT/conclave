package conclave.module

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private class ChatReactorItem(val key: String, val userId: String, val name: String, val emoji: String, val isYou: Boolean)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ReactionsViewerSheet(presenter: ChatPresenter, actions: ChatRowActions, rowId: String) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    ModalBottomSheet(
        onDismissRequest = { actions.closeViewer() },
        sheetState = sheetState,
        modifier = Modifier.semantics { testTagsAsResourceId = true }.testTag("chat.reactions"),
    ) {
        NativeSemanticsPopupRoot("chat.reactions")
        ConclaveText(conclaveString("chat_reactions_title"), line = "chat.reactions.title",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() })
        Column(Modifier.fillMaxWidth().heightIn(min = 240.dp)) {
            ReactionsViewerContent(presenter, rowId)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ReactionsViewerContent(presenter: ChatPresenter, rowId: String) {
    val row = presenter.rows.entry(rowId).row
    val chips = row.reactions.toList()
    val you = conclaveString("chat_you")
    val byEmoji = remember(rowId, row.reactions) {
        chips.map { chip ->
            val reactors = presenter.reactors(rowId, chip.emoji).toList()
            reactors.mapIndexed { index, person ->
                ChatReactorItem(chip.emoji + ":" + person.userId, person.userId, person.name, chip.emoji, chip.isMine && index == 0)
            }
        }
    }
    var selected by remember(rowId) { mutableIntStateOf(0) }
    val total = byEmoji.sumOf { it.size }
    Column(Modifier.fillMaxSize().testTag("chat.reactions.content")) {
        PrimaryScrollableTabRow(selectedTabIndex = selected) {
            Tab(selected = selected == 0, onClick = { selected = 0 }, modifier = Modifier.testTag("chat.reactions.tab.all"),
                text = { ConclaveText(conclaveString("chat_reactions_all", total), line = "chat.reactions.tab.all.label") })
            chips.forEachIndexed { index, chip ->
                Tab(selected = selected == index + 1, onClick = { selected = index + 1 },
                    modifier = Modifier.testTag("chat.reactions.tab.${chip.emoji}"),
                    text = {
                        val face = chip.emoji + " " + chip.count
                        ConclaveText(face, line = "chat.reactions.tab.${chip.emoji}.label")
                    })
            }
        }
        val people = if (selected == 0) byEmoji.flatten() else byEmoji.getOrElse(selected - 1) { emptyList() }
        LazyColumn(Modifier.fillMaxSize()) {
            items(people, key = { it.key }) { person ->
                ListItem(
                    headlineContent = {
                        ConclaveText(if (person.isYou) you else person.name, line = "chat.reactions.${person.key}",
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    leadingContent = { ConclaveAvatar(person.name, person.userId, ConclaveAvatarSize.row) },
                    trailingContent = if (selected == 0) {
                        @Composable { ConclaveText(person.emoji, line = "chat.reactions.${person.key}.emoji") }
                    } else null,
                )
            }
        }
    }
}
