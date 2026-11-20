#if !SKIP
import Testing
@testable import Conclave

struct GameFitPolicyTests {
    static let iosActivityHeader = 48.0
    static let androidActivityHeader = 60.0

    static let iphone17 = StageViewportPolicy.iOS(contentWidth: 402, contentHeight: 778,
                                                 safeArea: StageChromeInsets(top: 62, bottom: 34, leading: 0, trailing: 0),
                                                 regularWidth: false, compactHeight: false, topReserve: 56, barReserve: 64,
                                                 trailingReserve: 64)

    static let android411 = StageViewport(width: 1080.0 / 2.625, height: 2400.0 / 2.625, insetTop: 24 + 60, insetBottom: 24 + 76,
                                          insetLeading: 0, insetTrailing: 0, widthClass: StageSizeClass.compact,
                                          heightClass: StageSizeClass.medium, placement: .bottomBar)

    static func gameCard(_ viewport: StageViewport) -> StageFrame {
        StageLayoutPolicy.mainFrameFor(viewport: viewport, kind: .game, hasRail: true)
    }

    static func space(_ viewport: StageViewport, header: Double, notices: Double = 0) -> GameFitSpace {
        let card = gameCard(viewport)
        return GameFitPolicy.sceneSpace(viewportWidth: card.width, viewportHeight: card.height - header, hiddenBottom: 0,
                                        noticesHeight: notices)
    }

    static let iphoneSpace = space(iphone17, header: iosActivityHeader)
    static let androidSpace = space(android411, header: androidActivityHeader)

    static func primaryBottom(_ fit: WordleFitLayout, lead: Double, input: Double) -> Double {
        lead + WordleFitPolicy.sectionSpacing + fit.boardHeight + (input > 0 ? WordleFitPolicy.sectionSpacing + input : 0)
    }

    @Test func theStagesMatchTheCardsCapturedOnDevices() {
        #expect(abs(Self.gameCard(Self.iphone17).height - 526) <= 1.5)
        #expect(abs(Self.gameCard(Self.android411).height - 1572.0 / 2.625) <= 1.5)
        #expect(Self.iphoneSpace.height == 447 && Self.iphoneSpace.width == 354)
        #expect(abs(Self.androidSpace.height - 507.3) < 0.1)
    }

    @Test func anIPhoneTakeTurnsPlayerSeesTheBannerTheWholeBoardAndTheKeyboardWithoutScrolling() {
        let keyboard = GameFitMetrics.iOS.keyboardHeight
        let banner = GameFitMetrics.iOS.bannerHeight
        let fit = WordleFitPolicy.layout(space: Self.iphoneSpace, lead: banner, input: keyboard, rows: 6, columns: 5)
        #expect(fit.fits)
        #expect(fit.cellSide == 32)
        #expect(Self.primaryBottom(fit, lead: banner, input: keyboard) <= Self.iphoneSpace.height)
        #expect(!WordleFitPolicy.showsHint(space: Self.iphoneSpace, metrics: .iOS, rows: 6, columns: 5, hasKeyboard: true))
    }

    @Test func anAndroidTakeTurnsPlayerKeepsFullSizeTilesAndTheTurnBannerInView() {
        let keyboard = GameFitMetrics.android.keyboardHeight
        let banner = GameFitMetrics.android.bannerHeight
        let fit = WordleFitPolicy.layout(space: Self.androidSpace, lead: banner, input: keyboard, rows: 6, columns: 5)
        #expect(fit.fits)
        #expect(fit.cellSide == WordleFitPolicy.maximumCell)
        #expect(Self.primaryBottom(fit, lead: banner, input: keyboard) <= Self.androidSpace.height)
        #expect(!WordleFitPolicy.showsHint(space: Self.androidSpace, metrics: .android, rows: 6, columns: 5, hasKeyboard: true))
    }

    @Test func soloWordleShrinksTheTilesOnlyAsFarAsTheKeyboardNeeds() {
        let iosSolo = WordleFitPolicy.layout(space: Self.iphoneSpace, lead: 44, input: GameFitMetrics.iOS.keyboardHeight, rows: 6, columns: 5)
        #expect(iosSolo.fits && iosSolo.cellSide == 35)
        let androidSolo = WordleFitPolicy.layout(space: Self.androidSpace, lead: 44, input: GameFitMetrics.android.keyboardHeight,
                                                 rows: 6, columns: 5)
        #expect(androidSolo.fits && androidSolo.cellSide == WordleFitPolicy.maximumCell)
    }

    @Test func watchingATeammateOrTheSetterBoardNeedsNoShrinkingWithoutAKeyboard() {
        let teammate = WordleFitPolicy.layout(space: Self.iphoneSpace, lead: 60, input: 0, rows: 6, columns: 5)
        #expect(teammate.fits && teammate.cellSide == WordleFitPolicy.maximumCell)
        let spectator = WordleFitPolicy.layout(space: Self.iphoneSpace, lead: 60 + 10 + 64, input: 0, rows: 6, columns: 5)
        #expect(spectator.fits && spectator.cellSide == WordleFitPolicy.maximumCell)
    }

    @Test func aNoticeTakesItsRoomFromTheBoardBeforeAnythingElse() {
        let noticed = Self.space(Self.iphone17, header: Self.iosActivityHeader, notices: 46)
        #expect(noticed.height == Self.iphoneSpace.height - 46 - GameFitPolicy.noticeSpacing)
        let fit = WordleFitPolicy.layout(space: noticed, lead: GameFitMetrics.iOS.bannerHeight, input: GameFitMetrics.iOS.keyboardHeight,
                                         rows: 6, columns: 5)
        #expect(fit.cellSide == WordleFitPolicy.minimumCell)
        let android = Self.space(Self.android411, header: Self.androidActivityHeader, notices: 46)
        let roomy = WordleFitPolicy.layout(space: android, lead: 44, input: GameFitMetrics.android.keyboardHeight, rows: 6, columns: 5)
        #expect(roomy.fits && roomy.cellSide < WordleFitPolicy.maximumCell)
    }

    @Test func largeTextFallsBackToTheSmallestTilesAndLetsTheCardScroll() {
        let fit = WordleFitPolicy.layout(space: Self.iphoneSpace, lead: 140, input: 180, rows: 6, columns: 5)
        #expect(!fit.fits)
        #expect(fit.cellSide == WordleFitPolicy.minimumCell)
        #expect(fit.boardHeight == WordleFitPolicy.boardRange(rows: 6).minimum)
    }

    @Test func roomyStagesKeepTheFullBannerAndFullSizeTiles() {
        let ipad = GameFitSpace(width: 700, height: 820)
        #expect(WordleFitPolicy.showsHint(space: ipad, metrics: .iOS, rows: 6, columns: 5, hasKeyboard: true))
        #expect(WordleFitPolicy.layout(space: ipad, lead: 100, input: 144, rows: 6, columns: 5).cellSide == WordleFitPolicy.maximumCell)
        #expect(WordleFitPolicy.layout(space: .unbounded, lead: 100, input: 144, rows: 6, columns: 5).cellSide == WordleFitPolicy.maximumCell)
        #expect(WordleFitPolicy.showsHint(space: .unbounded, metrics: .android, rows: 6, columns: 5, hasKeyboard: true))
    }

    @Test func longWordsOnNarrowCardsAreCappedByTheWidth() {
        let narrow = GameFitSpace(width: 220, height: 900)
        let fit = WordleFitPolicy.layout(space: narrow, lead: 64, input: 144, rows: 6, columns: 7)
        #expect(fit.cellSide == 28)
        #expect(WordleFitPolicy.boardWidth(cell: fit.cellSide, columns: 7) <= narrow.width)
    }

    @Test func theRoundClockIsDroppedWhenItEqualsTheTurnClock() {
        #expect(WordleClockPolicy.plan(roundDeadlineMillis: 90_000, turnDeadlineMillis: 90_400)
                == WordleClockPlan(chip: .turn, showsRoundInMeta: false))
        #expect(WordleClockPolicy.plan(roundDeadlineMillis: 180_000, turnDeadlineMillis: 90_000)
                == WordleClockPlan(chip: .turn, showsRoundInMeta: true))
        #expect(WordleClockPolicy.plan(roundDeadlineMillis: 60_000, turnDeadlineMillis: 90_000)
                == WordleClockPlan(chip: .round, showsRoundInMeta: false))
        #expect(WordleClockPolicy.plan(roundDeadlineMillis: 120_000, turnDeadlineMillis: 0)
                == WordleClockPlan(chip: .round, showsRoundInMeta: false))
        #expect(WordleClockPolicy.plan(roundDeadlineMillis: 0, turnDeadlineMillis: 30_000)
                == WordleClockPlan(chip: .turn, showsRoundInMeta: false))
        #expect(WordleClockPolicy.plan(roundDeadlineMillis: 0, turnDeadlineMillis: 0) == WordleClockPlan(chip: .none, showsRoundInMeta: false))
    }

    @Test func theLongShotLadderFitsUnderTheAnswerFieldOnAnIPhone() {
        let above = 211.0
        let height = GameFitPolicy.flexHeight(space: Self.iphoneSpace, fixed: above + 14, range: LongShotFitPolicy.ladderRange(count: 6))
        let rung = LongShotFitPolicy.rungHeight(height: height, count: 6)
        #expect(rung == 33)
        #expect(above + 14 + LongShotFitPolicy.ladderHeight(rung: rung, count: 6) <= Self.iphoneSpace.height)
        #expect(LongShotFitPolicy.ladderHeight(rung: LongShotFitPolicy.maximumRung, count: 6) + above + 14 > Self.iphoneSpace.height)
    }

    @Test func theLongShotLadderKeepsFullRungsWhenThereIsRoom() {
        let height = GameFitPolicy.flexHeight(space: Self.androidSpace, fixed: 230, range: LongShotFitPolicy.ladderRange(count: 6))
        #expect(LongShotFitPolicy.rungHeight(height: height, count: 6) == LongShotFitPolicy.maximumRung)
        let crowded = GameFitPolicy.flexHeight(space: Self.iphoneSpace, fixed: 400, range: LongShotFitPolicy.ladderRange(count: 6))
        #expect(LongShotFitPolicy.rungHeight(height: crowded, count: 6) == LongShotFitPolicy.minimumRung)
    }

    @Test(arguments: [Double.nan, Double.infinity, -1.0, 0.0])
    func invalidMeasurementsNeverShrinkTheGame(value: Double) {
        let space = GameFitPolicy.sceneSpace(viewportWidth: 354, viewportHeight: value, hiddenBottom: 0, noticesHeight: 0)
        #expect(space == .unbounded)
        #expect(WordleFitPolicy.layout(space: space, lead: 64, input: 144, rows: 6, columns: 5).cellSide == WordleFitPolicy.maximumCell)
        #expect(LongShotFitPolicy.rungHeight(height: value, count: 6) == LongShotFitPolicy.maximumRung)
        #expect(GameFitPolicy.flexHeight(space: Self.iphoneSpace, fixed: value.isFinite ? value : .nan,
                                         range: GameFitRange(minimum: 10, maximum: 20)) >= 10)
    }

    @Test func aBarCoveringTheBottomOfTheScrollViewIsNotCountedAsRoom() {
        let space = GameFitPolicy.sceneSpace(viewportWidth: 386, viewportHeight: 479, hiddenBottom: 68, noticesHeight: 0)
        #expect(space.height == 479 - 68 - 32)
    }
}
#endif
