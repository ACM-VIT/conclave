#if !SKIP
import Testing
@testable import Conclave

@MainActor
struct MacLargeWindowLayoutTests {
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
