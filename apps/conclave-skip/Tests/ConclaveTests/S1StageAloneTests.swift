#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1StageAloneTests {
    static let iosFile = "Sources/Conclave/Features/Meeting/Stage/StageAloneIdentity+iOS.swift"
    static let androidFile = "Sources/Conclave/Skip/ui/call/stage/StageAloneIdentity.kt"

    private func presenter(_ inputs: StageInputs, viewport: StageViewport = StagePoliciesTests.iphone17e) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(viewport)
        stage.apply(inputs)
        return stage
    }

    private func solo(roomLabel: String = StageFixtureScript.roomLabel, cameraOn: Bool = false, confirmed: Bool = true) -> StageInputs {
        StageInputs.make(callSession: 1, isInCall: true, localUserId: StageFixtureScript.localUserId, roomLabel: roomLabel,
                         meetingLink: StageFixtureScript.meetingLink,
                         participants: StageFixtureScript.roster(count: 1, localCameraOn: cameraOn), isAloneConfirmed: confirmed)
    }

    @Test func theAloneCompositionAppearsOnlyWhenPresenceIsConfirmedAndTheCameraIsOff() throws {
        let stage = presenter(StageFixtureScript.inputs(for: .soloCameraOffAlone))
        let alone = try #require(stage.alone)
        #expect(alone.slotId == StageSlot.participantId(StageFixtureScript.localUserId))
        #expect(alone.roomLabel == StageFixtureScript.roomLabel)
        #expect(stage.layout.kind == .solo && stage.layout.slots.map(\.id) == [alone.slotId])
        #expect(stage.layout.slots.first?.role == .spotlightMain)
        #expect(presenter(StageFixtureScript.inputs(for: .soloCameraOff)).alone == alone)
        #expect(presenter(StageFixtureScript.inputs(for: .soloCameraOn)).alone == nil)
        #expect(presenter(StageFixtureScript.inputs(for: .soloUnconfirmed)).alone == nil)
        for state in [StageFixtureState.oneOnOne, .oneOnOneCameraOff, .grid4, .presentationLocal, .attendeeWaiting128] {
            #expect(presenter(StageFixtureScript.inputs(for: state)).alone == nil, "\(state.rawValue)")
        }
        #expect(presenter(solo(roomLabel: "  ")).alone == nil)
        #expect(presenter(StageFixtureScript.copy(solo(), isWebinarAttendee: true)).alone == nil)
    }

    @Test func cameraPresenceAndArrivalsSwapTheCompositionWithoutReflowingTheSoloSlot() {
        let stage = presenter(solo(confirmed: false))
        #expect(stage.alone == nil)
        stage.apply(solo(confirmed: false))
        #expect(stage.alone == nil)
        stage.apply(solo())
        #expect(stage.alone != nil)
        let revision = stage.layout.revision
        let frames = stage.currentFrames()
        stage.apply(solo(cameraOn: true))
        #expect(stage.alone == nil)
        #expect(stage.layout.revision == revision && stage.currentFrames() == frames)
        stage.apply(solo())
        #expect(stage.alone != nil && stage.layout.revision == revision)
        stage.apply(StageFixtureScript.base(count: 2))
        #expect(stage.alone == nil && stage.layout.kind == .oneOnOne)
        stage.apply(solo())
        #expect(stage.alone != nil)
        stage.reset()
        #expect(stage.alone == nil)
    }

    @Test func theFacehashSeedIsTheRoomLabel() throws {
        for label in [StageFixtureScript.roomLabel, "lily-zoro-iris", "Design Review"] {
            let alone = try #require(presenter(solo(roomLabel: label)).alone)
            #expect(alone.seed == label && alone.roomLabel == label)
            #expect(ConclaveAvatarIdentity.fromSeed(alone.seed) == ConclaveAvatarIdentity.fromSeed(label))
        }
        #expect(StageAlonePolicy.avatarDiameter == 72)
        let ios = stageNormalized(try stageSource(Self.iosFile))
        #expect(ios.contains("ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(alone.seed), size: .lobby, diameter: CGFloat(compact ? StageAlonePolicy.compactAvatarDiameter : StageAlonePolicy.avatarDiameter))"))
        let android = stageNormalized(try stageSource(Self.androidFile))
        #expect(android.contains("remember(alone.seed) { ConclaveAvatarIdentity.fromSeed(alone.seed) }"))
        #expect(android.contains("ConclaveAvatar(identity, StageAlonePolicy.avatarDiameter.dp)"))
    }

    @Test func theCompositionIsLeadingAlignedInTheLowerThirdWithOneStatusLine() throws {
        let ios = stageNormalized(try stageSource(Self.iosFile))
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(ios.contains("AnyLayout(VStackLayout(alignment: .leading, spacing: CGFloat(StageAlonePolicy.avatarSpacing)))"))
        #expect(ios.contains(".frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)"))
        #expect(ios.contains(".padding(.bottom, CGFloat(StageAlonePolicy.bottomPadding(viewport)))"))
        #expect(ios.contains(".padding(.leading, CGFloat(viewport.insetLeading + StageAlonePolicy.edgeInset))"))
        #expect(ios.contains(".font(.title2.weight(.semibold))"))
        #expect(ios.contains("Text(ConclaveStrings.text(\"Waiting for others\"))"))
        #expect(ios.components(separatedBy: "Text(").count - 1 == 2)
        #expect(ios.contains(".accessibilityElement(children: .combine)") && ios.contains(".accessibilityIdentifier(\"stage.alone\")"))
        let android = stageNormalized(try stageSource(Self.androidFile))
        #expect(android.contains("Modifier.align(Alignment.BottomStart)"))
        #expect(android.contains("bottom = StageAlonePolicy.bottomPadding(viewport).dp"))
        #expect(android.contains("start = (viewport.insetLeading + StageAlonePolicy.edgeInset).dp"))
        #expect(android.contains("style = MaterialTheme.typography.titleLarge"))
        #expect(android.contains("conclaveString(\"stg_waiting_for_others\")"))
        #expect(android.components(separatedBy: "ConclaveText(").count - 1 == 2)
        #expect(android.contains(".semantics(mergeDescendants = true) { }") && android.contains(".testTag(\"stage.alone\")"))
        for viewport in [StagePoliciesTests.iphoneSE, StagePoliciesTests.iphone17e, StagePoliciesTests.android360] {
            let bottomEdge = viewport.height - StageAlonePolicy.bottomPadding(viewport)
            let defaultToastTop = viewport.height - viewport.insetBottom - 8.0 - 44.0
            #expect(bottomEdge == defaultToastTop - StageAlonePolicy.edgeInset)
            #expect(bottomEdge > viewport.height * 2.0 / 3.0)
            #expect(bottomEdge - StageAlonePolicy.avatarDiameter - StageAlonePolicy.avatarSpacing > viewport.height / 2.0)
        }
    }

    @Test func theAloneCompositionClearsTheToastLaneAndTheLaneDoesNotRiseForAnUntaggedSoloSlot() throws {
        #expect(StageAlonePolicy.toastClearance == 8 + 44)
        for viewport in [StagePoliciesTests.iphoneSE, StagePoliciesTests.iphone17e, StagePoliciesTests.android360] {
            let stage = presenter(StageFixtureScript.inputs(for: .soloCameraOffAlone), viewport: viewport)
            #expect(stage.alone != nil)
            #expect(stage.noticeGeometry.toastBottom == viewport.insetBottom)
            let toastTop = viewport.height - stage.noticeGeometry.toastBottom - 8.0 - 44.0
            let compositionBottom = viewport.height - StageAlonePolicy.bottomPadding(viewport)
            #expect(compositionBottom + StageAlonePolicy.edgeInset <= toastTop)
            let unconfirmed = presenter(StageFixtureScript.inputs(for: .soloUnconfirmed), viewport: viewport)
            #expect(unconfirmed.alone == nil && unconfirmed.noticeGeometry.toastBottom == viewport.insetBottom)
            let cameraOn = presenter(StageFixtureScript.inputs(for: .soloCameraOn), viewport: viewport)
            #expect(cameraOn.noticeGeometry.toastBottom
                    == viewport.insetBottom + StageViewportPolicy.tileControlGap + StageViewportPolicy.nameTagBand)
        }

        let stage = presenter(StageFixtureScript.inputs(for: .soloCameraOn))
        let raised = stage.noticeGeometry.toastBottom
        stage.apply(StageFixtureScript.inputs(for: .soloCameraOffAlone))
        #expect(stage.noticeGeometry.toastBottom == StagePoliciesTests.iphone17e.insetBottom)
        stage.apply(StageFixtureScript.inputs(for: .soloCameraOn))
        #expect(stage.noticeGeometry.toastBottom == raised)

        let alone = StageFixtureScript.inputs(for: .soloCameraOffAlone)
        let localSlot = StageSlot.participantId(StageFixtureScript.localUserId)
        #expect(StageViewportPolicy.untaggedSoloSlotId(alone, kind: .solo) == localSlot)
        #expect(StageViewportPolicy.untaggedSoloSlotId(StageFixtureScript.inputs(for: .soloUnconfirmed), kind: .solo) == localSlot)
        #expect(StageViewportPolicy.untaggedSoloSlotId(alone, kind: .oneOnOne).isEmpty)
        #expect(StageViewportPolicy.untaggedSoloSlotId(StageFixtureScript.inputs(for: .soloCameraOn), kind: .solo).isEmpty)
        #expect(StageViewportPolicy.untaggedSoloSlotId(StageFixtureScript.inputs(for: .oneOnOneCameraOff), kind: .oneOnOne).isEmpty)

        let viewport = StagePoliciesTests.iphone17e
        let full = StageFrame(slotId: localSlot, x: 0, y: 0, width: viewport.width, height: viewport.height)
        let soloSlot = StageSlot(id: localSlot, role: .spotlightMain, userId: StageFixtureScript.localUserId, fit: .fill)
        #expect(StageViewportPolicy.toastBottom(viewport: viewport, kind: .solo, frames: [full], slots: [soloSlot])
                == viewport.insetBottom + StageViewportPolicy.tileControlGap + StageViewportPolicy.nameTagBand)
        #expect(StageViewportPolicy.toastBottom(viewport: viewport, kind: .solo, frames: [full], slots: [soloSlot],
                                                untaggedSlotId: localSlot) == viewport.insetBottom)

        let presenterSource = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StagePresenter.swift"))
        #expect(presenterSource.contains("let untagged = StageViewportPolicy.untaggedSoloSlotId(inputs, kind: layout.kind)"))
        #expect(presenterSource.contains("frames: frames, slots: layout.slots, untaggedSlotId: untagged)"))
        let tile = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/SlotView+iOS.swift"))
        #expect(tile.contains("isSolo: stage.kind == .solo && model.isLocal && !isShare,"))
        let chrome = stageNormalized(try stageSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveTileChrome+iOS.swift"))
        #expect(chrome.contains("showsName: !isSolo || !model.isCameraOff,"))
        let androidTile = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/SlotView.kt"))
        #expect(androidTile.contains("isSolo = kind == StageKind.solo && model.isLocal && !isShare,"))
        let androidChrome = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/components/ConclaveTileChrome.kt"))
        #expect(androidChrome.contains("TileOverlays(model, variant, density, !isSolo || !model.isCameraOff, showsHandBadge, selfViewAccessory)"))
        let lanes = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/NoticeLanes+iOS.swift"))
        #expect(lanes.contains("static let toastGap: CGFloat = 8"))
        let androidLanes = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/NoticeLanes.kt"))
        #expect(androidLanes.contains("const val TOAST_GAP_DP = 8"))
        let toast = stageNormalized(try stageSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveToast+iOS.swift"))
        #expect(toast.contains("static let pillHeight: CGFloat = 44"))
        let androidToast = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/components/ConclaveToastHost.kt"))
        #expect(androidToast.contains("const val MIN_HEIGHT_DP = 44"))
    }

    @Test func theAloneCompositionStaysBetweenTheChipRowAndTheToastLaneAndTurnsCompactWhenTheBandIsShort() throws {
        #expect(StageAlonePolicy.compactAvatarDiameter == 40 && StageAlonePolicy.maxTitleLines == 2)
        #expect(StageAlonePolicy.titleLineHeight == 28 && StageAlonePolicy.statusLineHeight == 20)

        let handState = StageFixtureState.soloCameraOffAloneHand
        #expect(handState.rawValue == "solo-cameraOff-alone-hand" && StageFixtureScript.state(named: handState.rawValue) == handState)
        #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: handState.rawValue, people: nil, premeeting: nil))
        let hand = presenter(StageFixtureScript.inputs(for: handState))
        #expect(hand.alone != nil && hand.chipRowVisible)
        #expect(StageFixtureSession(state: handState).stage.chipRowVisible)
        for frame in hand.currentFrames() {
            #expect(frame.x == 0 && frame.y == 0 && frame.height == StagePoliciesTests.iphone17e.height)
        }

        let androidHand = StageViewport(width: 891, height: 411, insetTop: 24 + 60 + 56, insetBottom: 24 + 76, insetLeading: 0,
                                        insetTrailing: 0, widthClass: StageSizeClass.expanded, heightClass: StageSizeClass.compact,
                                        placement: .bottomBar)
        #expect(StageAlonePolicy.topPadding(androidHand) == androidHand.insetTop)
        #expect(StageAlonePolicy.bottomPadding(androidHand) == 176 && StageAlonePolicy.bandHeight(androidHand) == 95)
        #expect(StageAlonePolicy.usesCompactLayout(androidHand, titleLine: 28, statusLine: 20))
        #expect(StageAlonePolicy.titleLineLimit(androidHand, titleLine: 28, statusLine: 20) == 2)
        #expect(StageAlonePolicy.compositionHeight(compact: true, titleLines: 2, titleLine: 28, statusLine: 20) == 80)
        #expect(StageAlonePolicy.compositionHeight(compact: false, titleLines: 1, titleLine: 28, statusLine: 20) == 136)
        #expect(StageAlonePolicy.usesCompactLayout(androidHand, titleLine: 28 * 1.3, statusLine: 20 * 1.3))
        #expect(StageAlonePolicy.titleLineLimit(androidHand, titleLine: 28 * 1.3, statusLine: 20 * 1.3) == 1)

        let androidBare = StageViewport(width: 891, height: 411, insetTop: 24 + 60, insetBottom: 24 + 76, insetLeading: 0,
                                        insetTrailing: 0, widthClass: StageSizeClass.expanded, heightClass: StageSizeClass.compact,
                                        placement: .bottomBar)
        #expect(!StageAlonePolicy.usesCompactLayout(androidBare, titleLine: 28, statusLine: 20))
        #expect(StageAlonePolicy.titleLineLimit(androidBare, titleLine: 28, statusLine: 20) == 1)

        let iosHand = StageViewportPolicy.iOS(contentWidth: 750, contentHeight: 369,
                                              safeArea: StageChromeInsets(top: 0, bottom: 21, leading: 47, trailing: 47),
                                              regularWidth: false, compactHeight: true, topReserve: 56, barReserve: 64,
                                              trailingReserve: 64, chipRowReserve: StageViewportPolicy.iosChipRowReserve)
        #expect(iosHand.height == 390 && iosHand.insetTop == 108 && StageAlonePolicy.bandHeight(iosHand) == 173)
        #expect(!StageAlonePolicy.usesCompactLayout(iosHand, titleLine: 28, statusLine: 20))
        #expect(StageAlonePolicy.titleLineLimit(iosHand, titleLine: 28, statusLine: 20) == 2)
        let ax2Title = 28.0 * 39.0 / 22.0
        let ax2Status = 20.0 * 30.0 / 15.0
        #expect(StageAlonePolicy.usesCompactLayout(iosHand, titleLine: ax2Title, statusLine: ax2Status))
        #expect(StageAlonePolicy.titleLineLimit(iosHand, titleLine: ax2Title, statusLine: ax2Status) == 2)

        let iosPortraitHand = StageViewportPolicy.iOS(contentWidth: 390, contentHeight: 763,
                                                      safeArea: StageChromeInsets(top: 47, bottom: 34, leading: 0, trailing: 0),
                                                      regularWidth: false, compactHeight: false, topReserve: 56, barReserve: 64,
                                                      trailingReserve: 64, chipRowReserve: StageViewportPolicy.iosChipRowReserve)
        let portraits = [iosPortraitHand, StagePoliciesTests.iphoneSE, StagePoliciesTests.iphone17e, StagePoliciesTests.android360]
        for viewport in portraits {
            for (title, status) in [(28.0, 20.0), (ax2Title, ax2Status), (56.0, 40.0)] {
                #expect(!StageAlonePolicy.usesCompactLayout(viewport, titleLine: title, statusLine: status), "\(viewport.height)")
                #expect(StageAlonePolicy.titleLineLimit(viewport, titleLine: title, statusLine: status) == 2, "\(viewport.height)")
            }
        }

        let scales: [(Double, Double)] = [(28, 20), (28 * 1.3, 20 * 1.3), (28 * 34 / 22, 20 * 25 / 15), (ax2Title, ax2Status),
                                          (37.3, 34), (56, 40)]
        for viewport in portraits + [androidHand, androidBare, iosHand] {
            let band = StageAlonePolicy.bandHeight(viewport)
            for (title, status) in scales {
                let compact = StageAlonePolicy.usesCompactLayout(viewport, titleLine: title, statusLine: status)
                let lines = StageAlonePolicy.titleLineLimit(viewport, titleLine: title, statusLine: status)
                let height = StageAlonePolicy.compositionHeight(compact: compact, titleLines: lines, titleLine: title, statusLine: status)
                #expect(lines == 1 || lines == 2)
                if !compact {
                    #expect(StageAlonePolicy.compositionHeight(compact: false, titleLines: 1, titleLine: title, statusLine: status) <= band)
                }
                if StageAlonePolicy.compositionHeight(compact: true, titleLines: 1, titleLine: title, statusLine: status) <= band {
                    #expect(height <= band, "\(viewport.height) \(title)")
                    let top = viewport.height - StageAlonePolicy.bottomPadding(viewport) - height
                    #expect(top >= StageAlonePolicy.topPadding(viewport), "\(viewport.height) \(title)")
                }
            }
        }
        #expect(StageAlonePolicy.usesCompactLayout(androidHand, titleLine: 56, statusLine: 40))
        #expect(StageAlonePolicy.titleLineLimit(androidHand, titleLine: 56, statusLine: 40) == 1)

        let ios = stageNormalized(try stageSource(Self.iosFile))
        let reader = try #require(ios.range(of: "private struct StageAloneComposition: View {"))
        let cap = try #require(ios.range(of: "StageAloneComposition(alone: alone, viewport: viewport) .dynamicTypeSize(...DynamicTypeSize.accessibility2)"))
        let metric = try #require(ios.range(of: "@ScaledMetric(relativeTo: .title2) private var titleLine = StageAlonePolicy.titleLineHeight"))
        #expect(cap.upperBound < reader.lowerBound && reader.upperBound < metric.lowerBound)
        #expect(ios.contains("@ScaledMetric(relativeTo: .subheadline) private var statusLine = StageAlonePolicy.statusLineHeight"))
        #expect(ios.contains("let compact = StageAlonePolicy.usesCompactLayout(viewport, titleLine: titleLine, statusLine: statusLine)"))
        #expect(ios.contains("let titleLines = StageAlonePolicy.titleLineLimit(viewport, titleLine: titleLine, statusLine: statusLine)"))
        #expect(ios.contains("AnyLayout(HStackLayout(alignment: .center, spacing: CGFloat(StageAlonePolicy.avatarSpacing)))"))
        #expect(ios.contains(".padding(.top, CGFloat(StageAlonePolicy.topPadding(viewport)))"))
        #expect(ios.contains(".lineLimit(titleLines)") && ios.contains(".lineLimit(1)"))
        #expect(ios.components(separatedBy: "dynamicTypeSize(").count - 1 == 1)

        let android = stageNormalized(try stageSource(Self.androidFile))
        #expect(android.contains("val titleLine = with(density) { StageAlonePolicy.titleLineHeight.sp.toDp().value.toDouble() }"))
        #expect(android.contains("val statusLine = with(density) { StageAlonePolicy.statusLineHeight.sp.toDp().value.toDouble() }"))
        #expect(android.contains("val compact = StageAlonePolicy.usesCompactLayout(viewport, titleLine = titleLine, statusLine = statusLine)"))
        #expect(android.contains("val titleLines = StageAlonePolicy.titleLineLimit(viewport, titleLine = titleLine, statusLine = statusLine)"))
        #expect(android.contains("top = StageAlonePolicy.topPadding(viewport).dp,"))
        #expect(android.contains("Row(placement, horizontalArrangement = Arrangement.spacedBy(StageAlonePolicy.avatarSpacing.dp), verticalAlignment = Alignment.CenterVertically)"))
        #expect(android.contains("ConclaveAvatar(identity, StageAlonePolicy.compactAvatarDiameter.dp)"))
        #expect(android.contains("Column(placement, verticalArrangement = Arrangement.spacedBy(StageAlonePolicy.avatarSpacing.dp))"))
        #expect(android.contains("maxLines = titleLines, overflow = TextOverflow.Ellipsis"))
        #expect(android.contains("color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis"))
    }

    @Test func theAloneFilesAreStaticAndOfferNoShareOrCopy() throws {
        let forbidden = ["animat", "transition", "crossfade", "timeline", "repeatforever", "keyframe", "phaseanimator", "timer",
                         "launchedeffect", "withframenanos", "infinite", "task(", "task {", "onappear", "sleep", "delay(",
                         "graphicslayer", "share", "copy", "pasteboard", "clipboard", "intent", "invite", "link", "button",
                         "onclick", "clickable", "ontapgesture", "gradient", "meetingviewmodel", "surface(", "background("]
        for file in [Self.iosFile, Self.androidFile] {
            let text = try stageSource(file).lowercased()
            for word in forbidden {
                #expect(!text.contains(word), "\(file) uses \(word)")
            }
        }
        let labels = Mirror(reflecting: StageAloneSnapshot(slotId: "p:you", roomLabel: "abc", seed: "abc")).children.compactMap { $0.label }
        #expect(labels == ["slotId", "roomLabel", "seed"])
    }

    @Test func bothCanvasesSwapOnlyTheLocalSoloSlotForTheComposition() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageCanvas+iOS.swift"))
        #expect(ios.contains("if let alone = stage.alone, alone.slotId == slot.id { StageAloneIdentity(alone: alone, viewport: viewport) } else { SlotView("))
        #expect(ios.contains("StageCanvasSlot(slot: slot, stage: stage, viewport: viewport, renderers: renderers,"))
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/StageCanvas.kt"))
        #expect(android.contains("if (alone != null && alone.slotId == slot.id && !inPip) { StageAloneIdentity(alone, viewport, modifier) } else { SlotView("))
        #expect(android.contains("StageCanvasSlot(slot, stage, renderers, snapshot.overflowCount, seeds, viewport, inPip, Modifier.layoutId(slot.id))"))
        let tile = try stageSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveTileChrome+iOS.swift")
        #expect(tile.contains("private struct SoloCameraOffIdentity: View {"))
    }

    @Test func theChipRowIsReservedWheneverAStatusChipShows() throws {
        #expect(!presenter(StageFixtureScript.inputs(for: .grid4)).chipRowVisible)
        #expect(presenter(StageFixtureScript.inputs(for: .handRaised)).chipRowVisible)
        #expect(presenter(StageFixtureScript.inputs(for: .handRaising)).chipRowVisible)
        #expect(!presenter(StageFixtureScript.inputs(for: .soloCameraOn)).chipRowVisible)
        #expect(!presenter(StageFixtureScript.inputs(for: .soloCameraOffAlone)).chipRowVisible)
        let playing = presenter(StageFixtureScript.inputs(for: .nowPlaying))
        #expect(!playing.chipRowVisible)
        playing.setShowsVideoOverActivity(true)
        #expect(playing.chipRowVisible)
        let hand = presenter(StageFixtureScript.inputs(for: .handRaised))
        hand.apply(StageFixtureScript.inputs(for: .grid4))
        #expect(!hand.chipRowVisible)
        hand.apply(StageFixtureScript.inputs(for: .handRaised))
        #expect(hand.chipRowVisible && hand.noticeGeometry.chipsVisible)
        hand.reset()
        #expect(!hand.chipRowVisible)

        #expect(StageViewportPolicy.iosChipRowReserve == 8 + 44)
        #expect(StageViewportPolicy.androidChipRowReserve == 8 + 48)
        let canvas = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageCanvas+iOS.swift"))
        #expect(canvas.contains("chipRowReserve: stage.chipRowVisible ? Double(StageCanvasMetrics.chipRowReserve) : 0"))
        #expect(canvas.contains("static let chipRowReserve: CGFloat = CGFloat(StageViewportPolicy.iosChipRowReserve)"))
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/StageCanvas.kt"))
        #expect(android.contains("chipRow = if (stage.chipRowVisible) StageViewportPolicy.androidChipRowReserve else 0.0,"))
        #expect(android.contains("insetTop = top + StageCanvasMetrics.TOP_RESERVE_DP + chipRow,"))
        let lanes = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/NoticeLanes+iOS.swift"))
        #expect(lanes.contains("let top = CGFloat(stage.noticeGeometry.bannerTop)") && !lanes.contains("chipRow"))
        let androidLanes = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/NoticeLanes.kt"))
        #expect(androidLanes.contains("Modifier.padding(top = geometry.bannerTop.dp)") && !androidLanes.contains("CHIP_ROW"))
    }

    @Test func theReservedChipRowKeepsEveryTileBelowTheChipInPortraitAndLandscape() {
        let portrait = StageChromeInsets(top: 47, bottom: 34, leading: 0, trailing: 0)
        let landscape = StageChromeInsets(top: 0, bottom: 21, leading: 59, trailing: 61)
        for compact in [false, true] {
            let safe = compact ? landscape : portrait
            let width = compact ? 724.0 : 390.0
            let height = compact ? 354.0 : 844.0 - 81.0
            let bare = StageViewportPolicy.iOS(contentWidth: width, contentHeight: height, safeArea: safe, regularWidth: false,
                                               compactHeight: compact, topReserve: 56, barReserve: 64, trailingReserve: 64)
            let reserved = StageViewportPolicy.iOS(contentWidth: width, contentHeight: height, safeArea: safe, regularWidth: false,
                                                   compactHeight: compact, topReserve: 56, barReserve: 64, trailingReserve: 64,
                                                   chipRowReserve: StageViewportPolicy.iosChipRowReserve)
            #expect(reserved.insetTop == bare.insetTop + 52)
            #expect(reserved.insetBottom == bare.insetBottom && reserved.width == bare.width && reserved.height == bare.height)
            #expect(reserved.insetTrailing == bare.insetTrailing && reserved.placement == bare.placement)
            let chipBottom = safe.top + 12 + 44 + 8 + 44
            #expect(StageLayoutPolicy.contentFrame(bare).y < chipBottom)
            #expect(StageLayoutPolicy.contentFrame(reserved).y >= chipBottom)
            let stage = presenter(StageFixtureScript.inputs(for: .handRaised), viewport: reserved)
            #expect(stage.chipRowVisible)
            for frame in stage.currentFrames() {
                #expect(frame.y >= chipBottom, "\(compact ? "landscape" : "portrait") \(frame.slotId)")
            }
        }
    }

    @Test func theToastLaneSitsAboveTheControlBarAndClearsTileNameTags() throws {
        let tagReach = 8.0 + 31.0
        let cases: [(StageFixtureState, StageViewport, Bool)] = [
            (.grid4, StagePoliciesTests.iphoneSE, true), (.grid6, StagePoliciesTests.iphone17e, true),
            (.soloCameraOn, StagePoliciesTests.iphone17e, true), (.oneOnOne, StagePoliciesTests.iphone17e, true),
            (.grid4, StagePoliciesTests.android360, true), (.grid6, StagePoliciesTests.ipadPortrait, false),
        ]
        for (state, viewport, raised) in cases {
            let stage = presenter(StageFixtureScript.inputs(for: state), viewport: viewport)
            let geometry = stage.noticeGeometry
            #expect((geometry.toastBottom > viewport.insetBottom) == raised, "\(state.rawValue)")
            #expect(geometry.toastBottom >= viewport.insetBottom, "\(state.rawValue)")
            let toastEdge = viewport.height - geometry.toastBottom - 8.0
            let frames = stage.currentFrames()
            for slot in stage.layout.slots where StageViewportPolicy.carriesNameTag(slot.role) {
                guard let frame = StageLayoutPolicy.find(slot.id, in: frames) else { continue }
                let insets = StageViewportPolicy.tileInsets(kind: stage.layout.kind, role: slot.role, viewport: viewport)
                let visibleBottom = frame.maxY - insets.bottom
                if visibleBottom <= viewport.height - viewport.insetBottom - StageViewportPolicy.toastReach { continue }
                #expect(toastEdge <= visibleBottom - tagReach, "\(state.rawValue) \(slot.id)")
            }
        }

        let viewport = StagePoliciesTests.iphone17e
        let floor = viewport.height - viewport.insetBottom
        let high = StageFrame(slotId: "p:a", x: 8, y: 200, width: 180, height: floor - StageViewportPolicy.toastReach - 200)
        #expect(StageViewportPolicy.toastBottom(viewport: viewport, kind: .grid, frames: [high],
                                                slots: [StageSlot(id: "p:a", role: .grid, userId: "a", fit: .fill)]) == viewport.insetBottom)
        let floating = StageFrame(slotId: "p:you", x: 250, y: floor - 160, width: 120, height: 150)
        #expect(StageViewportPolicy.toastBottom(viewport: viewport, kind: .oneOnOne, frames: [floating],
                                                slots: [StageSlot(id: "p:you", role: .selfFloating, userId: "you", fit: .fill)])
                == viewport.insetBottom)
        #expect(!StageViewportPolicy.carriesNameTag(.overflow) && !StageViewportPolicy.carriesNameTag(.activity))
        #expect(!StageViewportPolicy.carriesNameTag(.selfMinimized) && StageViewportPolicy.carriesNameTag(.rail))

        let lanes = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/NoticeLanes+iOS.swift"))
        #expect(lanes.contains(".padding(.bottom, CGFloat(geometry.toastBottom) + NoticeLaneMetrics.toastGap)"))
        let androidLanes = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/NoticeLanes.kt"))
        #expect(androidLanes.contains("bottom = (geometry.toastBottom + NoticeLaneDefaults.TOAST_GAP_DP).dp"))
    }

    @Test func stageToastsAreCompactPillsThatStayInert() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveToast+iOS.swift"))
        #expect(ios.contains("RoundedRectangle(cornerRadius: stacked ? ConclaveToastMetrics.radius : ConclaveToastMetrics.pillRadius, style: .continuous)"))
        #expect(ios.contains(".frame(minHeight: ConclaveToastMetrics.pillHeight)"))
        #expect(ios.contains("static let pillRadius: CGFloat = 22") && ios.contains("static let pillHeight: CGFloat = 44"))
        #expect(ios.contains(".background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)"))
        #expect(ios.contains(".overlay { shape.strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }"))
        for word in ["Material", "Timer", "LaunchedEffect", "infinite", "repeatForever", "Gradient", "gradient"] {
            #expect(!ios.contains(word), "the iOS toast uses \(word)")
        }
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/components/ConclaveToastHost.kt"))
        #expect(android.contains("shape = if (stackAction) RoundedCornerShape(ConclaveStageToastMetrics.STACKED_RADIUS_DP.dp) else RoundedCornerShape(50),"))
        #expect(android.contains("heightIn(min = ConclaveStageToastMetrics.MIN_HEIGHT_DP.dp)"))
        #expect(android.contains("const val MIN_HEIGHT_DP = 44"))
        #expect(android.contains("Column(Modifier.padding(start = start, top = 10.dp, end = end, bottom = if (hasAction) 4.dp else 10.dp),"))
        #expect(!android.contains("top = 10.dp, end = end, bottom = 4.dp)"))
        #expect(android.components(separatedBy: "LaunchedEffect(").count - 1 == 1)
        #expect(!android.contains("Modifier.border("))
    }

    @Test func theAloneFixtureStateReachesBothRootsAndTheOverlayStaysOutsideTheStage() throws {
        #expect(StageFixtureState.soloCameraOffAlone.rawValue == "solo-cameraOff-alone")
        #expect(StageFixtureScript.state(named: "solo-cameraOff-alone") == .soloCameraOffAlone)
        #expect(NativeFixtureLaunch.iOSSelector(system: nil, stage: "solo-cameraOff-alone", people: nil, premeeting: nil))
        let session = StageFixtureSession(state: .soloCameraOffAlone)
        #expect(session.shell.session.phase == MeetingPhaseKind.inCall)
        #expect(session.stage.alone?.seed == StageFixtureScript.roomLabel)

        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageFixtureView+iOS.swift"))
        #expect(ios.contains("environment[\"CONCLAVE_STAGE_FIXTURE\"]") && ios.contains("StageFixtureScript.state(named: raw)"))
        let root = try #require(ios.range(of: "CallRoot(shell: session.shell, stage: session.stage,"))
        let overlay = try #require(ios.range(of: ".overlay(alignment: .leading) { StageFixtureControls(session: session) }"))
        #expect(root.upperBound < overlay.lowerBound)
        #expect(ios.contains(".frame(maxHeight: 360)") && ios.contains(".padding([.leading, .vertical], 8)"))

        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/StageFixtureRoot.kt"))
        #expect(android.contains("val state = StageFixtureScript.state(named = stateName) ?: StageFixtureState.grid6"))
        let call = try #require(android.range(of: "CallRoot( shell = session.shell,"))
        let controls = try #require(android.range(of: "HostingTheme(inCall = true) { StageFixtureControls(session, Modifier.align(Alignment.CenterStart)) }"))
        #expect(call.upperBound < controls.lowerBound)
    }
}
#endif
