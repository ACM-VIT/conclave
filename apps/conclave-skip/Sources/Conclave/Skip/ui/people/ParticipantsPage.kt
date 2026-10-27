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

/*
 * S50 1 d (PPL-1): the Android Participants page. One InCallPage in lazyList mode (R50-1: the list takes the page's
 * reservation, so its last row clears the mini tile and the navigation bar; the mini tile hides while the search IME
 * shows), the host's PanelPageStack for the pushed pages (R50-2: PeopleRoute raw values; Back pops a page first, then
 * closes, with predictive progress, PNL-1), the pinned C20 search field (never the M3 SearchBar family, AND 7.7) and a
 * LazyColumn keyed by stable item keys with a content type per kind. The list rebuilds only on a new snapshot revision
 * or query (the PeopleCache rule, S50 1 k); every person item reads its own PersonRowEntry. Mounted by the native call
 * root (HD request B4-T7 R3); the side pane shows the same page (PS 8.3).
 */

/** What one LazyColumn item draws. */
internal enum class PeopleItemKind { Notice, Invite, HostControls, Qa, Header, Person, Waiting, Loading, Footer, Empty }

/** One LazyColumn item: a stable key, its kind, and the section and row it belongs to. */
internal data class PeopleListItem(
    val key: String,
    val kind: PeopleItemKind,
    val sectionId: String = "",
    val rowKey: String = "",
    val count: Int = 0,
)

/**
 * The page's items in S50 1 b order: the lost-host notice, then (not while searching) Share invite, Host controls and
 * Questions and answers, then each section's header and rows, the loading row and the In this meeting footer, and the
 * C14 no-match state. Pure, so the Robolectric test checks the order and the header index a destination scrolls to.
 */
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
        val kind = if (section.id == PeopleSectionID.waiting.rawValue) PeopleItemKind.Waiting else PeopleItemKind.Person
        for (rowKey in section.rowIds) {
            items.add(PeopleListItem("${section.id}:$rowKey", kind, sectionId = section.id, rowKey = rowKey))
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

/**
 * The page title for the page on top of the stack: Participants at the root, Host controls for the pushed Host
 * Controls page, and the access or notice page title above it (PPL-4, S50 7 g, 8 g).
 */
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
    // PL14 `panelSnackbar`: one snackbar slot per page (R40-3); the root and each host page report there.
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
            // The presentation lifecycle (S50 1 d): the page mounts once per presentation; an overlay to side pane move
            // keeps it composed, so the destination scrolls once.
            people.panelDidOpen(destination = request.destination, presentationID = request.presentationID)
            // PL14: panel-origin failures use the page snackbar on Android.
            people.platform = NoticePlatform.android
        },
        onDisposed = {
            // The coordinator callback closes it first in production; this keeps a host without that hook correct.
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
            // S50 3 j: the People root leaf for row, accessibility and section-header confirmations; the PL10 rename
            // dialog; and the page snackbar for panel failures (PL14).
            PeopleConfirmationHost(people)
            PeopleRenameDialog(people)
            PeopleFailureSnackbar(people, snackbar)
        } else {
            // PPL-4 (S50 6 to 8): Host controls and its pages on the same stack (R50-2); the host pages compose their
            // own confirmation leaf and snackbar reporter.
            HostPageContent(people, top, reservation, snackbar, onPush = { pages?.push(it) })
        }
    }
}

/**
 * Effects with their own reads, so the page never recomposes for them: coverage for PL14 (overlay full, side pane
 * none), the lost-host pop (S50 12) and same-panel destinations (S20 SR7).
 */
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
    // searchKeys only (PL8): rebuilt on a new revision or query, never per frame.
    val filtered = remember(snapshot.revision, query) { PeopleSearchPolicy.filter(snapshot.sections, query = query) }
    val entries = remember(snapshot.revision, query) { peopleListItems(snapshot, filtered.toList(), searching) }
    val queueCount = snapshot.section(PeopleSectionID.raisedHands)?.count ?: 0
    val listState = rememberLazyListState()
    val keyboard = LocalSoftwareKeyboardController.current
    val reduceMotion = rememberSystemAccessibility().removeAnimations
    LaunchedEffect(listState) {
        // The keyboard closes when the list scrolls (S50 1 d); read in a flow, so scrolling never recomposes the page.
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling -> if (scrolling) keyboard?.hide() }
    }
    val focus = people.focusRequest
    LaunchedEffect(focus?.id) {
        val request = focus ?: return@LaunchedEffect
        val index = entries.indexOfFirst { it.key == peopleHeaderKey(request.sectionId) }
        if (index >= 0) {
            if (reduceMotion) listState.scrollToItem(index) else listState.animateScrollToItem(index)
        }
        // Cleared after the scroll, so the root re-entering composition after a pop finds null (S50 1 d).
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
                    PeopleItemKind.Header -> ConclaveSectionHeader(title = conclaveString(peopleSectionTitleName(item.sectionId)),
                        identifier = "people.section.${item.sectionId}.header", count = item.count)
                    // Only Raised Hands rows read the queue size, so a hand change never recomposes the others.
                    PeopleItemKind.Person -> PeopleActionRow(people, item.rowKey, item.sectionId,
                        if (item.sectionId == PeopleSectionID.raisedHands.rawValue) queueCount else 0)
                    PeopleItemKind.Waiting -> PeopleWaitingNameRow(people.waiting.entry(item.rowKey), people.recompose)
                    PeopleItemKind.Loading -> ConclaveLoadingStatus(identifier = "people.loading", label = conclaveString("ppl_loading"))
                    PeopleItemKind.Footer -> ConclaveSectionFooter(text = conclaveString(peopleFooterName(item.rowKey)),
                        identifier = "people.section.${item.sectionId}.footer")
                    PeopleItemKind.Empty -> ConclaveEmptyStatus(title = conclaveString("ds_no_results"),
                        body = conclaveString("ppl_no_match", query), icon = ConclaveIcons.SearchFill0, identifier = "people.search.empty")
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

/** Share invite (RECONCILE R14): the one share payload the stage uses, through the system share sheet. */
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

/** Host controls with the meeting access value as its supporting text (S50 1 f); pushes the host page. */
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

/** Questions and answers (S50 1 c): replaces the panel; the count is its own leaf on `qaUnseen`. */
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

/**
 * One person with the PPL-2 actions (S50 3 d): tap or long press opens the row DropdownMenu (built when it opens,
 * F00 C16 k), the same items are TalkBack custom actions on the merged node (AX4), and a row without actions stays a
 * plain node. Reads only its own entry.
 */
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
