

struct GalleryContrastPair: Equatable {
    let id: String
    let caption: String
    let foreground: Int64
    let background: Int64
    let requirement: ContrastRequirement
    let expectedRatio: Double

    var ratio: Double { ContrastRatio.wcag(foreground: foreground, background: background) }
}

enum GallerySection: String, CaseIterable {
    case typography, haptics, contrast, systemProminent
    case buttons, callControls, rows, banners, status

    var isIOSOnly: Bool { self == .systemProminent }

    var isInCallOnly: Bool { self == .callControls }
}

enum ComponentGalleryCatalog {
    static let galleryToggleID = "components.gallery.toggle"
    static let environmentID = "components.environment"
    static let overflowID = "components.overflow"
    static let longTextToggleID = "components.longText"
    static let hapticVerifyID = "components.haptics.verify"
    static let hapticResultID = "components.haptics.result"
    static let hapticRecordID = "components.haptics.record"

    static func sectionID(_ section: GallerySection) -> String {
        return "components.section." + section.rawValue
    }

    static func typeSpecimenID(_ style: ConclaveTextStyle, _ weight: ConclaveTextWeight) -> String {
        return "type." + style.rawValue + "." + weight.rawValue
    }

    static func hapticSpecimenID(_ kind: FeedbackKind) -> String {
        return "haptic." + kind.rawValue
    }

    static func liveContrastID(_ name: String, inCall: Bool) -> String {
        return columnID("contrast.live." + name, inCall: inCall)
    }

    static func columnID(_ id: String, inCall: Bool) -> String {
        return id + (inCall ? ".inCall" : ".app")
    }

    static func expanded(_ text: String) -> String {
        return text + " " + text
    }

    static let prominentConfirmationActionID = "system.prominent.confirmationAction"
    static let prominentGlassID = "system.prominent.glass"
    static let prominentBorderedID = "system.prominent.bordered"
    static let prominentGlassOnCoralID = "system.prominent.glass.onCoral"
    static let prominentBorderedOnCoralID = "system.prominent.bordered.onCoral"

    static let prominentPageLinkID = "system.prominent.confirmationAction.open"
    static let systemProminentSpecimenIDs: [String] = [
        prominentConfirmationActionID, prominentGlassID, prominentBorderedID,
        prominentGlassOnCoralID, prominentBorderedOnCoralID,
    ]

    static let accentLight: Int64 = DesignTokens.coralDeep
    static let accentLightHighContrast: Int64 = DesignTokens.coralDeepHighContrast
    static let accentDark: Int64 = DesignTokens.coralBright
    static let accentDarkHighContrast: Int64 = DesignTokens.coralBrightHighContrast

    static let showLoadingToggleID = "components.showLoading"

    static let forceOpaqueToggleID = "components.forceOpaque"

    static let controlRecordID = "components.controls.record"

    static let buttonPrimaryID = "button.primary"
    static let buttonTonalID = "button.tonal"
    static let buttonTextID = "button.text"
    static let buttonDestructiveID = "button.destructive"

    static let buttonPendingID = "button.primary.pending"
    static let toggleCallID = "toggle.call"
    static let leaveID = "button.leave"

    static let badgeCountID = "badge.count"
    static let compactBarID = "control.bar.compact"

    static let compactBarProbeID = "control.bar.compact.probe"

    static let compactBarReadoutID = "control.bar.compact.readout"

    static let compactBarMovedID = "control.bar.compact.moved"
    static let rowValueID = "row.value"
    static let rowNavigationID = "row.navigation"
    static let rowDestructiveID = "row.destructive"
    static let rowSelectableID = "row.selectable"
    static let toggleRowID = "toggle.row"
    static let rowPersonID = "row.person"

    static let rowPersonWaitingID = "row.person.waiting"
    static let bannerInfoID = "banner.info"
    static let bannerWarningID = "banner.warning"
    static let bannerErrorID = "banner.error"
    static let bannerSuccessID = "banner.success"

    static let bannerReconnectingID = "banner.reconnecting"

    static let bannerMotionID = "banner.motion"
    static let bannerMotionToggleID = "banner.motion.toggle"

    static let bannerAnnouncementID = "banner.motion.announcement"
    static let statusLoadingID = "status.loading"
    static let statusErrorID = "status.error"
    static let statusEmptyID = "status.empty"
    static let statusOfflineID = "status.offline"

    static let compactBarMicrophone = "microphone"
    static let compactBarCamera = "camera"
    static let compactBarShareScreen = "shareScreen"
    static let compactBarChat = "chat"
    static let compactBarMore = "more"

    static let compactBarControls: [String] = [
        compactBarMicrophone, compactBarCamera, compactBarShareScreen, compactBarChat, compactBarMore,
    ]
    static let compactBarMoveOrder: [String] = [compactBarShareScreen]

    static let iconButtonID = "button.icon"
    static let closeButtonID = "button.close"
    static let iconToggleID = "button.icon.toggle"
    static let avatarRowID = "avatar.row"
    static let avatarChatID = "avatar.chat"
    static let avatarTileID = "avatar.tile"
    static let avatarLobbyID = "avatar.lobby"
    static let sectionHeaderID = "section.header"
    static let sectionFooterID = "section.footer"
    static let dialogConfirmID = "dialog.confirm"
    static let dialogAlertID = "dialog.alert"
    static let fieldTextID = "field.text"
    static let fieldTextErrorID = "field.text.error"
    static let fieldComposerID = "field.composer"
    static let toggleLabelledID = "toggle.call.labelled"
    static let chromeCapsuleID = "chrome.capsule"
    static let chromeButtonID = "chrome.button"
    static let stageChipHandID = "stage.chip.hand"
    static let stageChipNowPlayingID = "stage.chip.nowPlaying"
    static let badgeDotID = "badge.dot"
    static let badgeTagID = "badge.tag"
    static let badgeStatusID = "badge.status"
    static let tileVideoID = "tile.chrome.video"
    static let tileCameraOffID = "tile.chrome.cameraOff"
    static let tileSpeakingID = "tile.chrome.speaking"
    static let tileDenseID = "tile.chrome.dense"
    static let tileReconnectingID = "tile.chrome.reconnecting"
    static let tileSelfFlipID = "tile.chrome.selfFlip"
    static let tileSpotlightID = "tile.chrome.spotlight"
    static let tileOverflowID = "stage.overflow"
    static let toastInfoID = "toast.info"
    static let toastActionID = "toast.action"
    static let menuAnchoredID = "menu.anchored"
    static let menuContextID = "menu.context"
    static let paletteReactionsID = "palette.reactions"

    static let sheetActionsID = "sheet.actions"

    static let sheetRouteID = "sheet.route"

    static let foundationSpecimenIDs: [String] = [
        iconButtonID, closeButtonID, iconToggleID, avatarRowID, avatarChatID, avatarTileID, avatarLobbyID,
        sectionHeaderID, sectionFooterID, dialogConfirmID, dialogAlertID, fieldTextID, fieldTextErrorID, fieldComposerID,
        toggleLabelledID,
    ]

    static let inCallChromeSpecimenIDs: [String] = [
        chromeCapsuleID, chromeButtonID, stageChipHandID, stageChipNowPlayingID, badgeDotID, badgeTagID, badgeStatusID,
        tileVideoID, tileCameraOffID, tileSpeakingID, tileDenseID, tileReconnectingID, tileSelfFlipID, tileSpotlightID,
        tileOverflowID, toastInfoID, toastActionID, menuAnchoredID, menuContextID, paletteReactionsID, sheetActionsID,
        sheetRouteID,
    ]

    static let fieldComposerGlassID = "field.composer.glass"
    static let fieldComposerAccessoriesID = "field.composer.accessories"
    static let fieldSearchID = "field.search"
    static let segmentedSingleID = "segmented.single"
    static let segmentedMenuID = "segmented.menu"
    static let chatBubbleOwnID = "chat.bubble.own"
    static let chatBubblePeerID = "chat.bubble.peer"
    static let chatBubblePrivateID = "chat.bubble.private"
    static let chatBubbleAnswerID = "chat.bubble.answer"
    static let chipReactionID = "chip.reaction"
    static let tipInlineID = "tip.inline"
    static let dialogTextEntryID = "dialog.textEntry"
    static let gameBoardTokensID = "game.board.tokens"

    static let contentSpecimenIDs: [String] = [
        fieldComposerGlassID, fieldComposerAccessoriesID, fieldSearchID, segmentedSingleID, segmentedMenuID,
        chatBubbleOwnID, chatBubblePeerID, chatBubblePrivateID, chatBubbleAnswerID, chipReactionID, tipInlineID,
        dialogTextEntryID, gameBoardTokensID,
    ]

    static let sampleRoomCode = "abc-defg-hij"

    static func specimenIDs(_ section: GallerySection, showLoading: Bool) -> [String] {
        var ids: [String] = []
        switch section {
        case .buttons:
            ids.append(buttonPrimaryID)
            ids.append(buttonTonalID)
            ids.append(buttonTextID)
            ids.append(buttonDestructiveID)
            if showLoading { ids.append(buttonPendingID) }
        case .callControls:
            ids.append(toggleCallID)
            ids.append(leaveID)
            ids.append(badgeCountID)
            ids.append(compactBarID)
        case .rows:
            ids.append(rowValueID)
            ids.append(rowNavigationID)
            ids.append(rowDestructiveID)
            ids.append(rowSelectableID)
            ids.append(toggleRowID)
            ids.append(rowPersonID)
            ids.append(rowPersonWaitingID)
        case .banners:
            ids.append(bannerInfoID)
            ids.append(bannerWarningID)
            ids.append(bannerErrorID)
            ids.append(bannerSuccessID)
            if showLoading { ids.append(bannerReconnectingID) }
        case .status:
            if showLoading { ids.append(statusLoadingID) }
            ids.append(statusErrorID)
            ids.append(statusEmptyID)
            ids.append(statusOfflineID)
        case .typography, .haptics, .contrast, .systemProminent:
            break
        }
        return ids
    }

    static func componentSpecimenIDs(showLoading: Bool) -> [String] {
        var ids: [String] = []
        for section in [GallerySection.buttons, GallerySection.callControls, GallerySection.rows,
                        GallerySection.banners, GallerySection.status] {
            for inCall in [false, true] {
                if section.isInCallOnly && !inCall { continue }
                for id in specimenIDs(section, showLoading: showLoading) {
                    ids.append(columnID(id, inCall: inCall))
                }
            }
        }
        return ids
    }

    static let contrastPairs: [GalleryContrastPair] = [
        pair("contrast.onCoral.ink", "Ink on coral (onCoral)", DesignTokens.ink, DesignTokens.coral, .text, 6.374),
        pair("contrast.onCoral.black", "Black on coral (onCoral, increased contrast)", DesignTokens.iosAppOnCoralHighContrast, DesignTokens.coral, .text, 6.764),
        pair("contrast.coral.white", "White on coral", DesignTokens.neutralWhite, DesignTokens.coral, .forbiddenText, 3.105),
        pair("contrast.accentDark.white", "White on the dark AccentColor", DesignTokens.neutralWhite, accentDark, .forbiddenText, 2.507),
        pair("contrast.accentDarkHighContrast.white", "White on the dark AccentColor, increased contrast", DesignTokens.neutralWhite, accentDarkHighContrast, .forbiddenText, 2.268),
        pair("contrast.accentLight.white", "White on the light AccentColor", DesignTokens.neutralWhite, accentLight, .text, 5.366),
        pair("contrast.accentLightHighContrast.white", "White on the light AccentColor, increased contrast", DesignTokens.neutralWhite, accentLightHighContrast, .text, 7.236),
        pair("contrast.coralDeep.white", "Coral deep on white", DesignTokens.coralDeep, DesignTokens.neutralWhite, .text, 5.366),
        pair("contrast.coralDeep.groupedLight", "Coral deep on grouped background", DesignTokens.coralDeep, DesignTokens.iosAppLaunchBackgroundLight, .text, 4.809),
        pair("contrast.coralDeep.light4", "Coral deep on light 4 (R03 reference)", DesignTokens.coralDeep, DesignTokens.neutralLight4, .text, 4.551),
        pair("contrast.coralDeepHighContrast.white", "Coral deep, increased contrast, on white", DesignTokens.coralDeepHighContrast, DesignTokens.neutralWhite, .text, 7.236),
        pair("contrast.coralDeepHighContrast.groupedLight", "Coral deep, increased contrast, on grouped background", DesignTokens.coralDeepHighContrast, DesignTokens.iosAppLaunchBackgroundLight, .text, 6.485),
        pair("contrast.coralBright.black", "Coral bright on black", DesignTokens.coralBright, DesignTokens.neutralBlack, .text, 8.377),
        pair("contrast.coralBright.ink", "Coral bright on ink", DesignTokens.coralBright, DesignTokens.ink, .text, 7.895),
        pair("contrast.coralBright.surfaceRaised", "Coral bright on raised surface", DesignTokens.coralBright, DesignTokens.neutralSurfaceRaised, .text, 6.246),
        pair("contrast.coralBrightHighContrast.ink", "Coral bright, increased contrast, on ink", DesignTokens.coralBrightHighContrast, DesignTokens.ink, .text, 8.726),
        pair("contrast.coralBrightHighContrast.surfaceRaised", "Coral bright, increased contrast, on raised surface", DesignTokens.coralBrightHighContrast, DesignTokens.neutralSurfaceRaised, .text, 6.904),
        pair("contrast.coralBright.zinc700", "Coral bright on zinc 700 (R03)", DesignTokens.coralBright, DesignTokens.neutralZinc700, .forbiddenText, 4.166),
        pair("contrast.androidLight.onPrimary", "Android light onPrimary on primary", DesignTokens.androidLightOnPrimary, DesignTokens.androidLightPrimary, .text, 5.366),
        pair("contrast.androidDark.onPrimary", "Android dark onPrimary on primary", DesignTokens.androidDarkOnPrimary, DesignTokens.androidDarkPrimary, .text, 7.895),
        pair("contrast.androidLight.primarySurfaceContainerHigh", "Android light primary on surfaceContainerHigh", DesignTokens.androidLightPrimary, DesignTokens.androidLightSurfaceContainerHigh, .text, 4.715),
        pair("contrast.tonalDark", "Tonal button, dark", DesignTokens.androidDarkOnSecondaryContainer, DesignTokens.androidDarkSecondaryContainer, .text, 10.006),
        pair("contrast.tonalLight", "Tonal button, light", DesignTokens.androidLightOnSecondaryContainer, DesignTokens.androidLightSecondaryContainer, .text, 13.963),
        pair("contrast.androidLight.onSurfaceVariant", "Android light onSurfaceVariant on surface", DesignTokens.androidLightOnSurfaceVariant, DesignTokens.androidLightSurface, .text, 7.730),
        pair("contrast.androidDark.onSurfaceVariant", "Android dark onSurfaceVariant on surface", DesignTokens.androidDarkOnSurfaceVariant, DesignTokens.androidDarkSurface, .text, 7.722),
        pair("contrast.androidDark.onSurfaceVariantRaised", "Android dark onSurfaceVariant on raised surface", DesignTokens.androidDarkOnSurfaceVariant, DesignTokens.neutralSurfaceRaised, .text, 6.109),
        pair("contrast.iosSecondaryText.white", "iOS secondary text on white", DesignTokens.iosAppTextSecondaryLight, DesignTokens.neutralWhite, .text, 5.988),
        pair("contrast.iosSecondaryText.groupedLight", "iOS secondary text on grouped background", DesignTokens.iosAppTextSecondaryLight, DesignTokens.iosAppLaunchBackgroundLight, .text, 5.366),

        pair("contrast.iosSecondaryTextHighContrast.groupedLight", "iOS secondary text, increased contrast, on grouped background", DesignTokens.iosAppTextSecondaryLightHighContrast, DesignTokens.iosAppLaunchBackgroundLight, .text, 8.177),
        pair("contrast.inCallSecondary.ink", "In-call secondary text on stage", DesignTokens.iosInCallTextSecondary, DesignTokens.iosInCallStage, .text, 10.420),
        pair("contrast.inCallSecondary.tile", "In-call secondary text on tile", DesignTokens.iosInCallTextSecondary, DesignTokens.iosInCallTile, .text, 9.985),
        pair("contrast.inCallTertiary.ink", "In-call tertiary text on stage", DesignTokens.iosInCallTextTertiary, DesignTokens.iosInCallStage, .text, 6.279),
        pair("contrast.inCallText.surfaceRaised", "In-call text on raised surface", DesignTokens.iosInCallText, DesignTokens.iosInCallSurfaceRaised, .text, 15.001),
        pair("contrast.inCallLabelScrim.white", "In-call label on scrim over white video", DesignTokens.paper, ContrastRatio.composite(DesignTokens.iosInCallLabelScrim, over: DesignTokens.neutralWhite), .text, 6.407),
        pair("contrast.inCallLabelScrimHighContrast.white", "In-call label on scrim over white video, increased contrast", DesignTokens.paper, ContrastRatio.composite(DesignTokens.iosInCallLabelScrimHighContrast, over: DesignTokens.neutralWhite), .text, 12.105),
        pair("contrast.toggleOff", "Call toggle off", DesignTokens.androidExtendedOnToggleOff, DesignTokens.androidExtendedToggleOffContainer, .text, 7.663),
        pair("contrast.toggleOn", "Call toggle on", DesignTokens.androidExtendedOnToggleOn, DesignTokens.androidExtendedToggleOnContainer, .text, 12.940),
        pair("contrast.toggleEngaged", "Call toggle engaged", DesignTokens.androidExtendedOnToggleEngaged, DesignTokens.androidExtendedToggleEngagedContainer, .text, 16.118),
        pair("contrast.iosControlOff", "iOS control off", DesignTokens.iosInCallOnControlOff, DesignTokens.iosInCallControlOff, .text, 18.960),
        pair("contrast.callEnd.white", "White on call end (glyph or large text only)", DesignTokens.androidExtendedOnCallEnd, DesignTokens.androidExtendedCallEnd, .largeText, 3.923),
        pair("contrast.androidLight.error", "Android light error on white", DesignTokens.androidLightError, DesignTokens.neutralWhite, .text, 6.461),
        pair("contrast.androidDark.error", "Android dark error on ink", DesignTokens.androidDarkError, DesignTokens.ink, .text, 11.656),
        pair("contrast.androidLight.errorContainer", "Android light onErrorContainer on errorContainer", DesignTokens.androidLightOnErrorContainer, DesignTokens.androidLightErrorContainer, .text, 7.239),
        pair("contrast.androidDark.errorContainer", "Android dark onErrorContainer on errorContainer", DesignTokens.androidDarkOnErrorContainer, DesignTokens.androidDarkErrorContainer, .text, 7.239),
        pair("contrast.successLight", "Success on white", DesignTokens.successLight, DesignTokens.neutralWhite, .text, 7.130),
        pair("contrast.successDark", "Success on ink", DesignTokens.successDark, DesignTokens.ink, .text, 8.685),
        pair("contrast.warningLight", "Warning on white", DesignTokens.warningLight, DesignTokens.neutralWhite, .text, 7.090),
        pair("contrast.warningDark", "Warning on ink", DesignTokens.warningDark, DesignTokens.ink, .text, 11.855),
        pair("contrast.liveLight", "Live on white", DesignTokens.liveLight, DesignTokens.neutralWhite, .text, 6.702),
        pair("contrast.liveDark", "Live on ink", DesignTokens.liveDark, DesignTokens.ink, .text, 7.784),
        pair("contrast.outline.white", "Outline on white", DesignTokens.androidLightOutline, DesignTokens.neutralWhite, .nonText, 4.833),
        pair("contrast.outline.ink", "Outline on ink", DesignTokens.androidDarkOutline, DesignTokens.ink, .nonText, 4.095),
        pair("contrast.coralFill.white", "Coral fill on white", DesignTokens.coral, DesignTokens.neutralWhite, .nonText, 3.105),
        pair("contrast.coralFill.ink", "Coral fill on ink", DesignTokens.coral, DesignTokens.ink, .nonText, 6.374),
        pair("contrast.inCallBorder.ink", "In-call border on stage", DesignTokens.iosInCallBorder, DesignTokens.iosInCallStage, .decorative, 1.419),
        pair("contrast.inCallBorderHighContrast.ink", "In-call border, increased contrast, on stage", DesignTokens.iosInCallBorderHighContrast, DesignTokens.iosInCallStage, .decorative, 2.742),

        pair("contrast.inCallWarning.surfaceRaised", "Warning on raised in-call surface", DesignTokens.iosInCallWarning, DesignTokens.iosInCallSurfaceRaised, .text, 9.380),
        pair("contrast.inCallSuccess.surfaceRaised", "Success on raised in-call surface", DesignTokens.iosInCallSuccess, DesignTokens.iosInCallSurfaceRaised, .text, 6.872),
        pair("contrast.inCallLive.surfaceRaised", "Live on raised in-call surface", DesignTokens.iosInCallLive, DesignTokens.iosInCallSurfaceRaised, .text, 6.159),
        pair("contrast.androidDark.errorSurfaceHigh", "Android dark error on surfaceContainerHigh", DesignTokens.androidDarkError, DesignTokens.androidDarkSurfaceContainerHigh, .text, 9.222),
        pair("contrast.warningLight.groupedLight", "Warning on grouped background", DesignTokens.warningLight, DesignTokens.iosAppLaunchBackgroundLight, .text, 6.354),

        pair("contrast.leaveHighContrast.white", "White on the iOS Leave fill, increased contrast (glyph)", DesignTokens.neutralWhite, DesignTokens.iosInCallLeaveHighContrast, .nonText, 4.555),
        pair("contrast.leaveHighContrast.stage", "iOS Leave fill, increased contrast, against the stage", DesignTokens.iosInCallLeaveHighContrast, DesignTokens.iosInCallStage, .nonText, 4.344),
        pair("contrast.speakingRing.tile", "Coral speaking ring against a tile", DesignTokens.coral, DesignTokens.iosInCallTile, .nonText, 5.973),
        pair("contrast.handBadge.ink", "Ink glyph on the hand raised badge", DesignTokens.iosInCallOnControlOff, DesignTokens.iosInCallWarning, .nonText, 11.855),
        pair("contrast.coralFill.surfaceRaised", "Coral badge against the raised in-call surface", DesignTokens.coral, DesignTokens.iosInCallSurfaceRaised, .nonText, 5.043),
        pair("contrast.coralFill.toolbar", "Coral badge against the Android call toolbar", DesignTokens.coral, DesignTokens.androidExtendedToolbarContainer, .nonText, 5.706),
        pair("contrast.snackbar.text", "Android stage lane snackbar text", DesignTokens.androidInCallOnSurface, DesignTokens.androidInCallSurfaceContainerHigh, .text, 15.001),
        pair("contrast.snackbar.action", "Android stage lane snackbar action", DesignTokens.androidInCallPrimary, DesignTokens.androidInCallSurfaceContainerHigh, .text, 6.246),
        pair("contrast.snackbarInPage.dark.text", "Android in-page snackbar text, dark", DesignTokens.androidDarkInverseOnSurface, DesignTokens.androidDarkInverseSurface, .text, 16.118),
        pair("contrast.snackbarInPage.dark.action", "Android in-page snackbar action, dark", DesignTokens.androidDarkInversePrimary, DesignTokens.androidDarkInverseSurface, .text, 4.882),
        pair("contrast.snackbarInPage.light.text", "Android in-page snackbar text, light", DesignTokens.androidLightInverseOnSurface, DesignTokens.androidLightInverseSurface, .text, 14.270),
        pair("contrast.snackbarInPage.light.action", "Android in-page snackbar action, light", DesignTokens.androidLightInversePrimary, DesignTokens.androidLightInverseSurface, .text, 5.942),
        pair("contrast.tagLight", "Android role tag, light", DesignTokens.androidLightOnSurfaceVariant, DesignTokens.androidLightSurfaceContainerHighest, .text, 6.556),
        pair("contrast.tagDark", "Android role tag, dark", DesignTokens.androidDarkOnSurfaceVariant, DesignTokens.androidDarkSurfaceContainerHighest, .text, 5.270),
        pair("contrast.menuErrorLight", "Android destructive menu item, light", DesignTokens.androidLightError, DesignTokens.androidLightSurfaceContainer, .text, 5.878),
        pair("contrast.menuErrorDark", "Android destructive menu item, dark", DesignTokens.androidDarkError, DesignTokens.androidDarkSurfaceContainer, .text, 10.435),
        pair("contrast.routeRadio", "Android route radio on the in-call sheet", DesignTokens.androidInCallPrimary, DesignTokens.androidInCallSurfaceContainerLow, .nonText, 7.398),
        pair("contrast.lobbyCaption.ios", "iOS lobby toggle caption on the card strip", DesignTokens.iosInCallTextSecondary, DesignTokens.iosInCallSurface, .text, 9.738),
        pair("contrast.lobbyCaption.android", "Android lobby toggle caption on the card strip", DesignTokens.androidInCallOnSurfaceVariant, DesignTokens.androidInCallSurfaceContainer, .text, 6.913),

        pair("contrast.inCallText.tile", "In-call text on tile (lobby permission overlay)", DesignTokens.iosInCallText, DesignTokens.iosInCallTile, .text, 17.767),

        pair("contrast.bubbleOwn.android", "Own chat bubble text, Android", DesignTokens.androidLightOnPrimaryContainer, DesignTokens.androidLightPrimaryContainer, .text, 6.374),
        pair("contrast.bubblePeer.androidLight", "Peer chat bubble text, Android light", DesignTokens.androidLightOnSurface, DesignTokens.androidLightSurfaceContainerHigh, .text, 15.566),
        pair("contrast.bubblePeer.androidDark", "Peer chat bubble text, Android dark", DesignTokens.androidDarkOnSurface, DesignTokens.androidDarkSurfaceContainerHigh, .text, 15.001),
        pair("contrast.bubbleLink.androidDark", "Link in a peer chat bubble, Android dark", DesignTokens.androidDarkPrimary, DesignTokens.androidDarkSurfaceContainerHigh, .text, 6.246),
        pair("contrast.reactionChip.androidLight", "Reaction chip, Android light", DesignTokens.androidLightOnSurface, DesignTokens.androidLightSurfaceContainerHighest, .text, 15.026),
        pair("contrast.reactionChip.androidDark", "Reaction chip, Android dark", DesignTokens.androidDarkOnSurface, DesignTokens.androidDarkSurfaceContainerHighest, .text, 12.940),
        pair("contrast.tipBody.androidLight", "Tip body, Android light", DesignTokens.androidLightOnSurfaceVariant, DesignTokens.androidLightSurfaceContainerHigh, .text, 6.792),
        pair("contrast.tipBody.androidDark", "Tip body, Android dark", DesignTokens.androidDarkOnSurfaceVariant, DesignTokens.androidDarkSurfaceContainerHigh, .text, 6.109),
        pair("contrast.composerSend.androidLight", "Composer Send glyph, Android light", DesignTokens.androidLightPrimary, DesignTokens.androidLightSurfaceContainerHighest, .nonText, 4.551),
        pair("contrast.composerSend.androidDark", "Composer Send glyph, Android dark", DesignTokens.androidDarkPrimary, DesignTokens.androidDarkSurfaceContainerHighest, .nonText, 5.388),
        pair("contrast.gameBoard.paperOnLight", "Paper text on the light board square", DesignTokens.paper, DesignTokens.iosGameBoardLight, .text, 4.630),
        pair("contrast.gameBoard.paperOnDark", "Paper text on the dark board square", DesignTokens.paper, DesignTokens.iosGameBoardDark, .text, 10.006),

        pair("contrast.gameBoard.squares", "Light board square against the dark square", DesignTokens.iosGameBoardLight, DesignTokens.iosGameBoardDark, .decorative, 2.161),
        pair("contrast.gameBoard.coralPath", "Coral path on the dark board square (graphic)", DesignTokens.coral, DesignTokens.iosGameBoardDark, .nonText, 3.364),
    ]

    private static func pair(_ id: String, _ caption: String, _ foreground: Int64, _ background: Int64,
                             _ requirement: ContrastRequirement, _ expected: Double) -> GalleryContrastPair {
        return GalleryContrastPair(id: id, caption: caption, foreground: foreground, background: background,
                                   requirement: requirement, expectedRatio: expected)
    }
}

struct CompactBarControl: Equatable {
    let id: String
    let width: Double
}

struct CompactBarPlan: Equatable {

    let targetWidth: Double
    let spacing: Double

    let moved: [String]
    let requiredWidth: Double
    let fits: Bool
}

enum CompactBarFit {
    static let iosMinimumTarget = 44.0
    static let iosBaseDiameter = 52.0
    static let iosMaximumDiameter = 60.0

    static let iosPadding = DesignTokens.space12
    static let androidMinimumTarget = 48.0

    static let androidWideToggleWidth = 56.0
    static let androidWideToggleThreshold = 385.0
    static let androidLeaveWidth = 72.0
    static let androidDividerWidth = 1.0
    static let androidPadding = DesignTokens.space8
    static let androidSpacing = DesignTokens.space8

    static let leaveControlID = "leave"

    static func requiredWidth(targets: [Double], spacing: Double, padding: Double, nonTargets: [Double] = []) -> Double {
        var content = 0.0
        for width in targets { content += width }
        for width in nonTargets { content += width }
        let items = targets.count + nonTargets.count
        let gaps = items > 1 ? Double(items - 1) * spacing : 0.0
        return padding * 2.0 + content + gaps
    }

    static func fits(targets: [Double], spacing: Double, padding: Double, available: Double, nonTargets: [Double] = []) -> Bool {
        return requiredWidth(targets: targets, spacing: spacing, padding: padding, nonTargets: nonTargets) <= available
    }

    static func overflow(controls: [CompactBarControl], moveOrder: [String], spacing: Double, padding: Double,
                         available: Double, nonTargets: [Double] = []) -> [String] {
        var remaining = controls
        var moved: [String] = []
        while !fits(targets: widths(remaining), spacing: spacing, padding: padding, available: available, nonTargets: nonTargets) {
            guard let next = nextToMove(moveOrder, among: ids(remaining)) else { break }
            moved.append(next)
            remaining = remaining.filter { $0.id != next }
        }
        return moved
    }

    static func androidToggleWidth(available: Double) -> Double {
        return available >= androidWideToggleThreshold ? androidWideToggleWidth : androidMinimumTarget
    }

    static func iosDiameter(scaled: Double, count: Int, spacing: Double, available: Double) -> Double {
        var diameter = scaled
        if count > 0 {
            let share = (available - 2.0 * iosPadding - Double(count - 1) * spacing) / Double(count)

            let whole = share > 0.0 ? Double(Int(share)) : 0.0
            if whole < diameter { diameter = whole }
        }
        if diameter > iosMaximumDiameter { diameter = iosMaximumDiameter }
        if diameter < iosMinimumTarget { diameter = iosMinimumTarget }
        return diameter
    }

    static func iosPlan(controlIDs: [String], moveOrder: [String], scaledDiameter: Double, available: Double) -> CompactBarPlan {
        var remaining = controlIDs
        var moved: [String] = []
        var attempt = 0
        while attempt <= controlIDs.count {
            attempt += 1
            for spacing in [DesignTokens.space12, DesignTokens.space8] {
                let diameter = iosDiameter(scaled: scaledDiameter, count: remaining.count, spacing: spacing, available: available)
                let required = requiredWidth(targets: repeated(diameter, remaining.count), spacing: spacing, padding: iosPadding)
                if required <= available {
                    return CompactBarPlan(targetWidth: diameter, spacing: spacing, moved: moved, requiredWidth: required, fits: true)
                }
            }
            guard let next = nextToMove(moveOrder, among: remaining) else { break }
            moved.append(next)
            remaining = remaining.filter { $0 != next }
        }
        let diameter = iosDiameter(scaled: scaledDiameter, count: remaining.count, spacing: DesignTokens.space8, available: available)
        let required = requiredWidth(targets: repeated(diameter, remaining.count), spacing: DesignTokens.space8, padding: iosPadding)
        return CompactBarPlan(targetWidth: diameter, spacing: DesignTokens.space8, moved: moved, requiredWidth: required, fits: false)
    }

    static func androidPlan(toggleIDs: [String], moveOrder: [String], available: Double) -> CompactBarPlan {
        let width = androidToggleWidth(available: available)
        var controls: [CompactBarControl] = []
        for id in toggleIDs { controls.append(CompactBarControl(id: id, width: width)) }
        controls.append(CompactBarControl(id: leaveControlID, width: androidLeaveWidth))
        let divider = [androidDividerWidth]
        let moved = overflow(controls: controls, moveOrder: moveOrder, spacing: androidSpacing, padding: androidPadding,
                             available: available, nonTargets: divider)
        var targets: [Double] = []
        for control in controls {
            if !moved.contains(control.id) { targets.append(control.width) }
        }
        let required = requiredWidth(targets: targets, spacing: androidSpacing, padding: androidPadding, nonTargets: divider)
        return CompactBarPlan(targetWidth: width, spacing: androidSpacing, moved: moved, requiredWidth: required, fits: required <= available)
    }

    private static func widths(_ controls: [CompactBarControl]) -> [Double] {
        var result: [Double] = []
        for control in controls { result.append(control.width) }
        return result
    }

    private static func ids(_ controls: [CompactBarControl]) -> [String] {
        var result: [String] = []
        for control in controls { result.append(control.id) }
        return result
    }

    private static func repeated(_ value: Double, _ count: Int) -> [Double] {
        var result: [Double] = []
        var index = 0
        while index < count {
            result.append(value)
            index += 1
        }
        return result
    }

    private static func nextToMove(_ moveOrder: [String], among ids: [String]) -> String? {
        for id in moveOrder {
            if ids.contains(id) { return id }
        }
        return nil
    }
}
