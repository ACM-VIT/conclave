#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct FND3ContentComponentsTests {

    @Test func composerMaterialFollowsTheBranchCondition() {
        var rows = 0
        for glassAvailable in [false, true] {
            for reduceTransparency in [false, true] {
                for forceOpaque in [false, true] {
                    for reduced in [false, true] {
                        let material = ConclaveComposerMaterialPolicy.material(glassAvailable: glassAvailable, reduceTransparency: reduceTransparency,
                                                                               forceOpaque: forceOpaque, prefersReducedResourceUsage: reduced)
                        let glass = glassAvailable && !reduceTransparency && !forceOpaque && !reduced
                        #expect(material == (glass ? .glass : .opaque), "glass \(glassAvailable) RT \(reduceTransparency) force \(forceOpaque) reduced \(reduced)")
                        rows += 1
                    }
                }
            }
        }
        #expect(rows == 16)

        #expect(ConclaveComposerMaterialPolicy.glassShapeCount(.glass, hasAttach: true) == 2)
        #expect(ConclaveComposerMaterialPolicy.glassShapeCount(.glass, hasAttach: false) == 1)
        #expect(ConclaveComposerMaterialPolicy.glassShapeCount(.opaque, hasAttach: true) == 0)
        #expect(ConclaveComposerMaterial.allCases.map { $0.rawValue } == ["glass", "opaque"])
    }

    @Test func composerGeometryAndCounterMatchTheSpecs() {
        #expect(ConclaveComposerMetrics.glassCornerRadius == 22)
        #expect(ConclaveComposerMetrics.opaqueCornerRadius == 18 && ConclaveComposerMetrics.opaqueCornerRadius == DesignTokens.radiusBubble)
        #expect(ConclaveComposerMetrics.androidCornerRadius == 20 && ConclaveComposerMetrics.androidCornerRadius == DesignTokens.radiusBubbleAndroid)
        #expect(ConclaveComposerMetrics.clusterSpacing == 8 && ConclaveComposerMetrics.attachDiameter == 44)
        #expect(ConclaveComposerMetrics.fieldHorizontalPadding == 12 && ConclaveComposerMetrics.fieldVerticalPadding == 8)
        #expect(ConclaveComposerMetrics.minimumFieldHeight == 44 && ConclaveComposerMetrics.maximumLines == 6)
        #expect(ConclaveComposerMetrics.stackSpacing == 8 && ConclaveComposerMetrics.stackHorizontalPadding == 16)
        #expect(ConclaveComposerMetrics.replyBarWidth == 3)

        #expect(ConclaveComposerCounterPolicy.visibleFrom(limit: 1000) == 900)
        #expect(ConclaveComposerCounterPolicy.visibleFrom(limit: 500) == 450)
        #expect(ConclaveComposerCounterPolicy.visibleFrom(limit: 0) == 0)
        #expect(!ConclaveComposerCounterPolicy.isVisible(count: 899, limit: 1000, alwaysVisible: false))
        #expect(ConclaveComposerCounterPolicy.isVisible(count: 900, limit: 1000, alwaysVisible: false))
        #expect(ConclaveComposerCounterPolicy.isVisible(count: 0, limit: 500, alwaysVisible: true))
        #expect(!ConclaveComposerCounterPolicy.isVisible(count: 10, limit: 0, alwaysVisible: true))
        #expect(ConclaveComposerCounterPolicy.overflow(count: 1200, limit: 1000) == 200)
        #expect(ConclaveComposerCounterPolicy.overflow(count: 1000, limit: 1000) == 0)

        for phase in ConclaveAttachmentPhase.allCases {
            #expect(phase.blocksSend == (phase != .ready))
            #expect(phase.showsProgress == (phase == .preparing || phase == .uploading))
            #expect(phase.offersRetry == (phase == .failed))
        }
    }

    @Test func searchFiltersTheSnapshotInPlace() throws {
        let items = [ConclaveSearchItem(id: "a", text: "Avery Lee"), ConclaveSearchItem(id: "b", text: "Sam Ortiz"),
                     ConclaveSearchItem(id: "c", text: "Lee Chen")]
        #expect(ConclaveSearchPolicy.filter(items, query: "") == ["a", "b", "c"])
        #expect(ConclaveSearchPolicy.filter(items, query: "   ") == ["a", "b", "c"])
        #expect(ConclaveSearchPolicy.filter(items, query: "lee") == ["a", "c"])
        #expect(ConclaveSearchPolicy.filter(items, query: "  LEE  av ") == ["a"])
        #expect(ConclaveSearchPolicy.filter(items, query: "zed").isEmpty)
        #expect(ConclaveSearchPolicy.terms("  Avery   Lee ") == ["avery", "lee"])
        #expect(ConclaveSearchPolicy.matches("Avery Lee", query: "ver"))
        #expect(!ConclaveSearchPolicy.isSearching(" \n") && ConclaveSearchPolicy.isSearching(" a"))
        #expect(ConclaveSearchPolicy.announcementDelayMillis == 1000)
    }

    @Test func segmentedControlFallsBackWithoutClipping() throws {
        #expect(!ConclaveSegmentedPolicy.iosUsesRows(isAccessibilitySize: false, segmentCount: 3))
        #expect(ConclaveSegmentedPolicy.iosUsesRows(isAccessibilitySize: true, segmentCount: 3))
        #expect(ConclaveSegmentedPolicy.iosUsesRows(isAccessibilitySize: false, segmentCount: 5))
        #expect(!ConclaveSegmentedPolicy.androidUsesFallback(fontScale: 1.49, segmentCount: 3))
        #expect(ConclaveSegmentedPolicy.androidUsesFallback(fontScale: 1.5, segmentCount: 3))
        #expect(ConclaveSegmentedPolicy.androidUsesFallback(fontScale: 1.0, segmentCount: 5))
        #expect(ConclaveSegmentedFallback.allCases.map { $0.rawValue } == ["rows", "menu"])
    }

    @Test func bubbleGeometryGroupsOnTheSenderSide() throws {
        let full = 20.0
        let tail = 4.0
        for isOwn in [false, true] {
            for followUp in [false, true] {
                for follower in [false, true] {
                    let corners = ConclaveBubbleGeometry.androidCorners(isOwn: isOwn, isFollowUp: followUp, hasFollower: follower)
                    let top = followUp ? tail : full
                    let bottom = follower ? tail : full
                    let expected = isOwn
                        ? ConclaveBubbleCorners(topStart: full, topEnd: top, bottomEnd: bottom, bottomStart: full)
                        : ConclaveBubbleCorners(topStart: top, topEnd: full, bottomEnd: full, bottomStart: bottom)
                    #expect(corners == expected, "own \(isOwn) followUp \(followUp) follower \(follower)")
                }
            }
        }
        #expect(ConclaveBubbleGeometry.iosCornerRadius == 18)
        #expect(ConclaveBubbleGeometry.androidTailRadius == DesignTokens.radiusBubbleTailAndroid)
        #expect(ConclaveBubbleGeometry.horizontalPadding == 12 && ConclaveBubbleGeometry.verticalPadding == 8)
        #expect(ConclaveBubbleGeometry.maxWidth(listWidth: 400) == 320)
        #expect(ConclaveBubbleGeometry.quoteBarWidth == 3 && ConclaveBubbleGeometry.quoteCornerRadius == 8)
        #expect(ConclaveBubbleTone.allCases.filter { $0.usesCoralFill } == [.own])
        #expect(ConclaveBubbleTone.allCases.filter { $0.hasBorder } == [.privateMessage])

        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.iosAppOnCoral, background: DesignTokens.iosAppCoralFill) - 6.374) < 0.001)
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.iosAppOnCoralHighContrast, background: DesignTokens.iosAppCoralFill) - 6.764) < 0.001)
        #expect(DesignTokens.androidLightPrimaryContainer == DesignTokens.coral && DesignTokens.androidDarkPrimaryContainer == DesignTokens.coral)
    }

    @Test func reactionChipPlaysOnlyWhenItAdds() throws {
        func chip(mine: Bool, canToggle: Bool) -> ConclaveReactionChipModel {
            ConclaveReactionChipModel(id: "x", emoji: "x", count: 2, isMine: mine, canToggle: canToggle, accessibilityLabel: "label")
        }
        #expect(ConclaveReactionChipPolicy.feedback(chip(mine: false, canToggle: true)) == .reactionSent)
        #expect(ConclaveReactionChipPolicy.feedback(chip(mine: true, canToggle: true)) == FeedbackKind.none)
        #expect(ConclaveReactionChipPolicy.feedback(chip(mine: false, canToggle: false)) == FeedbackKind.none)
        #expect(!FeedbackKind.reactionSent.isAsyncOutcome)
        #expect(ConclaveReactionChipPolicy.iosVisualHeight == 28 && ConclaveReactionChipPolicy.iosTarget == 44)
        #expect(ConclaveReactionChipPolicy.androidVisualHeight == 32 && ConclaveReactionChipPolicy.androidTarget == 48)
        #expect(ConclaveReactionChipPolicy.spacing == 4)
    }

    @Test func tipShowsOncePerIdInsidePanelsOnly() throws {
        #expect(OneTimeTipPolicy.storeKey(OneTimeTipID.gifPicker.rawValue) == "conclave.tip.gifPicker")
        #expect(OneTimeTipID.allCases.map { $0.rawValue } == ["gifPicker"])
        #expect(OneTimeTipPolicy.isEligible(isDismissed: false, isPanelPresented: true, isOtherTipShown: false, contentState: .ready))
        #expect(!OneTimeTipPolicy.isEligible(isDismissed: true, isPanelPresented: true, isOtherTipShown: false, contentState: .ready))
        #expect(!OneTimeTipPolicy.isEligible(isDismissed: false, isPanelPresented: false, isOtherTipShown: false, contentState: .ready))
        #expect(!OneTimeTipPolicy.isEligible(isDismissed: false, isPanelPresented: true, isOtherTipShown: true, contentState: .ready))
        for state in [OneTimeTipContentState.loading, .empty, .error] {
            #expect(!OneTimeTipPolicy.isEligible(isDismissed: false, isPanelPresented: true, isOtherTipShown: false, contentState: state))
        }
    }

    @Test func textEntryDialogCapsAndConfirmsOnlyRealText() throws {
        #expect(ConclaveTextEntryPolicy.capped(String(repeating: "a", count: 45), limit: 40).count == 40)
        #expect(ConclaveTextEntryPolicy.capped("Avery", limit: 40) == "Avery")
        #expect(ConclaveTextEntryPolicy.capped(String(repeating: "a", count: 45), limit: 0).count == 45)
        #expect(!ConclaveTextEntryPolicy.canConfirm("   ", isPending: false))
        #expect(!ConclaveTextEntryPolicy.canConfirm("Avery", isPending: true))
        #expect(ConclaveTextEntryPolicy.canConfirm(" Avery ", isPending: false))
        let name = ConclaveTextEntryDialogModel(kind: .name, title: "Change Name", message: "Up to 40 characters.", fieldLabel: "Name",
                                                confirmTitle: "Save", limit: 40, counterFrom: 30)
        #expect(!ConclaveTextEntryPolicy.showsCounter(count: 29, model: name))
        #expect(ConclaveTextEntryPolicy.showsCounter(count: 30, model: name))
        #expect(ConclaveTextEntryPolicy.multilineMinLines == 4 && ConclaveTextEntryPolicy.multilineMaxLines == 8)
    }

    @Test func boardTokensComeFromTheZincRamp() throws {
        #expect(DesignTokens.iosGameBoardLight == DesignTokens.neutralZinc500)
        #expect(DesignTokens.iosGameBoardDark == DesignTokens.neutralZinc700)
        #expect(DesignTokens.androidExtendedGameBoardLight == DesignTokens.iosGameBoardLight)
        #expect(DesignTokens.androidExtendedGameBoardDark == DesignTokens.iosGameBoardDark)
        func ratio(_ foreground: Int64, _ background: Int64) -> Double { ContrastRatio.wcag(foreground: foreground, background: background) }
        #expect(abs(ratio(DesignTokens.paper, DesignTokens.iosGameBoardLight) - 4.630) < 0.001)
        #expect(abs(ratio(DesignTokens.paper, DesignTokens.iosGameBoardDark) - 10.006) < 0.001)
        #expect(abs(ratio(DesignTokens.iosGameBoardLight, DesignTokens.iosGameBoardDark) - 2.161) < 0.001)
        #expect(abs(ratio(DesignTokens.coral, DesignTokens.iosGameBoardDark) - 3.364) < 0.001)
    }

    @Test func contentSpecimenIDsAndPairsAreStable() {
        #expect(ComponentGalleryCatalog.contentSpecimenIDs == [
            "field.composer.glass", "field.composer.accessories", "field.search", "segmented.single", "segmented.menu",
            "chat.bubble.own", "chat.bubble.peer", "chat.bubble.private", "chat.bubble.answer", "chip.reaction", "tip.inline",
            "dialog.textEntry", "game.board.tokens",
        ])
        let all = ComponentGalleryCatalog.foundationSpecimenIDs + ComponentGalleryCatalog.inCallChromeSpecimenIDs
            + ComponentGalleryCatalog.contentSpecimenIDs
        #expect(Set(all).count == all.count)
        let base = Set(ComponentGalleryCatalog.componentSpecimenIDs(showLoading: true).map {
            $0.replacingOccurrences(of: ".inCall", with: "").replacingOccurrences(of: ".app", with: "")
        })
        #expect(Set(ComponentGalleryCatalog.contentSpecimenIDs).isDisjoint(with: base))
        for id in ComponentGalleryCatalog.contentSpecimenIDs { #expect(id.unicodeScalars.allSatisfy { $0.isASCII && $0 != " " }, "\(id)") }
        let expected: [(String, Double)] = [
            ("contrast.bubbleOwn.android", 6.374), ("contrast.bubblePeer.androidLight", 15.566), ("contrast.bubblePeer.androidDark", 15.001),
            ("contrast.bubbleLink.androidDark", 6.246), ("contrast.reactionChip.androidLight", 15.026), ("contrast.reactionChip.androidDark", 12.940),
            ("contrast.tipBody.androidLight", 6.792), ("contrast.tipBody.androidDark", 6.109), ("contrast.composerSend.androidLight", 4.551),
            ("contrast.composerSend.androidDark", 5.388), ("contrast.gameBoard.paperOnLight", 4.630), ("contrast.gameBoard.paperOnDark", 10.006),
            ("contrast.gameBoard.squares", 2.161), ("contrast.gameBoard.coralPath", 3.364),
        ]

        let pairs = Dictionary(ComponentGalleryCatalog.contrastPairs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (id, value) in expected {
            let pair = pairs[id]
            #expect(pair != nil, "\(id)")
            #expect(abs((pair?.ratio ?? 0) - value) < 0.001 && abs((pair?.expectedRatio ?? 0) - value) < 0.001, "\(id)")
        }
        #expect(Array(ComponentGalleryCatalog.contrastPairs.suffix(14).map { $0.id }) == expected.map { $0.0 })
    }

    static let composerGlassFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveComposerGlass+iOS.swift"
}
#endif
