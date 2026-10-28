#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// FND-3, foundation pack 3 (OUT/PLAN-screens.md section 5): the content panel components. The composer (F00 C19,
/// S40 6, R40-6, R40-10; RECONCILE R32; owner OQ2) with the second sanctioned glass file, search (C20), the segmented
/// control and its fallbacks (C21, S60 R6-8), the chat bubble (C23 = S40 CL1), the reaction chip (C24 = S40 CL2), the
/// one-time tip (C25, RECONCILE R39), the short text-entry dialog (S50 PL10), the semantics exporter additions (S40
/// R40-11) and the game board tokens (S60 R6-7, F00 2.6 A9). iOS-only and Kotlin sources are not compiled by this
/// macOS host, so their rules are read from the sources; the Kotlin half runs in T/Skip/FND3ContentComponentsBridgeTests.kt.
struct FND3ContentComponentsTests {
    // MARK: Composer material (F00 4, C19; owner OQ2)

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
        // F00 C19 l: Chat shows two glass shapes (attach circle, field container); Ask and Q&A have no attach control.
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
        // S40 6 f: visible from 90% (900 of 1,000; 450 of 500), always in voice mode; never for an uncapped field.
        #expect(ConclaveComposerCounterPolicy.visibleFrom(limit: 1000) == 900)
        #expect(ConclaveComposerCounterPolicy.visibleFrom(limit: 500) == 450)
        #expect(ConclaveComposerCounterPolicy.visibleFrom(limit: 0) == 0)
        #expect(!ConclaveComposerCounterPolicy.isVisible(count: 899, limit: 1000, alwaysVisible: false))
        #expect(ConclaveComposerCounterPolicy.isVisible(count: 900, limit: 1000, alwaysVisible: false))
        #expect(ConclaveComposerCounterPolicy.isVisible(count: 0, limit: 500, alwaysVisible: true))
        #expect(!ConclaveComposerCounterPolicy.isVisible(count: 10, limit: 0, alwaysVisible: true))
        #expect(ConclaveComposerCounterPolicy.overflow(count: 1200, limit: 1000) == 200)
        #expect(ConclaveComposerCounterPolicy.overflow(count: 1000, limit: 1000) == 0)
        // CH6: Send waits for a ready photo; progress shows while preparing or uploading; only a failure retries.
        for phase in ConclaveAttachmentPhase.allCases {
            #expect(phase.blocksSend == (phase != .ready))
            #expect(phase.showsProgress == (phase == .preparing || phase == .uploading))
            #expect(phase.offersRetry == (phase == .failed))
        }
    }

    /// F00 4 "Single entry" and C19 c: inside the composer file every glass call sits in the one branch, regular only,
    /// in one container; the field container is never interactive; the opaque branch is the R32 field.
    @Test func composerGlassStaysInsideItsBranch() throws {
        let text = try fnd3Source(Self.composerGlassFile)
        #expect(text.hasPrefix("#if os(iOS) && !SKIP\n"))
        let code = fnd3WithoutComments(text)
        let branches = fnd3BracedBlocks(after: Self.composerBranchCondition, in: code)
        #expect(branches.count == 1)
        guard let branch = branches.first else { return }
        let inside = String(code[branch])
        var outside = code
        outside.removeSubrange(branch)
        for pattern in ["glassEffect", "GlassEffectContainer", "GlassStyle", "glassProminent"] {
            #expect(!outside.contains(pattern), "\(pattern) outside the iOS 26 branch")
        }
        let flat = fnd3Normalized(inside)
        #expect(inside.components(separatedBy: "GlassEffectContainer(").count - 1 == 1)
        #expect(flat.contains("GlassEffectContainer(spacing: CGFloat(ConclaveComposerMetrics.clusterSpacing))"))
        #expect(inside.components(separatedBy: ".glassEffect(").count - 1 == 2)
        #expect(flat.contains(".glassEffect(.regular.interactive(), in: .circle)"))
        #expect(flat.contains(".glassEffect(.regular, in: RoundedRectangle(cornerRadius: CGFloat(ConclaveComposerMetrics.glassCornerRadius), style: .continuous))"))
        // The field container is regular and never interactive: exactly one interactive glass call, on the circle.
        #expect(inside.components(separatedBy: ".interactive(").count - 1 == 1)
        let materials = ["ultraThinMaterial", "thinMaterial", "regularMaterial", "thickMaterial", "ultraThickMaterial", "barMaterial"]
        for pattern in [".clear", "Glass.tint", ".tint(", "glassProminent", "symbolColorRenderingMode(.gradient"] + materials {
            #expect(!code.contains(pattern), "the composer uses \(pattern)")
        }
        #expect(!code.contains("#available(iOS 26.0, *) &&"))
        // Increase Contrast strokes both glass shapes; the opaque branch is the system background with a separator border.
        #expect(inside.components(separatedBy: "ConclaveComposerContrastStroke(").count - 1 == 2)
        #expect(fnd3Normalized(code).contains("if isIncreased { shape.strokeBorder(Color(uiColor: .separator), lineWidth: 1) }"))
        let opaque = fnd3Normalized(outside)
        #expect(opaque.contains(".background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: CGFloat(ConclaveComposerMetrics.opaqueCornerRadius), style: .continuous))"))
        #expect(opaque.contains(".strokeBorder(Color(uiColor: .separator), lineWidth: 1)"))
        // Send sits inside the field container in both branches; the container is one 44 pt row. T3 borrow P5 (a
        // recorded C19 c deviation): the 12 by 8 padding wraps the field only and Send is never padded, so a single
        // line is centred in 44 pt and Send stays on the last line as the text grows (T3BorrowComposerComponentTests).
        #expect(fnd3Normalized(code).contains("HStack(alignment: .bottom, spacing: 0) { field .padding(.vertical, CGFloat(ConclaveComposerMetrics.fieldVerticalPadding)) .frame(maxWidth: .infinity, minHeight: CGFloat(ConclaveComposerMetrics.minimumFieldHeight), alignment: .leading) .padding(.leading, CGFloat(ConclaveComposerMetrics.fieldHorizontalPadding)) .padding(.trailing, CGFloat(ConclaveComposerMetrics.fieldTrailingGap)) send } .frame(minHeight: CGFloat(ConclaveComposerMetrics.minimumFieldHeight))"))
        #expect(code.components(separatedBy: "fieldContainer").count - 1 >= 3)
        // iOS 27 reduced resource usage selects the opaque field; the Debug force is read Debug-only.
        #expect(code.contains("@Environment(\\.systemPrefersReducedResourceUsage) private var prefersReducedResourceUsage"))
        #expect(code.contains("if #available(iOS 27.0, *) {"))
        #expect(code.contains("@available(iOS 27.0, *)"))
        #expect(code.contains("@Environment(\\.accessibilityReduceTransparency) private var reduceTransparency"))
        #expect(code.contains("@Environment(\\.conclaveForceOpaqueControls) private var forceOpaqueSetting"))
        // The parts around the field row are never glass.
        for file in ["Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift",
                     "Sources/Conclave/DesignSystem/iOS/Components/ConclaveChatBubble+iOS.swift",
                     "Sources/Conclave/DesignSystem/iOS/Components/ConclaveReactionChip+iOS.swift",
                     "Sources/Conclave/DesignSystem/iOS/Components/ConclaveTip+iOS.swift"] {
            let other = try fnd3Source(file)
            for pattern in ["glassEffect", "GlassEffectContainer", "glassProminent"] + materials {
                #expect(!other.contains(pattern), "\(file) uses \(pattern)")
            }
        }
    }

    @Test func composerBarsAndPartsKeepThePlatformInsets() throws {
        let ios = fnd3Normalized(try fnd3Source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift"))
        #expect(ios.contains("if #available(iOS 26.0, *) { content.safeAreaBar(edge: .bottom) { bar } } else { content.safeAreaInset(edge: .bottom, spacing: 0) { VStack(spacing: 0) { Divider() bar } .background(Color(uiColor: .systemBackground)) } }"))
        #expect(ios.contains("if #available(iOS 26.0, *) { content.safeAreaBar(edge: .top) { bar } } else { content.safeAreaInset(edge: .top, spacing: 0) {"))
        #expect(ios.contains("struct ConclaveComposerStack<Accessories: View, FieldRow: View, Footer: View>: View {"))
        #expect(ios.contains("VStack(alignment: .leading, spacing: CGFloat(ConclaveComposerMetrics.stackSpacing)) { accessories fieldRow footer"))
        #expect(ios.contains(".fill(HostingTheme.coralText) .frame(width: CGFloat(ConclaveComposerMetrics.replyBarWidth))"))
        // Send keeps its pinned FND-1 label; the labelled variant names the screen's action and the disabled reason.
        #expect(ios.contains(".accessibilityLabel(ConclaveStrings.text(\"Send\"))"))
        #expect(ios.contains(".accessibilityLabel(title) .accessibilityValue(isEnabled ? \"\" : disabledReason)"))
        #expect(!ios.contains(".tint("), "segments keep the system thumb, Send keeps its glyph color")
        let android = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/components/ConclaveFields.kt"))
        #expect(android.contains("shape = RoundedCornerShape(ConclaveComposerMetrics.androidCornerRadius.dp),"))
        #expect(android.contains("focusedContainerColor = scheme.surfaceContainerHighest,"))
        #expect(android.contains("focusedIndicatorColor = Color.Transparent,"))
        #expect(android.contains("scheme.onSurface.copy(alpha = ConclaveDisabledOpacity.android.toFloat())"))
        #expect(android.contains("Icon(ConclaveIcons.SendFill1, contentDescription = sendLabel, tint = tint)"))
        #expect(android.contains("liveRegion = LiveRegionMode.Polite"))
        #expect(!android.contains("primaryContainer"), "no coral in fields, search or segments")
    }

    // MARK: Search (F00 C20)

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
        let ios = fnd3Normalized(try fnd3Source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift"))
        #expect(ios.contains("searchable(text: text, placement: .navigationBarDrawer(displayMode: .automatic), prompt: Text(prompt ?? ConclaveStrings.text(\"Search\")))"))
        #expect(ios.contains("content.task(id: ConclaveSearchAnnouncementKey(query: query, resultCount: resultCount)) {"))
        #expect(ios.contains("text.accessibilitySpeechAnnouncementPriority = .low"))
        #expect(ios.contains("ContentUnavailableView.search(text: query)"))
        let android = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/components/ConclaveFields.kt"))
        #expect(android.contains("leadingIcon = { Icon(ConclaveIcons.SearchFill0, contentDescription = null) },"))
        #expect(android.contains("Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString(\"ds_clear_search\"))"))
        #expect(android.contains("shape = CircleShape, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),"))
        #expect(android.contains("conclavePlural(\"ds_result_count\", resultCount, resultCount)"))
        for word in ["SearchBar(", "DockedSearchBar", "ExpandedFullScreenSearchBar"] { #expect(!android.contains(word), "\(word)") }
    }

    // MARK: Segmented control (F00 C21; S60 R6-8)

    @Test func segmentedControlFallsBackWithoutClipping() throws {
        #expect(!ConclaveSegmentedPolicy.iosUsesRows(isAccessibilitySize: false, segmentCount: 3))
        #expect(ConclaveSegmentedPolicy.iosUsesRows(isAccessibilitySize: true, segmentCount: 3))
        #expect(ConclaveSegmentedPolicy.iosUsesRows(isAccessibilitySize: false, segmentCount: 5))
        #expect(!ConclaveSegmentedPolicy.androidUsesFallback(fontScale: 1.49, segmentCount: 3))
        #expect(ConclaveSegmentedPolicy.androidUsesFallback(fontScale: 1.5, segmentCount: 3))
        #expect(ConclaveSegmentedPolicy.androidUsesFallback(fontScale: 1.0, segmentCount: 5))
        #expect(ConclaveSegmentedFallback.allCases.map { $0.rawValue } == ["rows", "menu"])
        let ios = fnd3Normalized(try fnd3Source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift"))
        #expect(ios.contains(".pickerStyle(.segmented) .labelsHidden()"))
        #expect(ios.contains("ViewThatFits(in: .horizontal) { segmented menu }"))
        #expect(ios.contains(".pickerStyle(.menu)"))
        #expect(ios.contains("ConclaveSelectableRow(title: option.title, isSelected: option.id == selection,"))
        #expect(ios.contains("ConclaveSegmentedPicker(title, options: options, selection: $selection, fallback: .menu, identifier: identifier)"))
        let android = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/components/ConclaveFields.kt"))
        #expect(android.contains("SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth().testTag(identifier)) {"))
        #expect(android.contains("shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),"))
        #expect(android.contains("onGesture(FeedbackKind.selectionChanged, haptics.gesture(FeedbackKind.selectionChanged))"))
        #expect(android.contains("val fontScale = LocalDensity.current.fontScale"))
        #expect(android.contains("ConclaveSelectableRows(options.map { ConclaveSelectableOption(it.id, it.title) }"))
        #expect(android.contains("PrimaryTabRow(selectedTabIndex = index"))
        #expect(!android.contains("FilterChip"))
    }

    // MARK: Chat bubble (F00 C23 = S40 CL1)

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
        // The own bubble's ink on coral (F00 2.6 A10, S40 3 e): 6.374, 6.764 under Increase Contrast; Android the same.
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.iosAppOnCoral, background: DesignTokens.iosAppCoralFill) - 6.374) < 0.001)
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.iosAppOnCoralHighContrast, background: DesignTokens.iosAppCoralFill) - 6.764) < 0.001)
        #expect(DesignTokens.androidLightPrimaryContainer == DesignTokens.coral && DesignTokens.androidDarkPrimaryContainer == DesignTokens.coral)
        let ios = fnd3Normalized(try fnd3Source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveChatBubble+iOS.swift"))
        #expect(ios.contains("let shape = RoundedRectangle(cornerRadius: CGFloat(ConclaveBubbleGeometry.iosCornerRadius), style: .continuous)"))
        #expect(ios.contains("tone.usesCoralFill ? HostingTheme.coralFill : Color(uiColor: .secondarySystemBackground)"))
        #expect(ios.contains("tone.usesCoralFill ? HostingTheme.onCoral : Color.primary"))
        #expect(ios.contains("if tone.hasBorder { shape.strokeBorder(Color(uiColor: .separator), lineWidth: 1) }"))
        #expect(ios.contains("tone.usesCoralFill ? HostingTheme.onCoral : HostingTheme.coralText"), "never coralText on coral")
        let android = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/components/ConclaveChatBubble.kt"))
        #expect(android.contains("ConclaveBubbleTone.own -> scheme.primaryContainer"))
        #expect(android.contains("ConclaveBubbleTone.own -> scheme.onPrimaryContainer"))
        #expect(android.contains("border = if (tone.hasBorder) BorderStroke(1.dp, scheme.outlineVariant) else null,"))
        #expect(android.contains("tonalElevation = 0.dp, shadowElevation = 0.dp,"))
        #expect(android.contains("ConclaveBubbleGeometry.androidCorners(isOwn = isOwn, isFollowUp = isFollowUp, hasFollower = hasFollower)"))
    }

    // MARK: Reaction chip (F00 C24 = S40 CL2)

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
        let ios = fnd3Normalized(try fnd3Source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveReactionChip+iOS.swift"))
        #expect(ios.contains("if ConclaveReactionChipPolicy.tapAdds(chip) {"))
        #expect(ios.contains("content.conclaveGestureFeedback(.reactionSent, trigger: trigger)"))
        #expect(ios.contains("Capsule().strokeBorder(HostingTheme.coralText, lineWidth: 1)"))
        #expect(ios.contains(".background(Color(uiColor: .tertiarySystemFill), in: Capsule())"))
        #expect(ios.contains(".accessibilityAddTraits(chip.isMine ? [.isSelected] : [])"))
        #expect(ios.contains(".font(.footnote.monospacedDigit())"))
        #expect(!ios.contains("coralFill"), "chips are never coral-filled")
        let android = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/components/ConclaveReactionChip.kt"))
        #expect(android.contains("role = Role.Checkbox,"))
        #expect(android.contains("onLongClickLabel = longPressLabel,"))
        #expect(android.contains("hapticFeedbackEnabled = false,"))
        #expect(android.contains("if (chip.canToggle) toggleableState = ToggleableState(chip.isMine)"))
        #expect(android.contains("color = if (chip.isMine) scheme.secondaryContainer else scheme.surfaceContainerHighest,"))
        #expect(android.contains("modifier.minimumInteractiveComponentSize()"))
        #expect(android.contains("FlowRow(modifier.testTag(identifier), horizontalArrangement = Arrangement.spacedBy(ConclaveReactionChipPolicy.spacing.dp)) {"))
        for word in ["FilterChip(", "primaryContainer", "Experimental"] { #expect(!android.contains(word), "\(word)") }
    }

    // MARK: One-time tip (F00 C25; RECONCILE R39)

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
        let ios = fnd3Normalized(try fnd3Source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveTip+iOS.swift"))
        #expect(ios.contains("import TipKit"))
        #expect(ios.contains("struct ConclaveOneTimeTip: Tip {"))
        #expect(ios.contains("var id: String { OneTimeTipPolicy.storeKey(tipID.rawValue) }"))
        #expect(ios.contains("TipView<ConclaveOneTimeTip>(tip)"))
        let android = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/components/ConclaveTipCard.kt"))
        #expect(android.contains("const val PREFERENCES = \"conclave.tips\""))
        #expect(android.contains(".getBoolean(OneTimeTipPolicy.storeKey(id), false)"))
        #expect(android.contains(".putBoolean(OneTimeTipPolicy.storeKey(id), true).apply()"))
        #expect(android.contains("color = scheme.surfaceContainerHigh, border = BorderStroke(1.dp, scheme.outlineVariant),"))
        #expect(android.contains("Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString(\"ds_dismiss_tip\"))"))
        #expect(android.contains("if (!visible) return"))
        for word in ["Popup(", "TooltipBox", "LaunchedEffect", "PlainTooltip", "RichTooltip"] { #expect(!android.contains(word), "\(word)") }
        // F00 C25 l: no popover tips anywhere; TipKit is configured once at launch (request R2 to ConclaveApp.swift).
        for file in try fnd3Files(under: "Sources/Conclave", extensions: ["swift"]) {
            #expect(!(try fnd3Source(file)).contains(".popoverTip"), "\(file)")
        }
        let app = try fnd3Source("Sources/Conclave/ConclaveApp.swift")
        #expect(app.contains("try? Tips.configure([.datastoreLocation(.applicationDefault)])"), "B3-T3 request R2 applied")
    }

    // MARK: Short text-entry dialog (S50 PL10)

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
        let ios = fnd3Normalized(try fnd3Source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveDialogs+iOS.swift"))
        #expect(ios.contains(".alert(model.title, isPresented: $isPresented) { TextField(model.fieldLabel, text: $text)"))
        #expect(ios.contains(".disabled(!ConclaveTextEntryPolicy.canConfirm(text, isPending: false))"))
        #expect(ios.contains("let capped = ConclaveTextEntryPolicy.capped(value, limit: model.limit)"))
        // The FND-1 pins stay: one destructive ternary per C18 dialog kind.
        #expect(ios.components(separatedBy: "role: model.confirmRole == .destructive ? .destructive : nil").count - 1 == 2)
        let android = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/components/ConclaveDialogs.kt"))
        #expect(android.contains("onDismissRequest = { if (!pending) onDismiss() },"))
        #expect(android.contains("onValueChange = { onValueChange(ConclaveTextEntryPolicy.capped(it, limit = model.limit)) },"))
        #expect(android.contains("minLines = if (multiline) ConclaveTextEntryPolicy.multilineMinLines else 1,"))
        #expect(android.contains("CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)"))
        #expect(!android.contains("primaryContainer"))
    }

    // MARK: Semantics exporter (S40 R40-11)

    @Test func exporterReadsActionsAndPopupRoots() throws {
        let exporter = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/hosting/NativeSemanticsExport.kt"))
        #expect(exporter.contains("val customActions: List<String> = emptyList(),"))
        #expect(exporter.contains("val onLongClickLabel: String? = null,"))
        #expect(exporter.contains("\"customActions\" to strings(n.customActions), \"onLongClickLabel\" to string(n.onLongClickLabel),"))
        #expect(exporter.contains("customActions = config.getOrNull(SemanticsActions.CustomActions)?.map { it.label } ?: emptyList(),"))
        #expect(exporter.contains("onLongClickLabel = config.getOrNull(SemanticsActions.OnLongClick)?.label,"))
        #expect(exporter.contains("internal object NativeSemanticsPopupRoots {"))
        #expect(exporter.contains("val registered = isDebuggableApp(context) if (registered) NativeSemanticsPopupRoots.register(view, name)"))
        #expect(exporter.contains("listOf(\"merged\" to merged, \"unmerged\" to unmerged) + popups"))
        // Every sheet, dialog and dropdown root in the component files registers and exposes tags as resource ids.
        let roots: [(String, Int)] = [("Sources/Conclave/Skip/ui/components/ConclaveDialogs.kt", 2),
                                      ("Sources/Conclave/Skip/ui/components/ConclaveMenus.kt", 1),
                                      ("Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt", 1),
                                      ("Sources/Conclave/Skip/ui/components/ConclaveFields.kt", 1)]
        for (file, count) in roots {
            let text = try fnd3Source(file)
            #expect(text.components(separatedBy: "NativeSemanticsPopupRoot(").count - 1 == count, "\(file)")
            #expect(text.components(separatedBy: "testTagsAsResourceId = true").count - 1 == count, "\(file)")
        }
    }

    // MARK: Board tokens (S60 R6-7, F00 2.6 A9)

    @Test func boardTokensComeFromTheZincRamp() throws {
        #expect(DesignTokens.iosGameBoardLight == 0xFF71717A && DesignTokens.iosGameBoardLight == DesignTokens.neutralZinc500)
        #expect(DesignTokens.iosGameBoardDark == 0xFF3F3F46 && DesignTokens.iosGameBoardDark == DesignTokens.neutralZinc700)
        #expect(DesignTokens.androidExtendedGameBoardLight == DesignTokens.iosGameBoardLight)
        #expect(DesignTokens.androidExtendedGameBoardDark == DesignTokens.iosGameBoardDark)
        func ratio(_ foreground: Int64, _ background: Int64) -> Double { ContrastRatio.wcag(foreground: foreground, background: background) }
        #expect(abs(ratio(DesignTokens.paper, DesignTokens.iosGameBoardLight) - 4.630) < 0.001)
        #expect(abs(ratio(DesignTokens.paper, DesignTokens.iosGameBoardDark) - 10.006) < 0.001)
        #expect(abs(ratio(DesignTokens.iosGameBoardLight, DesignTokens.iosGameBoardDark) - 2.161) < 0.001)
        #expect(abs(ratio(DesignTokens.coral, DesignTokens.iosGameBoardDark) - 3.364) < 0.001)
        let generator = try fnd3Source("../../packages/ui-tokens/scripts/gen-native-tokens.mjs")
        #expect(generator.contains("const iosGameKeys = [\"boardLight\", \"boardDark\"];"))
        #expect(generator.contains("\"gameBoardLight\", \"gameBoardDark\"];"))
        // Android reads them as ext.gameBoardLight and ext.gameBoardDark (B3-T3 request R3 to ConclaveExtendedColors.kt).
        let ext = fnd3Normalized(try fnd3Source("Sources/Conclave/Skip/ui/theme/ConclaveExtendedColors.kt"))
        #expect(ext.contains("gameBoardLight = Color(DesignTokens.androidExtendedGameBoardLight),"), "B3-T3 request R3 applied")
        #expect(ext.contains("gameBoardDark = Color(DesignTokens.androidExtendedGameBoardDark),"), "B3-T3 request R3 applied")
    }

    // MARK: Catalog

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
        // Keyed lookup only: a duplicate id fails galleryCatalogKeysStableUniqueAndDashFree, it never aborts the run.
        let pairs = Dictionary(ComponentGalleryCatalog.contrastPairs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (id, value) in expected {
            let pair = pairs[id]
            #expect(pair != nil, "\(id)")
            #expect(abs((pair?.ratio ?? 0) - value) < 0.001 && abs((pair?.expectedRatio ?? 0) - value) < 0.001, "\(id)")
        }
        #expect(Array(ComponentGalleryCatalog.contrastPairs.suffix(14).map { $0.id }) == expected.map { $0.0 })
    }

    // MARK: Hygiene

    @Test func sharedContentModelsStayInsideSkipLite() throws {
        let text = try fnd3Source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveContentModels.swift")
        #expect(!text.contains("#if"))
        #expect(fnd3Matches(#"case [a-z][A-Za-z]*\("#, in: text).isEmpty, "no associated values")
        #expect(fnd3Matches(#"-> \("#, in: text).isEmpty, "no tuples")
        #expect(fnd3Matches(#"\.map\([A-Za-z.]+\)"#, in: text).isEmpty && !text.contains("compactMap"))
        for word in ["SwiftUI", "UIKit", "MeetingViewModel", "isLetter", "enumerated()"] { #expect(!text.contains(word), "\(word)") }
    }

    @Test func fnd3SourcesAreDashFreeAndFlat() throws {
        for file in Self.fnd3CheckedFiles {
            let text = try fnd3Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) contains an en or em dash")
            for word in ["Gradient", "gradient", "dynamicLightColorScheme", "dynamicDarkColorScheme", ".shadow(", "Icons.Default"] {
                #expect(!text.contains(word), "\(file) uses \(word)")
            }
            #expect(fnd3Matches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }
    }

    static let composerGlassFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveComposerGlass+iOS.swift"
    static let composerBranchCondition = "if #available(iOS 26.0, *), ConclaveComposerMaterialPolicy.material(glassAvailable: true, reduceTransparency: reduceTransparency, forceOpaque: forceOpaque, prefersReducedResourceUsage: prefersReducedResourceUsage) == .glass {"
    static let fnd3CheckedFiles = [
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveContentModels.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveComposerGlass+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveDialogs+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveChatBubble+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveReactionChip+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveTip+iOS.swift",
        "Sources/Conclave/Skip/ui/components/ConclaveFields.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveDialogs.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveChatBubble.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveReactionChip.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveTipCard.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveMenus.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveStatus.kt",
        "Sources/Conclave/Skip/ui/hosting/NativeSemanticsExport.kt",
        "Sources/Conclave/DesignSystem/ComponentGalleryCatalog.swift",
    ]
}

// MARK: Helpers (private to this file)

private func fnd3PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func fnd3Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: fnd3PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func fnd3Files(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = fnd3PackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func fnd3Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func fnd3WithoutComments(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

private func fnd3Matches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}

/// The ranges of every block that opens with `marker` (which ends in "{"), through its matching closing brace.
private func fnd3BracedBlocks(after marker: String, in text: String) -> [Range<String.Index>] {
    var result: [Range<String.Index>] = []
    var start = text.startIndex
    while let found = text.range(of: marker, range: start..<text.endIndex) {
        var depth = 1
        var index = found.upperBound
        while index < text.endIndex && depth > 0 {
            if text[index] == "{" { depth += 1 } else if text[index] == "}" { depth -= 1 }
            index = text.index(after: index)
        }
        result.append(found.lowerBound..<index)
        start = index
    }
    return result
}
#endif
