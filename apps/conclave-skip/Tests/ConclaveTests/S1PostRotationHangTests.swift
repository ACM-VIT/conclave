#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1PostRotationHangTests {
    static let lanesFile = "Sources/Conclave/Features/Meeting/Stage/NoticeLanes+iOS.swift"

    private func rotationTransient(insetLeading: Double, insetTrailing: Double, selfX: Double) -> NoticeLaneGeometry {
        let viewport = StageViewport(width: 390, height: 844, insetTop: 56, insetBottom: 32, insetLeading: insetLeading,
                                     insetTrailing: insetTrailing, widthClass: StageSizeClass.compact,
                                     heightClass: StageSizeClass.compact, placement: .trailingStack)
        let floating = StageFrame(slotId: "p:you", x: selfX, y: 654.4, width: 109.2, height: 145.6)
        return NoticeLaneGeometryPolicy.geometry(viewport: viewport, frames: [floating],
                                                 slots: [StageSlot(id: "p:you", role: .selfFloating, userId: "you", fit: .fill)],
                                                 chipsVisible: false)
    }

    @Test func theNoticeLayerTakesItsProposalSoTheToastPaddingsNeverResizeTheCallRoot() throws {
        let lanes = stageNormalized(try stageSource(Self.lanesFile))
        #expect(lanes.contains("NoticeBottomLanes(stage: stage, forceScreenReader: forceScreenReader) .accessibilitySortPriority(0.4) } .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity) .ignoresSafeArea() .environment(\\.colorScheme, .dark)"))
    }

    @Test func theRotationTransientToastPaddingsOverflowTheSafeAreaProposal() {
        let proposal = 390.0 - 47.0 - 47.0
        let wide = rotationTransient(insetLeading: 47, insetTrailing: 111, selfX: 157.8)
        #expect(abs(wide.toastLeading - 59) < 0.001 && abs(wide.toastTrailing - 240.2) < 0.001)
        #expect(wide.toastLeading + wide.toastTrailing > proposal, "the lanes ask for 299.2 pt inside a 296 pt proposal")
        let narrow = rotationTransient(insetLeading: 45.4, insetTrailing: 109.4, selfX: 159.4)
        #expect(abs(narrow.toastLeading - 57.4) < 0.001 && abs(narrow.toastTrailing - 238.6) < 0.001)
        #expect(abs(narrow.toastLeading + narrow.toastTrailing - proposal) < 0.001, "the other half of the 2-cycle fits exactly")
    }
}
#endif
