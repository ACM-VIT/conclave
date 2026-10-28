package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarHost
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

internal enum class PeopleItemKind {
    Notice, Invite, HostControls, Qa, Header, Person, Waiting, Loading, Footer, Empty,

    Attendee, Watching, AttendeesFooter,
}

internal data class PeopleListItem(
    val key: String,
    val kind: PeopleItemKind,
    val sectionId: String = "",
    val rowKey: String = "",
    val count: Int = 0,
)

internal fun peopleListItems(snapshot: PeopleSnapshot, sections: List<PeopleSection>, searching: Boolean): List<PeopleListItem> {
    val items = mutableListOf<PeopleListItem>()
    if (snapshot.showsLostHostNotice) items.add(PeopleListItem("notice", PeopleItemKind.Notice))
    if (!searching) {
        if (snapshot.inviteLink.isNotEmpty()) items.add(PeopleListItem("invite", PeopleItemKind.Invite))
        if (snapshot.isHostViewer) {
            items.add(PeopleListItem("hostControls", PeopleItemKind.HostControls))
            if (snapshot.qaVisible) items.add(PeopleListItem("qa", PeopleItemKind.Qa))
        }
    }
    for (section in sections) {
        items.add(PeopleListItem(peopleHeaderKey(section.id), PeopleItemKind.Header, sectionId = section.id, count = section.count))
        val isAttendees = section.id == PeopleSectionID.attendees.rawValue
        if (isAttendees && !searching) items.add(PeopleListItem("watching", PeopleItemKind.Watching, sectionId = section.id))
        for (rowKey in section.rowIds) {
            val kind = when {
                section.id == PeopleSectionID.waiting.rawValue -> PeopleItemKind.Waiting
                rowKey.startsWith(PeopleOrderPolicy.attendeePrefix) -> PeopleItemKind.Attendee
                else -> PeopleItemKind.Person
            }
            items.add(PeopleListItem("${section.id}:$rowKey", kind, sectionId = section.id, rowKey = rowKey))
        }
        if (isAttendees && !searching) items.add(PeopleListItem("f:${section.id}", PeopleItemKind.AttendeesFooter, sectionId = section.id))
        if (section.id == PeopleSectionID.panelists.rawValue && !searching) {
            val footer = PeopleRowPolicy.inMeetingFooter(snapshot)
            if (footer == PeopleFooterKind.recovering || footer == PeopleFooterKind.offline) {
                items.add(PeopleListItem("f:${section.id}", PeopleItemKind.Footer, sectionId = section.id, rowKey = footer.rawValue))
            }
        }
        if (section.id == PeopleSectionID.inMeeting.rawValue && !searching) {
            if (!snapshot.isRosterLoaded) items.add(PeopleListItem("loading", PeopleItemKind.Loading, sectionId = section.id))
            val footer = PeopleRowPolicy.inMeetingFooter(snapshot)
            if (footer != PeopleFooterKind.none) {
                items.add(PeopleListItem("f:${section.id}", PeopleItemKind.Footer, sectionId = section.id, rowKey = footer.rawValue))
            }
        }
    }
    if (searching && sections.isEmpty()) items.add(PeopleListItem("empty", PeopleItemKind.Empty))
    return items
}

internal fun peopleHeaderKey(sectionId: String): String = "h:$sectionId"

internal fun peoplePageTitleName(top: String?): String = when (top) {
    null, PeopleRoute.root.rawValue -> "native_panel_participants"
    PeopleRoute.hostControls.rawValue -> "ppl_host_controls"
    else -> hostPageTitleName(top)
}

@Composable
internal fun ParticipantsPage(
    people: PeoplePresenter,
    request: PanelRequest,
    variant: InCallPageVariant,
    appearance: PanelAppearance,
    miniTile: CallMiniTileModel?,
    onClose: () -> Unit,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
    miniTileVideo: (@Composable () -> Unit)? = null,
) {
    val pages = LocalPanelPageStack.current
    val top = pages?.top

    val snackbar = remember { SnackbarHostState() }
    InCallPage(
        title = conclaveString(peoplePageTitleName(top)),
        variant = variant,
        appearance = appearance,
        hasComposer = false,
        miniTile = miniTile,
        onClose = onClose,
        onMounted = {
            onMounted()

            people.panelDidOpen(destination = request.destination, presentationID = request.presentationID)

            people.platform = NoticePlatform.android
        },
        onDisposed = {

            people.panelDidClose(presentationID = request.presentationID)
            onDisposed()
        },
        miniTileVideo = miniTileVideo,
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbar) },
        hideMiniTileWithIme = true,
        isNested = pages?.isNested == true,
        onBack = { pages?.pop() },
    ) { reservation ->
        PeoplePageEffects(people, pages, variant, onHostPage = top != null)
        if (top == null) {
            PeopleRoot(people, reservation, onOpenHostControls = { pages?.push(PeopleRoute.hostControls.rawValue) })

            PeopleConfirmationHost(people)
            PeopleRenameDialog(people)
            PeopleFailureSnackbar(people, snackbar)
        } else {

            HostPageContent(people, top, reservation, snackbar, onPush = { pages?.push(it) }, onPop = { pages?.pop() })
        }
    }
}

@Composable
private fun PeoplePageEffects(people: PeoplePresenter, pages: PanelPageStack?, variant: InCallPageVariant, onHostPage: Boolean) {
    val isHost = people.snapshot.isHostViewer
    LaunchedEffect(isHost) {
        if (!isHost) pages?.popToRoot()
    }
    LaunchedEffect(variant, onHostPage) {
        val coverage = if (variant == InCallPageVariant.SidePane) PanelStageCoverage.none else PanelStageCoverage.full
        people.presentationDidChange(coverage = coverage, onHostPage = onHostPage)
    }
    val destination = people.shell.panels.destinationRequest
    LaunchedEffect(destination?.sequence) {
        if (destination != null) people.destinationRequested(destination)
    }
}

@Composable
private fun PeopleRoot(people: PeoplePresenter, reservation: PaddingValues, onOpenHostControls: () -> Unit) {
    val snapshot = people.snapshot
    var query by rememberSaveable { mutableStateOf(people.initialSearchQuery) }
    val searching = PeopleSearchPolicy.isSearching(query)

    val filtered = remember(snapshot.revision, query) { PeopleSearchPolicy.filter(snapshot.sections, query = query) }
    val entries = remember(snapshot.revision, query) { peopleListItems(snapshot, filtered.toList(), searching) }
    val queueCount = snapshot.section(PeopleSectionID.raisedHands)?.count ?: 0
    val listState = rememberLazyListState()
    val keyboard = LocalSoftwareKeyboardController.current
    val reduceMotion = rememberSystemAccessibility().removeAnimations
    LaunchedEffect(listState) {

        snapshotFlow { listState.isScrollInProgress }.collect { scrolling -> if (scrolling) keyboard?.hide() }
    }
    val focus = people.focusRequest
    LaunchedEffect(focus?.id) {
        val request = focus ?: return@LaunchedEffect
        val index = entries.indexOfFirst { it.key == peopleHeaderKey(request.sectionId) }
        if (index >= 0) {
            if (reduceMotion) listState.scrollToItem(index) else listState.animateScrollToItem(index)
        }

        people.focusRequestHandled(id = request.id)
    }
    Column(Modifier.fillMaxSize()) {
        ConclaveSearchField(
            query = query,
            onQueryChange = { query = it },
            identifier = "people.search",
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            placeholder = conclaveString("ppl_search"),
            resultCount = if (searching) PeopleSearchPolicy.resultCount(filtered) else null,
        )
        LazyColumn(state = listState, contentPadding = reservation, modifier = Modifier.fillMaxSize().testTag("people.list")) {
            items(entries, key = { it.key }, contentType = { it.kind }) { item ->
                when (item.kind) {
                    PeopleItemKind.Notice -> ConclaveBanner(kind = ConclaveBannerKind.Info, text = conclaveString("ppl_lost_host"),
                        identifier = "people.lostHost", inCall = false, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                    PeopleItemKind.Invite -> PeopleInviteRow(snapshot.inviteLink, snapshot.roomLabel)
                    PeopleItemKind.HostControls -> PeopleHostControlsRow(snapshot.accessSummary, onOpenHostControls)
                    PeopleItemKind.Qa -> PeopleQaRow(people)
                    PeopleItemKind.Header -> if (item.sectionId == PeopleSectionID.attendees.rawValue) {

                        WebinarAttendeesHeader(people)
                    } else {

                        PeopleSectionHeaderRow(people, item.sectionId, item.count, showsActions = !searching)
                    }

                    PeopleItemKind.Person -> PeopleActionRow(people, item.rowKey, item.sectionId,
                        if (item.sectionId == PeopleSectionID.raisedHands.rawValue) queueCount else 0)

                    PeopleItemKind.Waiting -> WaitingRow(people, item.rowKey)
                    PeopleItemKind.Loading -> ConclaveLoadingStatus(identifier = "people.loading", label = conclaveString("ppl_loading"))
                    PeopleItemKind.Footer -> ConclaveSectionFooter(text = conclaveString(peopleFooterName(item.rowKey)),
                        identifier = "people.section.${item.sectionId}.footer")
                    PeopleItemKind.Empty -> ConclaveEmptyStatus(title = conclaveString("ds_no_results"),
                        body = conclaveString("ppl_no_match", query), icon = ConclaveIcons.SearchFill0, identifier = "people.search.empty")
                    PeopleItemKind.Attendee -> WebinarAttendeeRow(people, item.rowKey, item.sectionId,
                        if (item.sectionId == PeopleSectionID.raisedHands.rawValue) queueCount else 0)
                    PeopleItemKind.Watching -> WebinarWatchingRow(people)
                    PeopleItemKind.AttendeesFooter -> WebinarAttendeesFooter(people, snapshot)
                }
            }
        }
    }
}

internal fun peopleSectionTitleName(sectionId: String): String = when (sectionId) {
    PeopleSectionID.waiting.rawValue -> "ppl_waiting"
    PeopleSectionID.raisedHands.rawValue -> "ppl_raised_hands"
    PeopleSectionID.panelists.rawValue -> "ppl_panelists"
    PeopleSectionID.attendees.rawValue -> "ppl_attendees"
    else -> "ppl_in_meeting"
}

internal fun peopleFooterName(kind: String): String = when (kind) {
    PeopleFooterKind.recovering.rawValue -> "ppl_recovering_footer"
    PeopleFooterKind.offline.rawValue -> "ppl_offline_footer"
    else -> "ppl_alone"
}

internal fun peopleAccessSummaryName(raw: String): String = when (raw) {
    PeopleAccessSummary.locked.rawValue -> "ppl_access_locked"
    PeopleAccessSummary.signedInOnly.rawValue -> "ppl_access_signed_in"
    else -> "ppl_access_open"
}

@Composable
private fun PeopleInviteRow(link: String, roomLabel: String) {
    val context = LocalContext.current
    ListItem(
        headlineContent = { ConclaveText(conclaveString("ds_share_invite"), line = "people.invite") },
        leadingContent = { Icon(ConclaveIcons.ShareFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.clickable(role = Role.Button) { stageShareMeetingLink(context, link, roomLabel) }.testTag("people.invite"),
    )
}

@Composable
private fun PeopleHostControlsRow(accessSummary: String, onOpen: () -> Unit) {
    ListItem(
        headlineContent = { ConclaveText(conclaveString("ppl_host_controls"), line = "people.hostControls") },
        supportingContent = { ConclaveText(conclaveString(peopleAccessSummaryName(accessSummary)), line = "people.hostControls.value") },
        leadingContent = { Icon(ConclaveIcons.ShieldPersonFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.clickable(role = Role.Button) { onOpen() }.testTag("people.hostControls"),
    )
}

@Composable
private fun PeopleQaRow(people: PeoplePresenter) {
    ListItem(
        headlineContent = { ConclaveText(conclaveString("ppl_qa"), line = "people.qa") },
        leadingContent = { Icon(ConclaveIcons.QuizFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
        trailingContent = { PeopleQaNewCount(people) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.clickable(role = Role.Button) { people.openQuestionsAndAnswers() }.testTag("people.qa"),
    )
}

@Composable
private fun PeopleQaNewCount(people: PeoplePresenter) {
    val unseen = people.qaUnseen
    if (unseen > 0) {
        ConclaveText(conclavePlural("ppl_qa_new", unseen, unseen), line = "people.qa.count",
            style = rememberTabular(MaterialTheme.typography.labelLarge), color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun PeopleActionRow(people: PeoplePresenter, rowKey: String, sectionId: String, queueCount: Int) {
    val entry = people.rows.entry(rowKey)
    val model = entry.model
    val context = LocalContext.current
    var expanded by remember(rowKey) { mutableStateOf(false) }
    val actions = remember(model) {
        peopleRowAccessibilityActions(context, model) { action ->
            people.perform(action, rowId = model.id, source = PeopleActionSource.a11y)
        }
    }
    val hasActions = !model.actions.isEmpty
    PersonRow(
        entry, people.speaking.state(rowKey), sectionId, queueCount, people.recompose,
        onOpenMenu = if (hasActions) { { expanded = true } } else null,
        actions = actions,
        menu = { if (hasActions) PeopleRowMenu(people, model, sectionId, expanded, onDismiss = { expanded = false }) },
    )
}
