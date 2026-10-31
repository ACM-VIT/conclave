#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct FND2InCallChromeTests {
    private static func model(muted: Bool = false, cameraOff: Bool = false, hand: Bool = false, pinned: Bool = false,
                              presenting: Bool = false, weak: Bool = false, reconnecting: Bool = false,
                              local: Bool = false) -> TileChromeModel {
        TileChromeModel(userId: "u1", displayName: "Avery Lee", avatarSeed: "Avery Lee:u1", isLocal: local, isMuted: muted,
                        isCameraOff: cameraOff, isHandRaised: hand, isPinned: pinned, isPresenting: presenting,
                        isWeakConnection: weak, isReconnecting: reconnecting, reconnectReason: "", isHost: false,
                        isVoiceAgent: false)
    }

    @Test func tileDensityFollowsTheSlotSize() {

        #expect(TileChromePolicy.density(width: 160, height: 130, isSpotlight: false) == .dense)
        #expect(TileChromePolicy.density(width: 200, height: 138.9, isSpotlight: false) == .dense)
        #expect(TileChromePolicy.density(width: 166.9, height: 200, isSpotlight: false) == .dense)
        #expect(TileChromePolicy.density(width: 167, height: 139, isSpotlight: false) == .normal)
        #expect(TileChromePolicy.density(width: 100, height: 100, isSpotlight: true) == .spotlight)
        #expect(TileChromePolicy.avatarSize(.normal) == 44 && TileChromePolicy.avatarSize(.dense) == 30 && TileChromePolicy.avatarSize(.spotlight) == 96)
        #expect(TileChromePolicy.badgeSize(.dense) == 16 && TileChromePolicy.badgeSize(.normal) == 24 && TileChromePolicy.badgeSize(.spotlight) == 24)
        #expect(TileChromePolicy.overflowAvatarLimit == 3)
    }

    @Test func tileStatesReadInOneOrderAndSpeakingComesFromTheLeaf() {
        let all = Self.model(muted: true, cameraOff: true, hand: true, pinned: true, presenting: true, weak: true, reconnecting: true)
        #expect(TileChromePolicy.states(all, isSpeaking: true) == TileChromeStateKind.allCases)
        #expect(TileChromePolicy.states(all, isSpeaking: false).contains(.speaking) == false)
        #expect(TileChromePolicy.states(Self.model(), isSpeaking: false).isEmpty)
        #expect(TileChromePolicy.trailingBadges(all) == [.pinned, .presenting, .weakConnection])
        #expect(TileChromePolicy.trailingBadges(Self.model(hand: true)).isEmpty)
        #expect(Self.model().id == "u1")
    }

    @Test func speakingStateWritesAreEqualityGuarded() {
        let state = TileSpeakingState()
        #expect(!state.isSpeaking)
        state.update(isSpeaking: true)
        #expect(state.isSpeaking)
        state.update(isSpeaking: true)
        #expect(state.isSpeaking)
        state.update(isSpeaking: false)
        #expect(!state.isSpeaking)
    }

    @Test func surfaceContextsSelectTheRightFill() {
        for glass in [false, true] {
            for contrast in [false, true] {
                let stage = ConclaveControlSurfaceMapping.spec(.on, context: .stage, glassAvailable: glass, reduceTransparency: false,
                                                               forceOpaque: false, increasedContrast: contrast, isEnabled: true)
                let legacy = ConclaveControlSurfaceMapping.spec(.on, glassAvailable: glass, reduceTransparency: false, forceOpaque: false,
                                                                increasedContrast: contrast, isEnabled: true)
                #expect(stage == legacy)
                let strip = ConclaveControlSurfaceMapping.spec(.on, context: .onSurface, glassAvailable: glass, reduceTransparency: false,
                                                               forceOpaque: false, increasedContrast: contrast, isEnabled: true)
                #expect(strip.fill == .fallback && strip.fillToken == DesignTokens.iosInCallControlFallback)
                let video = ConclaveControlSurfaceMapping.spec(.on, context: .overVideo, glassAvailable: glass, reduceTransparency: false,
                                                               forceOpaque: false, increasedContrast: contrast, isEnabled: true)
                #expect(video.fill == .scrim)
                #expect(video.fillToken == (contrast ? DesignTokens.iosInCallLabelScrimHighContrast : DesignTokens.iosInCallLabelScrim))
                #expect(video.strokeToken == (contrast ? DesignTokens.iosInCallBorderHighContrast : DesignTokens.iosInCallBorder))
            }
        }

        for context in ConclaveSurfaceContext.allCases {
            for state in [ConclaveControlState.off, .engaged] {
                #expect(ConclaveControlSurfaceMapping.spec(state, context: context, glassAvailable: true, reduceTransparency: false,
                                                           forceOpaque: false, increasedContrast: false, isEnabled: true).fill == .paper)
            }
        }
    }

    @Test func badgeRulesAndTagsHoldOnBothPlatforms() throws {
        #expect(!ConclaveBadgeCount.isVisible(0) && ConclaveBadgeCount.isVisible(1))
        #expect(ConclaveBadgeCount.displayed(99) == 99 && !ConclaveBadgeCount.isCapped(99))
        #expect(ConclaveBadgeCount.displayed(120) == 99 && ConclaveBadgeCount.isCapped(120))
        #expect(ConclavePersonTag.allCases.map { $0.rawValue } == ["host", "cohost", "you"])
    }

    @Test func darkSnackbarSlotUsesTheInCallRoles() throws {
        let pairs = Dictionary(ComponentGalleryCatalog.contrastPairs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        #expect(abs((pairs["contrast.snackbar.text"]?.ratio ?? 0) - 15.001) < 0.001)
        #expect(abs((pairs["contrast.snackbar.action"]?.ratio ?? 0) - 6.246) < 0.001)
        #expect(DesignTokens.androidInCallSurfaceContainerHigh == 0xFF232327)
    }

    @Test func toastItemReportsItsActionAndAvatar() throws {
        let item = ConclaveToastItem(id: "t1", message: "Avery raised a hand", actionTitle: "View", actionId: "view", avatarName: "Avery",
                                     avatarId: "", isFailure: false)
        #expect(item.hasAction && item.hasAvatar)
    }

    @Test func menuPolicyKeepsGroupsIconCompleteAndDestructiveLast() {
        func item(_ id: String, concept: String = "", role: MenuItemRole = .normal) -> MenuItemModel {
            MenuItemModel(id: id, title: id, concept: concept, role: role, isOn: false, isEnabled: true, disabledReason: "")
        }
        #expect(ConclaveMenuPolicy.isIconConsistent(MenuSectionModel(id: "a", items: [item("x", concept: "pin"), item("y", concept: "unpin")])))
        #expect(ConclaveMenuPolicy.isIconConsistent(MenuSectionModel(id: "b", items: [item("x"), item("y")])))
        #expect(!ConclaveMenuPolicy.isIconConsistent(MenuSectionModel(id: "c", items: [item("x", concept: "pin"), item("y")])))
        let good = [MenuSectionModel(id: "s1", items: [item("pin")]), MenuSectionModel(id: "s2", items: [item("remove", role: .destructive)])]
        let bad = [MenuSectionModel(id: "s1", items: [item("remove", role: .destructive), item("pin")])]
        #expect(ConclaveMenuPolicy.destructiveItemsAreLast(good))
        #expect(!ConclaveMenuPolicy.destructiveItemsAreLast(bad))
    }

    @Test func inCallChromeSpecimenIDsAndPairsAreStable() {
        #expect(ComponentGalleryCatalog.inCallChromeSpecimenIDs == [
            "chrome.capsule", "chrome.button", "stage.chip.hand", "stage.chip.nowPlaying", "badge.dot", "badge.tag", "badge.status",
            "tile.chrome.video", "tile.chrome.cameraOff", "tile.chrome.speaking", "tile.chrome.dense", "tile.chrome.reconnecting",
            "tile.chrome.selfFlip", "tile.chrome.spotlight", "stage.overflow", "toast.info", "toast.action", "menu.anchored",
            "menu.context", "palette.reactions", "sheet.actions", "sheet.route",
        ])
        let expected: [(String, Double)] = [
            ("contrast.leaveHighContrast.white", 4.555), ("contrast.leaveHighContrast.stage", 4.344), ("contrast.speakingRing.tile", 5.973),
            ("contrast.handBadge.ink", 11.855), ("contrast.coralFill.surfaceRaised", 5.043), ("contrast.coralFill.toolbar", 5.706),
            ("contrast.snackbarInPage.dark.text", 16.118), ("contrast.snackbarInPage.dark.action", 4.882),
            ("contrast.tagLight", 6.556), ("contrast.tagDark", 5.270), ("contrast.routeRadio", 7.398),
        ]

        let pairs = Dictionary(ComponentGalleryCatalog.contrastPairs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (id, ratio) in expected {
            let pair = pairs[id]
            #expect(pair != nil, "\(id)")
            #expect(abs((pair?.ratio ?? 0) - ratio) < 0.001, "\(id)")
            #expect(abs((pair?.expectedRatio ?? 0) - ratio) < 0.001, "\(id)")
        }
    }
}
#endif
