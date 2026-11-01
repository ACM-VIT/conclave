#if !SKIP
import Testing
@testable import Conclave

@MainActor
struct MacLargeWindowLayoutTests {
    private let macWindow = StageViewport(width: 1980, height: 1300, insetTop: 80, insetBottom: 84, insetLeading: 0, insetTrailing: 0,
                                          widthClass: StageSizeClass.regular, heightClass: StageSizeClass.regular, placement: .bottomBar)

    private var iphoneLandscape: StageViewport {
        StageViewportPolicy.iOS(contentWidth: 844, contentHeight: 390,
                                safeArea: StageChromeInsets(top: 0, bottom: 21, leading: 47, trailing: 47),
                                regularWidth: false, compactHeight: true, topReserve: 56, barReserve: 64, trailingReserve: 64)
    }

    @Test func phonesKeepTheLowerLeadingAloneComposition() {
        for viewport in [StagePoliciesTests.iphoneSE, StagePoliciesTests.iphone17e, iphoneLandscape] {
            #expect(!StageAlonePolicy.usesCenteredLayout(viewport), "\(viewport.width)x\(viewport.height)")
        }
    }

    @Test func largeWindowsCenterTheAloneCompositionWithRoomForTheInviteRow() {
        for viewport in [macWindow, StagePoliciesTests.ipadPortrait, StagePoliciesTests.ipadLandscape] {
            #expect(StageAlonePolicy.usesCenteredLayout(viewport), "\(viewport.width)x\(viewport.height)")
            let text = StageAlonePolicy.titleLineHeight * 2 + StageAlonePolicy.lineSpacing + StageAlonePolicy.statusLineHeight
            let composition = StageAlonePolicy.centeredAvatarDiameter + StageAlonePolicy.centeredSpacing * 2 + text + 44 + 4
            #expect(composition <= StageAlonePolicy.bandHeight(viewport))
        }
        let short = StageViewport(width: 1200, height: 420, insetTop: 80, insetBottom: 84, insetLeading: 0, insetTrailing: 0,
                                  widthClass: StageSizeClass.regular, heightClass: StageSizeClass.compact, placement: .bottomBar)
        #expect(!StageAlonePolicy.usesCenteredLayout(short))
        let narrow = StageViewport(width: 640, height: 1000, insetTop: 80, insetBottom: 84, insetLeading: 48, insetTrailing: 0,
                                   widthClass: StageSizeClass.regular, heightClass: StageSizeClass.regular, placement: .bottomBar)
        #expect(!StageAlonePolicy.usesCenteredLayout(narrow))
    }

    @Test func premeetingCentersOnlyForRegularWideWindows() {
        #expect(PremeetingLayoutPolicy.usesCenteredLayout(width: 1980, horizontalRegular: true, verticalRegular: true))
        #expect(PremeetingLayoutPolicy.usesCenteredLayout(width: 1032, horizontalRegular: true, verticalRegular: true))
        #expect(!PremeetingLayoutPolicy.usesCenteredLayout(width: 390, horizontalRegular: false, verticalRegular: true))
        #expect(!PremeetingLayoutPolicy.usesCenteredLayout(width: 844, horizontalRegular: false, verticalRegular: false))
        #expect(!PremeetingLayoutPolicy.usesCenteredLayout(width: 932, horizontalRegular: true, verticalRegular: false))
        #expect(!PremeetingLayoutPolicy.usesCenteredLayout(width: 694, horizontalRegular: true, verticalRegular: true))
    }

    @Test func homeContentStaysInAReadableColumn() {
        let wide = PremeetingLayoutPolicy.sideMargin(width: 1980, maxContentWidth: PremeetingLayoutPolicy.homeContentMaxWidth)
        #expect(1980 - wide * 2 == PremeetingLayoutPolicy.homeContentMaxWidth)
        #expect(PremeetingLayoutPolicy.sideMargin(width: 600, maxContentWidth: PremeetingLayoutPolicy.homeContentMaxWidth)
                == PremeetingLayoutPolicy.minimumMargin)
    }

    @Test func lobbyPreviewAndSettingsShareOneBoundedComposition() {
        let full = PremeetingLayoutPolicy.lobbyPreviewMaxWidth + PremeetingLayoutPolicy.lobbySpacing + PremeetingLayoutPolicy.lobbyColumnWidth
        #expect(PremeetingLayoutPolicy.lobbyCompositionWidth(width: 1980) == full)
        #expect(PremeetingLayoutPolicy.lobbyPreviewWidth(width: 1980) == PremeetingLayoutPolicy.lobbyPreviewMaxWidth)
        #expect(PremeetingLayoutPolicy.lobbyPreviewWidth(width: 1032) == 1032 - 40 - 32 - 360)
        let smallest = PremeetingLayoutPolicy.lobbyPreviewWidth(width: PremeetingLayoutPolicy.centeredMinWidth)
        #expect(smallest >= 360 && smallest < PremeetingLayoutPolicy.lobbyPreviewMaxWidth)
        #expect(PremeetingLayoutPolicy.lobbyCompositionWidth(width: PremeetingLayoutPolicy.centeredMinWidth)
                <= PremeetingLayoutPolicy.centeredMinWidth - PremeetingLayoutPolicy.minimumMargin * 2)
    }
}
#endif
