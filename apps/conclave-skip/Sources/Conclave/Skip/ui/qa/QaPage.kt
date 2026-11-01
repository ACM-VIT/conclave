package conclave.module

import android.content.res.Configuration
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun QaPage(
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
    val qa = people.qa
    val snapshot = qa.snapshot
    val snackbar = remember { SnackbarHostState() }
    var answering by rememberSaveable { mutableStateOf("") }
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val tileVisible = inCallPageTileVisible(miniTile != null, variant, snapshot.isAttendee, hideMiniTileWithIme = true,
        imeVisible = WindowInsets.isImeVisible)
    val tileGutter = qaTileGutterDp(landscape, tileVisible, hasComposer = snapshot.isAttendee).dp
    InCallPage(
        title = conclaveString("qa_title"),
        variant = variant,
        appearance = appearance,
        hasComposer = snapshot.isAttendee,
        miniTile = miniTile,
        onClose = onClose,
        onMounted = {
            onMounted()
            people.platform = NoticePlatform.android
            qa.panelDidOpen(presentationID = request.presentationID)
        },
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        composer = { if (snapshot.isAttendee) QaComposer(people, snapshot) },
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbar) },
        hideMiniTileWithIme = true,
    ) { reservation ->
        QaContent(people, snapshot, request, reservation, tileGutter, onAnswerInWriting = { answering = it })
        PeopleFailureSnackbar(people, snackbar)
    }
    if (answering.isNotEmpty()) {
        QaAnswerDialog(people, answering, onClose = { answering = "" })
    }
}

@Composable
private fun QaContent(people: PeoplePresenter, snapshot: QaPanelSnapshot, request: PanelRequest, reservation: PaddingValues,
                      tileGutter: Dp, onAnswerInWriting: (String) -> Unit) {
    val qa = people.qa
    val layoutDirection = LocalLayoutDirection.current
    val listState = rememberLazyListState()
    val ids = remember(snapshot.revision) { snapshot.questionIds.toList() }
    LaunchedEffect(request.presentationID) {

        if (request.destination == PanelDestination.qaQuestion && request.targetId.isNotEmpty()) {
            val index = ids.indexOf(request.targetId)
            if (index >= 0) listState.scrollToItem(index)
        }
    }
    Column(Modifier.fillMaxSize()) {
        if (snapshot.availableSorts.count > 1 && snapshot.availability == QaAvailability.available) {
            val options = snapshot.availableSorts.toList().map { raw ->
                ConclaveSegmentModel(id = raw, title = conclaveString(qaSortName(raw)), isEnabled = true)
            }
            ConclaveSegmentedRow(
                options = options,
                selectedId = snapshot.sort.rawValue,
                identifier = "qa.sort",
                onSelect = { id -> qa.setSort(QaSort.init(rawValue = id) ?: QaSort.top) },
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
        if (snapshot.isHost && snapshot.availability == QaAvailability.available) {
            val haptics = rememberConclaveHaptics()
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp).testTag("qa.filter"),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (filter in listOf(QaHostFilter.openQuestions, QaHostFilter.answered, QaHostFilter.dismissed)) {
                    FilterChip(
                        selected = snapshot.filter == filter,
                        onClick = {
                            if (snapshot.filter != filter) {
                                haptics.gesture(FeedbackKind.selectionChanged)
                                qa.setFilter(filter)
                            }
                        },
                        label = { ConclaveText(conclaveString(qaFilterName(filter), snapshot.count(filter)), line = "qa.filter.${filter.rawValue}") },
                        modifier = Modifier.testTag("qa.filter.${filter.rawValue}"),
                    )
                }
            }
        }
        when {
            snapshot.availability == QaAvailability.needsRejoin -> ConclaveEmptyStatus(
                title = conclaveString("qa_unavailable_title"), body = conclaveString("qa_unavailable_body"),
                icon = ConclaveIcons.QuizFill0, identifier = "qa.unavailable", modifier = Modifier.padding(reservation))
            !snapshot.isLoaded -> ConclaveLoadingStatus(identifier = "qa.loading", label = conclaveString("qa_loading"))
            ids.isEmpty() -> {
                val body = qaEmptyName(snapshot)
                if (body != null) {
                    ConclaveEmptyStatus(title = conclaveString("qa_empty_title"), body = conclaveString(body), icon = ConclaveIcons.QuizFill0,
                        identifier = "qa.empty", modifier = Modifier.padding(reservation))
                }
            }
            else -> LazyColumn(
                state = listState,
                contentPadding = PaddingValues(
                    start = reservation.calculateStartPadding(layoutDirection),
                    top = reservation.calculateTopPadding(),
                    end = reservation.calculateEndPadding(layoutDirection) + tileGutter,
                    bottom = reservation.calculateBottomPadding(),
                ),
                modifier = Modifier.weight(1f).testTag("qa.list"),
            ) {
                if (snapshot.isAttendee) {
                    item(key = "privacy", contentType = "privacy") {
                        ConclaveSectionFooter(text = conclaveString("qa_privacy"), identifier = "qa.privacy")
                    }
                }
                items(ids, key = { it }, contentType = { "question" }) { id ->
                    QuestionRow(people, qa.questions.entry(id), snapshot.isHost, onAnswerInWriting)
                }
            }
        }
    }
}

internal fun qaTileGutterDp(landscape: Boolean, tileVisible: Boolean, hasComposer: Boolean): Int =
    if (landscape && tileVisible && !hasComposer) callMiniTileWidthDp(landscape) + 16 else 0

internal fun qaSortName(raw: String): String = when (raw) {
    QaSort.recent.rawValue -> "qa_recent"
    QaSort.mine.rawValue -> "qa_mine"
    else -> "qa_top"
}

internal fun qaFilterName(filter: QaHostFilter): String = when (filter) {
    QaHostFilter.answered -> "qa_filter_answered"
    QaHostFilter.dismissed -> "qa_filter_dismissed"
    else -> "qa_filter_open"
}

internal fun qaEmptyName(snapshot: QaPanelSnapshot): String? = when {
    snapshot.isHost && snapshot.filter == QaHostFilter.answered -> "qa_answered_empty"
    snapshot.isHost && snapshot.filter == QaHostFilter.dismissed -> "qa_dismissed_empty"
    snapshot.isHost -> "qa_empty_host"
    snapshot.isAttendee && snapshot.sort == QaSort.mine -> "qa_mine_empty"
    snapshot.isAttendee -> "qa_empty_attendee"
    else -> null
}

@Composable
private fun QaComposer(people: PeoplePresenter, snapshot: QaPanelSnapshot) {
    val qa = people.qa
    var text by rememberSaveable { mutableStateOf(qa.drafts.question) }
    var seenSerial by rememberSaveable { mutableIntStateOf(snapshot.submitSerial) }
    LaunchedEffect(snapshot.submitSerial) {
        if (snapshot.submitSerial == seenSerial) return@LaunchedEffect
        seenSerial = snapshot.submitSerial
        text = qa.drafts.question
    }
    if (snapshot.composerReason == QaComposerReason.qaOff) {
        ConclaveSectionFooter(text = conclaveString("qa_off"), identifier = "qa.composer.off")
        return
    }
    val sending = snapshot.submitPhase == QaSubmitPhase.sending
    val canSubmit = QaComposerPolicy.canSubmit(text, composerEnabled = snapshot.composerEnabled, isSending = sending)
    ConclaveComposerStack(
        identifier = "qa.composer",
        contentPadding = PaddingValues(0.dp),
        accessories = {
            if (QaComposerPolicy.isTooShort(text)) {
                ConclaveComposerStatusLine(text = conclaveString("qa_too_short"), identifier = "qa.composer.short")
            }
            val reason = when (snapshot.composerReason) {
                QaComposerReason.offline -> "ds_unavailable_offline"
                QaComposerReason.reconnecting -> "ds_unavailable_reconnecting"
                else -> null
            }
            if (reason != null) ConclaveComposerStatusLine(text = conclaveString(reason), identifier = "qa.composer.reason")
        },
        footer = {
            ConclaveCharacterCounter(text.length, QaLimits.questionMax, QaLimits.questionCounterFrom, "qa.composer.counter",
                announcesBands = true)
        },
    ) {
        ConclaveComposerField(
            placeholder = conclaveString("qa_ask_prompt"),
            value = text,
            onValueChange = {
                text = it
                qa.drafts.question = it
            },
            sendEnabled = canSubmit,
            onSend = { if (canSubmit) qa.submit(text) },
            identifier = "qa.composer.field",
            sendLabel = conclaveString("qa_ask"),
            enabled = !sending && snapshot.composerEnabled,
        )
    }
}

@Composable
private fun QaAnswerDialog(people: PeoplePresenter, questionId: String, onClose: () -> Unit) {
    val qa = people.qa
    val snapshot = qa.snapshot
    val entry = qa.questions.entry(questionId)
    var draft by rememberSaveable(questionId) { mutableStateOf(qa.drafts.answer(questionId)) }
    var seenAnswer by rememberSaveable(questionId) { mutableIntStateOf(snapshot.answerSerial) }
    LaunchedEffect(snapshot.answerSerial) {
        if (snapshot.answerSerial == seenAnswer) return@LaunchedEffect
        seenAnswer = snapshot.answerSerial
        if (snapshot.answeredQuestionId == questionId) onClose()
    }
    val pending = entry.model.pendingAction == QaHostAction.answerText
    val failure = people.lastFailure
    val error = if (failure != null && failure.sourceKey == QaFieldID.answer(questionId)) {
        conclaveString("qa_fail_moderate")
    } else null
    val model = ConclaveTextEntryDialogModel(
        kind = ConclaveTextEntryKind.multiline,
        title = conclaveString("qa_answer_title"),
        message = conclaveString("qa_answer_note"),
        fieldLabel = conclaveString("qa_answer_label"),
        confirmTitle = conclaveString("qa_post_answer"),
        limit = QaLimits.answerMax,
        counterFrom = QaLimits.answerCounterFrom,
    )
    ConclaveTextEntryDialog(
        model = model,
        value = draft,
        onValueChange = {
            draft = it
            qa.drafts.setAnswer(questionId, it)
        },
        identifier = "qa.answer",
        onConfirm = { qa.moderate(id = questionId, action = QaStatus.answered, reopen = false, answerText = draft) },
        onDismiss = onClose,
        error = error,
        pending = pending,
    )
}
