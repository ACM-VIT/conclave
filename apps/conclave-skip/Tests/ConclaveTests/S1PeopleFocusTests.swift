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
