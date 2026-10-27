#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// FND-2, foundation pack 2 (OUT/PLAN-screens.md section 5): in-call chrome (C03 capsule, chrome buttons, route
/// picker; S20 SR3 stage chip), badges (C06), tile chrome (C08 with S20 SR4), the toast host with the dark Android
/// snackbar slot (C13; RECONCILE R1), menus and the reaction palette (C16, C22), the Android action sheet (C17; S30
/// CL9), the audio route list (S30 CL8) and the in-call banner lane (C12). Policies run here; iOS-only and Kotlin
/// sources are read. The Kotlin half is T/Skip/FND1FND2BridgeTests.kt.
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

    // MARK: Tile chrome (C08, S20 SR4)

    @Test func tileDensityFollowsTheSlotSize() {
        // F00 C08 l: the dense switch at 160 x 130.
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

    @Test func tileChromeKeepsTheRendererBelowAndTheSpeakerInALeaf() throws {
        let ios = try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveTileChrome+iOS.swift")
        let flat = normalizedFND(ios)
        // The renderer is the first layer and Smart Invert leaves it alone.
        #expect(flat.contains("ZStack { renderer() .accessibilityIgnoresInvertColors()"))
        // Only leaves read the speaking state: the ring, the pill waveform and the value modifier.
        #expect(ios.components(separatedBy: ".isSpeaking").count - 1 == 4)
        #expect(flat.contains(".strokeBorder(HostingTheme.coralFill, lineWidth: 2) .opacity(state.isSpeaking ? 1 : 0)"))
        #expect(flat.contains(".accessibilityElement(children: .ignore)"))
        #expect(flat.contains(".background(HostingTheme.inCallLabelScrim, in: Capsule())"))
        #expect(!ios.contains("glassEffect") && !ios.contains("conclaveControlSurface"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveTileChrome.kt"))
        #expect(android.contains("Box(Modifier.fillMaxSize()) { renderer() }"))
        #expect(android.contains("private fun SpeakingStroke(speaking: TileSpeakingState, cornerRadius: Dp) { if (speaking.isSpeaking) {"))
        #expect(android.contains("Modifier.combinedClickable(hapticFeedbackEnabled = false,"))
        #expect(android.contains("haptics.gesture(FeedbackKind.longPress)"))
        #expect(android.contains("contentDescription = name stateDescription = states if (custom.isNotEmpty()) customActions = custom"))
        // No lazy container may hold a renderer (P5).
        #expect(!android.contains("LazyRow") && !android.contains("LazyColumn") && !android.contains("LazyVerticalGrid"))
    }

    // MARK: Surface contexts (C03 f, C04 f; S10 R9)

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
        // Off and Engaged stay paper in every context.
        for context in ConclaveSurfaceContext.allCases {
            for state in [ConclaveControlState.off, .engaged] {
                #expect(ConclaveControlSurfaceMapping.spec(state, context: context, glassAvailable: true, reduceTransparency: false,
                                                           forceOpaque: false, increasedContrast: false, isEnabled: true).fill == .paper)
            }
        }
    }

    // MARK: Chrome and the stage chip (C03, S20 SR3)

    @Test func chromeSitsInTheGlassEntryAndChipsNeverTakeGlass() throws {
        let control = try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveCallControl+iOS.swift")
        let flat = normalizedFND(control)
        for name in ["struct ConclaveMeetingCapsule: View {", "struct ConclaveChromeButton: View {", "struct ConclaveRoutePickerButton: View {",
                     "struct ConclaveTopChromeCluster<Content: View>: View {"] {
            #expect(control.contains(name), "\(name)")
        }
        #expect(flat.contains(".buttonStyle(ConclaveChromeButtonStyle(shape: .capsule, context: context))"))
        #expect(flat.contains("view.prioritizesVideoDevices = false"))
        #expect(flat.contains("func routePickerViewWillBeginPresentingRoutes(_ routePickerView: AVRoutePickerView) { onPresentingChange(true) }"))
        #expect(flat.contains(".lineLimit(1) .truncationMode(.middle)"))
        #expect(flat.contains("var surface: ConclaveSurfaceContext { self == .stage ? .stage : .overVideo }"))
        let chip = try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveStageChip+iOS.swift")
        for glass in ["glassEffect", "GlassEffectContainer", "conclaveControlSurface", "Material"] { #expect(!chip.contains(glass), "\(glass)") }
        let chipFlat = normalizedFND(chip)
        #expect(chipFlat.contains(".background(HostingTheme.inCallLabelScrim, in: Capsule()) .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveStageChrome.kt"))
        #expect(android.components(separatedBy: "color = ext.labelScrim,").count - 1 == 3)
        #expect(android.components(separatedBy: "border = BorderStroke(1.dp, ext.border),").count - 1 == 3)
        #expect(android.contains("\"usb\"") == false, "USB and hearing aid fall back to the speaker glyph until CL11 lands")
        #expect(android.contains("ConclaveChromeButton(conclaveString(\"ds_minimize_call\"), ConclaveIcons.ArrowBackFill0,"))
    }

    // MARK: Badges (C06)

    @Test func badgeRulesAndTagsHoldOnBothPlatforms() throws {
        #expect(!ConclaveBadgeCount.isVisible(0) && ConclaveBadgeCount.isVisible(1))
        #expect(ConclaveBadgeCount.displayed(99) == 99 && !ConclaveBadgeCount.isCapped(99))
        #expect(ConclaveBadgeCount.displayed(120) == 99 && ConclaveBadgeCount.isCapped(120))
        #expect(ConclavePersonTag.allCases.map { $0.rawValue } == ["host", "cohost", "you"])
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveBadge+iOS.swift"))
        #expect(ios.contains(".foregroundStyle(HostingTheme.onCoral)"))
        #expect(ios.contains("case .cohost: return ConclaveStrings.text(\"Co-Host\")"))
        #expect(ios.contains(".background(Color(uiColor: .tertiarySystemFill), in: Capsule())"))
        // The call control reuses the standalone badge (the extracted C06).
        let control = try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveCallControl+iOS.swift")
        #expect(!control.contains("private struct ConclaveCountBadge"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveBadge.kt"))
        #expect(android.contains("Badge(modifier = modifier.clearAndSetSemantics { }, containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer)"))
        #expect(android.contains("ConclavePersonTag.cohost -> conclaveString(\"ds_tag_cohost\")"))
    }

    // MARK: Toasts (C13, RECONCILE R1)

    @Test func darkSnackbarSlotUsesTheInCallRoles() throws {
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveToastHost.kt"))
        #expect(android.contains("containerColor = scheme.surfaceContainerHigh, contentColor = scheme.onSurface, actionContentColor = scheme.primary,"))
        #expect(android.contains("modifier = Modifier.border(1.dp, ext.border, shape)"))
        #expect(android.contains("Snackbar(data, shape = MaterialTheme.shapes.small)"), "in-page snackbars stay stock")
        #expect(!android.contains("textAllCaps") && !android.contains("uppercase"))
        // The archived pairs: 15.001 and 6.246 on #232327.
        let pairs = Dictionary(uniqueKeysWithValues: ComponentGalleryCatalog.contrastPairs.map { ($0.id, $0) })
        #expect(abs((pairs["contrast.snackbar.text"]?.ratio ?? 0) - 15.001) < 0.001)
        #expect(abs((pairs["contrast.snackbar.action"]?.ratio ?? 0) - 6.246) < 0.001)
        #expect(DesignTokens.androidInCallSurfaceContainerHigh == 0xFF232327)
    }

    @Test func toastHostTimesOneToastAtATime() throws {
        let android = try fndSource("Sources/Conclave/Skip/ui/components/ConclaveToastHost.kt")
        #expect(android.components(separatedBy: "LaunchedEffect(").count - 1 == 1)
        #expect(android.contains("LaunchedEffect(item?.id) {"))
        for word in ["while", "delay(", "repeat(", "Timer", "infinite", "withFrameNanos"] { #expect(!android.contains(word), "\(word)") }
        #expect(!fndContainsDash(android))
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveToast+iOS.swift"))
        #expect(ios.contains(".task(id: item.id) {"))
        #expect(ios.contains("ConclaveToastTiming.durationMillis(hasAction: item.hasAction, isScreenReaderRunning: isScreenReaderRunning)"))
        #expect(ios.contains("text.accessibilitySpeechAnnouncementPriority = item.isFailure ? .high : .low"))
        #expect(ios.contains(".accessibilityAction(.escape) { onDismiss(item.id) }"))
        #expect(ios.contains(".tint(HostingTheme.inCallCoralText)"))
        let item = ConclaveToastItem(id: "t1", message: "Avery raised a hand", actionTitle: "View", actionId: "view", avatarName: "Avery",
                                     avatarId: "", isFailure: false)
        #expect(item.hasAction && item.hasAvatar)
    }

    // MARK: Menus, palette and the action sheet (C16, C17, C22)

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

    @Test func menusActionSheetAndPaletteKeepTheirRoles() throws {
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveMenus+iOS.swift"))
        #expect(ios.contains(".menuOrder(order == .fromBar ? .priority : .fixed)"))
        #expect(ios.contains("Toggle(isOn: Binding(get: { item.isOn }, set: { _ in onSelect(item) }))"))
        #expect(ios.contains("Button(role: .destructive) { onSelect(item) } label: { label }"))
        #expect(ios.contains("if !item.isEnabled && !item.disabledReason.isEmpty { Text(item.disabledReason) }"))
        #expect(ios.contains(".controlGroupStyle(.palette)"))
        let menus = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveMenus.kt"))
        #expect(menus.contains("tonalElevation = 0.dp, shadowElevation = 0.dp, border = BorderStroke(1.dp, scheme.outlineVariant),"))
        #expect(menus.contains("role = Role.Checkbox toggleableState = ToggleableState(item.isOn)"))
        #expect(menus.contains("MenuDefaults.itemColors(textColor = scheme.error, leadingIconColor = scheme.error)"))
        let sheet = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt"))
        #expect(sheet.contains("HostingTheme(inCall = true) {"))
        #expect(sheet.contains("rememberModalBottomSheetState(skipPartiallyExpanded = true)"))
        // A panel tile reports only after the hide completes: no panel from a dismissing sheet.
        #expect(sheet.contains("scope.launch { sheetState.hide() }.invokeOnCompletion { if (!sheetState.isVisible) { onDismiss() onTile(tile) } }"))
        #expect(sheet.contains(".toggleable(value = raised, enabled = enabled, role = Role.Switch, onValueChange = onToggle)"))
        #expect(sheet.contains("haptics.gesture(FeedbackKind.reactionSent)"))
        #expect(sheet.contains("this.paneTitle = paneTitle"))
        #expect(!sheet.contains("LazyVerticalGrid") && !sheet.contains("LazyColumn"))
    }

    @Test func audioRouteListIsOneRadioGroup() throws {
        let list = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/AudioRouteList.kt"))
        #expect(list.contains("Column(modifier.testTag(identifier).selectableGroup())"))
        #expect(list.contains(".selectable(selected = row.selected, enabled = row.enabled, role = Role.RadioButton, onClick = { onSelect(row.id) })"))
        #expect(list.contains("key(row.id) {"))
        #expect(list.contains("if (row.pending) stateDescription = switchingDescription"))
        #expect(!list.contains("haptics"), "the caller plays selectionChanged; automatic changes never reach the list")
    }

    // MARK: Banner lane (C12)

    @Test func bannerLaneStaysOneBannerWideAndOutsideTiles() throws {
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveBanner+iOS.swift"))
        #expect(ios.contains("static let maxWidth: CGFloat = 560"))
        #expect(ios.contains("ConclaveBannerPresence(isPresented: noticeID != nil) {"))
        #expect(ios.contains("return surface == .inCall ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.statusWarning"))
        #expect(!ios.contains("DesignTokens.warningDark") && !ios.contains("DesignTokens.successLight"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveBanner.kt"))
        #expect(android.contains("const val MAX_WIDTH_DP = 560"))
        #expect(android.contains("val ext = if (inCall) ConclaveExtendedColorsDark else LocalConclaveExtendedColors.current"))
        #expect(!android.contains("isSystemInDarkTheme"))
    }

    // MARK: Catalog

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
        let pairs = Dictionary(uniqueKeysWithValues: ComponentGalleryCatalog.contrastPairs.map { ($0.id, $0) })
        for (id, ratio) in expected {
            let pair = pairs[id]
            #expect(pair != nil, "\(id)")
            #expect(abs((pair?.ratio ?? 0) - ratio) < 0.001, "\(id)")
            #expect(abs((pair?.expectedRatio ?? 0) - ratio) < 0.001, "\(id)")
        }
    }

    @Test func fndComponentSourcesAreDashFreeAndFlat() throws {
        var files = try fndFiles(under: "Sources/Conclave/DesignSystem/iOS/Components", extensions: ["swift"])
        files += try fndFiles(under: "Sources/Conclave/Skip/ui/components", extensions: ["kt"])
        files += ["Sources/Conclave/DesignSystem/iOS/HostingTheme+iOS.swift", "Sources/Conclave/DesignSystem/iOS/ConclaveMotion+iOS.swift",
                  "Sources/Conclave/DesignSystem/iOS/CallAppearance+iOS.swift", "Sources/Conclave/DesignSystem/iOS/SystemAccessibility+iOS.swift",
                  "Sources/Conclave/Skip/ui/theme/ConclaveExtendedColors.kt", "Sources/Conclave/Skip/ui/theme/SystemAccessibility.kt"]
        #expect(files.count >= 30)
        for file in files {
            let text = try fndSource(file)
            #expect(!fndContainsDash(text), "\(file)")
            for word in ["Gradient", "gradient", "dynamicLightColorScheme", "dynamicDarkColorScheme", ".shadow("] {
                #expect(!text.contains(word), "\(file) uses \(word)")
            }
        }
    }
}
#endif
