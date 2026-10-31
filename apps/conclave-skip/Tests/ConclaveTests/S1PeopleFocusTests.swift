#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1PeopleFocusTests {
    private func makePeople() -> PeoplePresenter {
        let shell = MeetingShellPresenter()
        return PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
    }

    private func shows(_ people: PeoplePresenter, _ section: PeopleSectionID) -> Bool {
        people.snapshot.section(section) != nil
    }

    private func step(_ people: PeoplePresenter, _ request: PeopleFocusRequest, searching: Bool = false) -> PeopleFocusStep {
        let section = PeopleSectionID(rawValue: request.sectionId) ?? PeopleSectionID.inMeeting
        return people.focusStep(id: request.id, isShown: shows(people, section), isSearching: searching,
                                revision: people.snapshot.revision)
    }

    private func destination(_ people: PeoplePresenter, sequence: Int, presentationID: Int,
                             _ destination: PanelDestination) -> PanelDestinationRequest {
        PanelDestinationRequest(sequence: sequence, session: people.shell.panels.snapshot.session, presentationID: presentationID,
                                panel: .participants, invoker: .call, destination: destination, targetId: "")
    }

    @Test func theRequestIsConsumedOnlyByThePlacementCallback() throws {
        let people = makePeople()
        people.apply(PeopleFixtureScript.inputs(for: .hostWaiting3))
        people.panelDidOpen(destination: .peopleWaiting, presentationID: 7)
        let request = try #require(people.focusRequest)
        #expect(request.sectionId == PeopleSectionID.waiting.rawValue)
        #expect(people.focusRevision == people.snapshot.revision)
        #expect(step(people, request) == .placeHeader)
        #expect(step(people, request) == .placeHeader, "asking again while the header scrolls into place keeps the request")
        #expect(people.focusRequest == request && people.focusReadout() == "destination=peopleWaiting scrolls=0")
        people.focusRequestHandled(id: request.id)
        #expect(people.focusRequest == nil && people.focusReadout() == "destination=peopleWaiting scrolls=1")
        #expect(step(people, request) == .idle)
    }

    @Test func theLatestRequestWinsOnRepeatAndReplacement() throws {
        let people = makePeople()
        people.apply(PeopleFixtureScript.inputs(for: .hostWaiting3))
        #expect(shows(people, .waiting) && shows(people, .raisedHands))
        people.panelDidOpen(destination: .peopleWaiting, presentationID: 7)
        let first = try #require(people.focusRequest)

        people.destinationRequested(destination(people, sequence: 1, presentationID: 7, .peopleWaiting))
        let repeated = try #require(people.focusRequest)
        #expect(repeated.id > first.id && repeated.sectionId == first.sectionId)
        #expect(step(people, first) == .idle, "a superseded request never scrolls")
        people.focusRequestHandled(id: first.id)
        #expect(people.focusRequest == repeated)

        people.destinationRequested(destination(people, sequence: 2, presentationID: 7, .peopleRaisedHands))
        let replaced = try #require(people.focusRequest)
        #expect(replaced.sectionId == PeopleSectionID.raisedHands.rawValue && replaced.id > repeated.id)
        #expect(step(people, repeated) == .idle && step(people, replaced) == .placeHeader)
        people.focusRequestHandled(id: repeated.id)
        #expect(people.focusRequest == replaced)
        people.focusRequestHandled(id: replaced.id)
        #expect(people.focusRequest == nil)
        #expect(people.focusReadout() == "destination=peopleWaiting,peopleWaiting,peopleRaisedHands scrolls=1")
    }

    @Test func anAbsentSectionIsConsumedOnceTheSnapshotMovesOn() throws {
        let people = makePeople()
        people.apply(PeopleFixtureScript.inputs(for: .host6))
        #expect(!shows(people, .waiting))
        people.panelDidOpen(destination: .peopleWaiting, presentationID: 5)
        let request = try #require(people.focusRequest)
        #expect(step(people, request) == .awaitSection)
        #expect(people.focusRequest == request, "the request waits for one more snapshot revision")

        let revision = people.snapshot.revision
        people.apply(PeopleFixtureScript.peopleInputs(roster: PeopleFixtureScript.handsLowered(PeopleFixtureScript.hostSix()),
                                                      state: .host6))
        #expect(people.snapshot.revision == revision + 1 && !shows(people, .waiting))
        #expect(step(people, request) == .consumeNow)
        people.focusRequestHandled(id: request.id)
        #expect(people.focusRequest == nil && people.focusReadout() == "destination=peopleWaiting scrolls=1")

        people.destinationRequested(destination(people, sequence: 1, presentationID: 5, .peopleWaiting))
        let searched = try #require(people.focusRequest)
        #expect(people.focusStep(id: searched.id, isShown: false, isSearching: true, revision: people.snapshot.revision) == .consumeNow,
                "a search that hides the section consumes at once")
        #expect(people.focusStep(id: searched.id, isShown: false, isSearching: false, revision: people.snapshot.revision - 1)
                == .awaitSection, "a list drawn from an older revision keeps waiting")
    }

    @Test func aLateSectionWaitsForTheNextRevisionThenPlaces() throws {
        let people = makePeople()
        people.apply(PeopleFixtureScript.inputs(for: .host6))
        people.panelDidOpen(destination: .peopleWaiting, presentationID: 9)
        let request = try #require(people.focusRequest)
        let before = people.snapshot.revision
        #expect(people.focusRevision == before)
        #expect(step(people, request) == .awaitSection)

        people.apply(PeopleFixtureScript.inputs(for: .hostWaiting3))
        #expect(people.snapshot.revision == before + 1 && shows(people, .waiting))
        #expect(step(people, request) == .placeHeader)
        #expect(people.focusRequest == request, "placing the header does not consume the request")
        people.focusRequestHandled(id: request.id)
        #expect(people.focusRequest == nil && people.focusReadout() == "destination=peopleWaiting scrolls=1")
    }

    @Test func closingThePanelDropsAWaitingRequest() throws {
        let people = makePeople()
        people.apply(PeopleFixtureScript.inputs(for: .host6))
        people.panelDidOpen(destination: .peopleRaisedHands, presentationID: 3)
        let request = try #require(people.focusRequest)
        #expect(step(people, request) == .placeHeader)
        people.panelDidClose(presentationID: 3)
        #expect(people.focusRequest == nil && step(people, request) == .idle)
    }

    @Test func headerPlacementGeometryDecidesTheLargeDetent() {
        #expect(PeopleFocusPolicy.isHeaderPlaced(headerTop: 120, headerBottom: 164, viewportTop: 120, viewportBottom: 480))
        #expect(PeopleFocusPolicy.isHeaderPlaced(headerTop: 119.5, headerBottom: 164, viewportTop: 120, viewportBottom: 480),
                "sub-point rounding still counts as placed")
        #expect(!PeopleFocusPolicy.isHeaderPlaced(headerTop: 80, headerBottom: 124, viewportTop: 120, viewportBottom: 480),
                "a header under the panel title is not placed")
        #expect(!PeopleFocusPolicy.isHeaderPlaced(headerTop: 460, headerBottom: 504, viewportTop: 120, viewportBottom: 480),
                "a header below the medium detent is not placed")
        #expect(!PeopleFocusPolicy.isHeaderPlaced(headerTop: 120, headerBottom: 520, viewportTop: 120, viewportBottom: 480),
                "a stacked AX5 header taller than the medium viewport is not placed")
        #expect(!PeopleFocusPolicy.isHeaderPlaced(headerTop: 0, headerBottom: 0, viewportTop: 120, viewportBottom: 480))
        #expect(!PeopleFocusPolicy.isHeaderPlaced(headerTop: 120, headerBottom: 164, viewportTop: 0, viewportBottom: 0))
        #expect(PeopleFocusPolicy.promotesToLarge(isPlaced: false, isMediumDetent: true))
        #expect(!PeopleFocusPolicy.promotesToLarge(isPlaced: true, isMediumDetent: true))
        #expect(!PeopleFocusPolicy.promotesToLarge(isPlaced: false, isMediumDetent: false))
        #expect(PeopleFocusPolicy.step(isShown: true, isSearching: true, revision: 1, requestRevision: 4) == .placeHeader)
        #expect(PeopleFocusPolicy.step(isShown: false, isSearching: false, revision: 4, requestRevision: 4) == .awaitSection)
        #expect(PeopleFocusPolicy.step(isShown: false, isSearching: false, revision: 5, requestRevision: 4) == .consumeNow)
        #expect(PeopleFocusPolicy.step(isShown: false, isSearching: true, revision: 4, requestRevision: 4) == .consumeNow)
    }

    @Test func openingPeopleNormallyNeverForcesLarge() throws {
        #expect(PanelPresentationPolicy.initialSheetDetent(.participants) == .medium)
        #expect(PanelPresentationPolicy.initialSheetDetent(.participants, isAccessibilitySize: true) == .medium)
        #expect(PanelPresentationPolicy.sheetDetents(.participants) == [.medium, .large])
        let panel = try s1pfSource("Sources/Conclave/Features/Meeting/People/ParticipantsPanel+iOS.swift")
        let open = try s1pfSlice(panel, from: ".task(id: presentation.request.presentationID) {", to: ".onChange(of: route.count)")
        #expect(!open.contains("promoteToLarge"), "opening People keeps the medium detent")
        let flat = s1pfFlat(panel)
        #expect(flat.components(separatedBy: "promoteToLarge()").count - 1 == 4,
                "the shell action, a pushed host page, search and a hidden focus header are the only promotions")
        #expect(flat.contains("onPromoteToLarge: { adapter.promoteToLarge() }"))
        #expect(flat.contains("if count > 0 { adapter.promoteToLarge() }"))
        #expect(flat.contains("if on { promoteToLarge() }"))
        let focus = try s1pfSlice(flat, from: "if isLive && PeopleFocusPolicy.promotesToLarge(", to: "people.focusRequestHandled(id: request.id) }")
        #expect(focus.contains("isMediumDetent: isMediumDetent) { promoteToLarge()"))
    }

    @Test func iosScrollsToADedicatedHeaderTargetAndConsumesAfterPlacement() throws {
        let panel = try s1pfSource("Sources/Conclave/Features/Meeting/People/ParticipantsPanel+iOS.swift")
        let flat = s1pfFlat(panel)
        #expect(flat.contains(".modifier(PeopleFocusHeaderTarget(sectionId: section.id, placement: placement))"))
        #expect(flat.contains(".id(PeopleFocusTarget.header(sectionId))"))
        #expect(flat.contains("\"people.header.\" + sectionId"))
        #expect(!panel.contains(".id(section.id)"), "the whole Section is no longer the scroll target")
        #expect(flat.contains("isMediumDetent: resolved.style == PanelHostStyle.sheet && adapter.detent == PanelDetent.medium"))
        #expect(flat.contains(".task(id: PeopleFocusKey(id: focusId, isMediumDetent: focusId != 0 && isMediumDetent))"))
        #expect(flat.contains("people.focusStep(id: request.id, isShown: isShown, isSearching: searching, revision: snapshot.revision)"))
        #expect(flat.contains("if step == PeopleFocusStep.consumeNow || step == PeopleFocusStep.awaitSection { "
                              + "people.focusRequestHandled(id: request.id) return }"))
        let task = try s1pfSlice(flat, from: "guard step == PeopleFocusStep.placeHeader else { return }", to: ".accessibilityRotor(")
        let scroll = try #require(task.range(of: "proxy.scrollTo(target, anchor: .top)"))
        let settle = try #require(task.range(of: "try? await Task.sleep(", range: scroll.upperBound..<task.endIndex))
        let live = try #require(task.range(of: "isLive = PeopleSearchPolicy.filter(people.snapshot.sections, query: query)",
                                           range: settle.upperBound..<task.endIndex))
        let placed = try #require(task.range(of: "placement.isHeaderPlaced(request.sectionId)", range: live.upperBound..<task.endIndex))
        _ = try #require(task.range(of: "people.focusRequestHandled(id: request.id)", range: placed.upperBound..<task.endIndex))
        #expect(task.components(separatedBy: "people.focusRequestHandled(").count - 1 == 1)
        #expect(task.contains("while isLive && !isPlaced && attempts < PeopleFocusTiming.scrollAttempts {"),
                "a header that is not placed yet gets one more scroll before the detent changes")
        #expect(task.contains("if isLive && PeopleFocusPolicy.promotesToLarge(isPlaced: isPlaced, isMediumDetent: isMediumDetent) {"))
        #expect(flat.contains("static let scrollAttempts = 2"))
        #expect(flat.contains("geometry.frame(in: .global)") && flat.contains("geometry.safeAreaInsets"))
        #expect(flat.contains(".onDisappear { placement.forget(sectionId) }"))
    }

    @Test func aLeadTooTallToPlaceTheHeaderFallsBackToTheFirstRowAtTheBottom() throws {
        let people = makePeople()
        people.apply(PeopleFixtureScript.inputs(for: .hostWaiting3))
        let sections = PeopleSearchPolicy.filter(people.snapshot.sections, query: "")
        let waiting = try #require(sections.firstIndex(where: { $0.id == PeopleSectionID.waiting.rawValue }))
        let hands = try #require(sections.firstIndex(where: { $0.id == PeopleSectionID.raisedHands.rawValue }))
        #expect(waiting < hands, "the last Waiting row is the Raised Hands lead")
        #expect(sections[waiting].rowIds.first != nil && sections[hands].rowIds.first != nil,
                "both focus targets have a first row for the fallback")

        for isMediumDetent in [false, true] {
            for isPlaced in [false, true] {
                for isLive in [false, true] {
                    let fallsBack = isLive && !isPlaced && !isMediumDetent
                    let promotes = isLive && PeopleFocusPolicy.promotesToLarge(isPlaced: isPlaced, isMediumDetent: isMediumDetent)
                    #expect(!(fallsBack && promotes), "the fallback and the promotion never both run")
                    #expect((isLive && !isPlaced) == (fallsBack || promotes), "a live header that is not placed gets exactly one remedy")
                }
            }
        }

        let flat = s1pfFlat(try s1pfSource("Sources/Conclave/Features/Meeting/People/ParticipantsPanel+iOS.swift"))
        let task = try s1pfSlice(flat, from: "guard step == PeopleFocusStep.placeHeader else { return }", to: ".accessibilityRotor(")
        let loop = try #require(task.range(of: "while isLive && !isPlaced && attempts < PeopleFocusTiming.scrollAttempts {"))
        let lead = try #require(task.range(of: "proxy.scrollTo(lead, anchor: .top)", range: loop.upperBound..<task.endIndex))
        let header = try #require(task.range(of: "proxy.scrollTo(target, anchor: .top)", range: lead.upperBound..<task.endIndex))
        let loopEnd = try #require(task.range(of: "isPlaced = isLive && placement.isHeaderPlaced(request.sectionId) }",
                                              range: header.upperBound..<task.endIndex))
        let fallback = try #require(task.range(of: "if isLive && !isPlaced && !isMediumDetent", range: loopEnd.upperBound..<task.endIndex),
                                    "the fallback runs after the lead loop")
        let first = try #require(task.range(of: ", let first = PeopleSearchPolicy.filter(people.snapshot.sections, query: query) "
                                             + ".first(where: { $0.id == request.sectionId })?.rowIds.first {",
                                             range: fallback.upperBound..<task.endIndex))
        let row = try #require(task.range(of: "let row = PeopleFocusTarget.row(request.sectionId, first)",
                                          range: first.upperBound..<task.endIndex))
        let bottom = try #require(task.range(of: "if reduceMotion { proxy.scrollTo(row, anchor: .bottom) } "
                                              + "else { withAnimation { proxy.scrollTo(row, anchor: .bottom) } }",
                                              range: row.upperBound..<task.endIndex),
                                  "the first row lands at the bottom so its header sits directly above it")
        let settle = "try? await Task.sleep(for: .milliseconds(reduceMotion ? "
            + "PeopleFocusTiming.reducedSettleMilliseconds : PeopleFocusTiming.settleMilliseconds)) guard !Task.isCancelled else { return }"
        let reread = " isLive = PeopleSearchPolicy.filter(people.snapshot.sections, query: query).contains { $0.id == request.sectionId } "
            + "isPlaced = isLive && placement.isHeaderPlaced(request.sectionId) "
        let recheck = try #require(task.range(of: settle + reread, range: bottom.upperBound..<task.endIndex),
                                   "the fallback settles, then reads the live section and the header placement again")
        let leadReturn = "if isLive && !isPlaced, let lead = PeopleFocusTarget.lead(before: request.sectionId, "
            + "in: PeopleSearchPolicy.filter(people.snapshot.sections, query: query), "
            + "snapshot: people.snapshot, isSearching: PeopleSearchPolicy.isSearching(query)) { "
        let leadScroll = "if reduceMotion { proxy.scrollTo(lead, anchor: .top) } else { withAnimation { proxy.scrollTo(lead, anchor: .top) } } "
        let back = try #require(task.range(of: leadReturn + leadScroll + settle + " } }", range: recheck.upperBound..<task.endIndex),
                                "a fallback that still misses the header returns the lead to the top, so the title stays in view")
        #expect(back.lowerBound == recheck.upperBound, "the return to the lead follows the re-read directly")
        let promote = try #require(task.range(of: "if isLive && PeopleFocusPolicy.promotesToLarge(", range: back.upperBound..<task.endIndex),
                                   "the fallback and its return sit before the one promotion check")
        _ = try #require(task.range(of: "people.focusRequestHandled(id: request.id)", range: promote.upperBound..<task.endIndex))
        #expect(task.components(separatedBy: "proxy.scrollTo(row, anchor: .bottom)").count - 1 == 2)
        #expect(task.components(separatedBy: "proxy.scrollTo(lead, anchor: .top)").count - 1 == 4,
                "the lead loop and the one return after a missed fallback are the only lead scrolls")
        #expect(task.components(separatedBy: "placement.isHeaderPlaced(request.sectionId)").count - 1 == 2)
        #expect(task.components(separatedBy: "proxy.scrollTo(target,").count - 1 == 2,
                "a missed placement never retries the header id, which lands its first row under the panel title")
        #expect(!task.contains("proxy.scrollTo(target, anchor: .bottom)") && !task.contains("proxy.scrollTo(lead, anchor: .bottom)"))
        #expect(task.components(separatedBy: "PeopleFocusPolicy.promotesToLarge(").count - 1 == 1)
        #expect(task.components(separatedBy: "people.focusRequestHandled(").count - 1 == 1)
    }

    @Test func aFallbackThatCannotPlaceTheHeaderGivesWayToTheLead() {
        func placed(top: Double, header: Double, viewport: Double) -> Bool {
            PeopleFocusPolicy.isHeaderPlaced(headerTop: top, headerBottom: top + header, viewportTop: 0, viewportBottom: viewport)
        }
        func landing(viewport: Double, lead: Double, header: Double, row: Double) -> Double {
            if placed(top: lead, header: header, viewport: viewport) { return lead }
            let fallback = viewport - row - header
            return placed(top: fallback, header: header, viewport: viewport) ? fallback : lead
        }

        let knockFallback = 200.0 - 172 - 120
        #expect(!placed(top: 90, header: 120, viewport: 200) && !placed(top: knockFallback, header: 120, viewport: 200),
                "AX5 Knock View: a first Waiting row taller than the lead leaves the fallback unable to place the header")
        #expect(knockFallback < 0, "the fallback alone would cut the Waiting title")
        #expect(landing(viewport: 200, lead: 90, header: 120, row: 172) == 90, "the lead returns and the title stays in view")
        let tallRowFallback = 180.0 - 200 - 100
        #expect(tallRowFallback + 100 <= 0, "a first row taller than the viewport would hide the header entirely")
        #expect(landing(viewport: 180, lead: 100, header: 100, row: 200) == 100)
        #expect(!placed(top: 172, header: 140, viewport: 300) && placed(top: 300 - 100 - 140, header: 140, viewport: 300),
                "AX5 Hand View: a tall Waiting lead with a shorter first hand row")
        #expect(landing(viewport: 300, lead: 172, header: 140, row: 100) == 60, "a fallback that places the header is kept")
        #expect(landing(viewport: 480, lead: 60, header: 44, row: 64) == 60, "a lead that already places the header runs no fallback")
    }

    @Test func aSectionThatVanishesDuringPlacementIsConsumedWithoutPromotion() throws {
        let people = makePeople()
        people.apply(PeopleFixtureScript.inputs(for: .host6))
        people.panelDidOpen(destination: .peopleRaisedHands, presentationID: 13)
        let request = try #require(people.focusRequest)
        #expect(step(people, request) == .placeHeader)
        people.apply(PeopleFixtureScript.peopleInputs(roster: PeopleFixtureScript.handsLowered(PeopleFixtureScript.hostSix()),
                                                      state: .host6))
        let isLive = PeopleSearchPolicy.filter(people.snapshot.sections, query: "").contains { $0.id == request.sectionId }
        #expect(!isLive, "the last hand was lowered inside the settle window")
        #expect(people.focusRequest == request, "the running placement still owns the request")
        #expect(!(isLive && PeopleFocusPolicy.promotesToLarge(isPlaced: false, isMediumDetent: true)),
                "a section that is gone never promotes the sheet to large")
        people.focusRequestHandled(id: request.id)
        #expect(people.focusRequest == nil && people.focusReadout() == "destination=peopleRaisedHands scrolls=1")

        let flat = s1pfFlat(try s1pfSource("Sources/Conclave/Features/Meeting/People/ParticipantsPanel+iOS.swift"))
        let task = try s1pfSlice(flat, from: "guard step == PeopleFocusStep.placeHeader else { return }", to: ".accessibilityRotor(")
        #expect(task.contains("var isLive = true var isPlaced = false var attempts = 0"))
        #expect(task.contains("isLive = PeopleSearchPolicy.filter(people.snapshot.sections, query: query).contains { $0.id == request.sectionId }"),
                "the live section is read after each settle, not the list captured when the task started")
        #expect(task.contains("isPlaced = isLive && placement.isHeaderPlaced(request.sectionId)"))
        #expect(task.contains("if isLive && PeopleFocusPolicy.promotesToLarge(isPlaced: isPlaced, isMediumDetent: isMediumDetent) {"),
                "the promotion condition includes the live check")
        #expect(!task.contains("if PeopleFocusPolicy.promotesToLarge("))
        #expect(task.components(separatedBy: "people.focusRequestHandled(").count - 1 == 1,
                "a section that is gone is consumed by the one closing call, after no promotion")
    }

    @Test func iosConsumesAnAbsentSectionAtOnceAndNeverJumpsLater() throws {
        let people = makePeople()
        people.apply(PeopleFixtureScript.inputs(for: .host6))
        people.panelDidOpen(destination: .peopleWaiting, presentationID: 11)
        let request = try #require(people.focusRequest)
        let early = step(people, request)
        #expect(early == .awaitSection)
        if early == .consumeNow || early == .awaitSection { people.focusRequestHandled(id: request.id) }
        #expect(people.focusRequest == nil && people.focusReadout() == "destination=peopleWaiting scrolls=1")
        people.apply(PeopleFixtureScript.inputs(for: .hostWaiting3))
        #expect(shows(people, .waiting))
        #expect(people.focusRequest == nil && step(people, request) == .idle,
                "a Waiting section that arrives later never pulls the list on iOS")

        let panel = s1pfFlat(try s1pfSource("Sources/Conclave/Features/Meeting/People/ParticipantsPanel+iOS.swift"))
        #expect(panel.contains("private struct PeopleFocusKey: Equatable { let id: Int let isMediumDetent: Bool }"),
                "roster changes during placement never restart the iOS focus task")
        #expect(!panel.contains("focusId == 0 ? 0 : snapshot.revision"))
        #expect(panel.contains("if step == PeopleFocusStep.consumeNow || step == PeopleFocusStep.awaitSection {"))
    }

    @Test func androidWaitsForTheRevisionThatCarriesTheSection() throws {
        let page = s1pfFlat(try s1pfSource("Sources/Conclave/Skip/ui/people/ParticipantsPage.kt"))
        #expect(page.contains("internal fun peopleFocusWaitRevision(request: PeopleFocusRequest?, entries: List<PeopleListItem>, "
                              + "revision: Int): Int = if (request == null || entries.any { it.key == peopleHeaderKey(request.sectionId) }) "
                              + "-1 else revision"), "the effect key carries the revision only while the section is absent")
        #expect(page.contains("val focusWaitRevision = peopleFocusWaitRevision(focus, entries, snapshot.revision)"))
        #expect(page.contains("LaunchedEffect(focus?.id, focusWaitRevision) {"))
        #expect(!page.contains("LaunchedEffect(focus?.id) {"))
        #expect(!page.contains("if (focus == null) 0 else snapshot.revision"), "roster changes during placement never restart the scroll")
        #expect(page.contains("val currentEntries by rememberUpdatedState(entries)"))
        #expect(page.contains("import androidx.compose.runtime.rememberUpdatedState"))
        #expect(page.contains("placePeopleFocus(people, request, entries, snapshot.revision, searching, "
                              + "latestEntries = { currentEntries }, snap = { listState.scrollToItem(it) }) { index ->"),
                "a header that moved during the animation is snapped to its current index without animation")
        #expect(page.contains("PeopleFocusStep.placeHeader -> { try { scroll(index) "
                              + "val moved = latestEntries().indexOfFirst { it.key == peopleHeaderKey(request.sectionId) } "
                              + "if (moved >= 0 && moved != index) snap(moved) } "
                              + "finally { people.focusRequestHandled(id = request.id) } }"),
                "a drag that interrupts the scroll still consumes the request, so a later recomposition never replays it")
        #expect(page.contains("PeopleFocusStep.consumeNow -> people.focusRequestHandled(id = request.id)"))
        #expect(page.contains("PeopleFocusStep.awaitSection, PeopleFocusStep.idle -> Unit"))
        #expect(page.contains("val index = entries.indexOfFirst { it.key == peopleHeaderKey(request.sectionId) }"))
        #expect(!page.contains("stickyHeader"), "section headers scroll with the list below the page title, never pinned over it")
    }
}

private func s1pfRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1pfSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1pfRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func s1pfFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1pfSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
