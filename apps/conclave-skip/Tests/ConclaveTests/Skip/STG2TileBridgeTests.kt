package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * STG-2 through the transpiled tile policies (the Swift half is T/STG2TileTests.swift): the tile menu items per role
 * with the Android rule (no Flip item, S20 6 d), the people sections after the stage section without their Pin
 * (RECONCILE R19), disabled items kept with their reason on Android, the shared dispatcher, the camera-on featured
 * speaker and the spotlight main, the pin announcements, the S20 4 rail geometry, the tile overlay decisions and the
 * reconnect reasons, with the same results as Swift. Pure: no composition (PanelStageBridgeTests owns the one
 * composition per JVM).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class STG2TileBridgeTests {
    private val titles = TileMenuTitles(pin = "Pin", unpin = "Unpin", flipCamera = "Flip camera", minimizeSelfView = "Minimize self view",
        showSelfView = "Show self view", showFullVideo = "Show full video", cropToFill = "Crop to fill")

    private fun context(slotId: String = "p:r1", userId: String = "r1", role: StageSlotRole = StageSlotRole.grid,
                        kind: StageKind = StageKind.grid, fit: StageVideoFit = StageVideoFit.fill, local: Boolean = false,
                        pinned: Boolean = false, cameraOff: Boolean = false, canFlip: Boolean = false, offersFlip: Boolean = false) =
        TileMenuContext(slotId = slotId, userId = userId, role = role, kind = kind, fit = fit, isLocal = local, isPinned = pinned,
            isCameraOff = cameraOff, canFlipCamera = canFlip, offersFlipItem = offersFlip)

    private fun item(id: String, title: String, concept: String = "", role: MenuItemRole = MenuItemRole.normal, enabled: Boolean = true,
                     reason: String = "") =
        MenuItemModel(id = id, title = title, concept = concept, role = role, isOn = false, isEnabled = enabled, disabledReason = reason)

    private fun viewport(width: Double, height: Double, top: Double, bottom: Double, widthClass: String = StageSizeClass.compact,
                         heightClass: String = StageSizeClass.regular) =
        StageViewport(width = width, height = height, insetTop = top, insetBottom = bottom, insetLeading = 0.0, insetTrailing = 0.0,
            widthClass = widthClass, heightClass = heightClass, placement = StageChromePlacement.bottomBar)

    private val iphoneSE = viewport(375.0, 667.0, 76.0, 64.0)
    private val android360 = viewport(360.0, 800.0, 84.0, 124.0, heightClass = StageSizeClass.medium)

    private fun items(context: TileMenuContext): List<TileMenuItemId> = TileMenuPolicy.stageItems(context).toList()

    @Test fun tileMenuItemsMatchSwiftWithTheAndroidFlipRule() {
        assertEquals(listOf(TileMenuItemId.pin, TileMenuItemId.showFullVideo), items(context()))
        assertEquals(listOf(TileMenuItemId.unpin, TileMenuItemId.showFullVideo),
            items(context(role = StageSlotRole.spotlightMain, kind = StageKind.spotlight, pinned = true)))
        assertEquals(listOf(TileMenuItemId.pin, TileMenuItemId.cropToFill), items(context(fit = StageVideoFit.fit)))
        assertEquals(listOf(TileMenuItemId.pin), items(context(cameraOff = true)))
        // Your own tile on Android: no Flip item (the top row has Flip).
        assertEquals(listOf(TileMenuItemId.pin, TileMenuItemId.showFullVideo),
            items(context(slotId = "p:you", userId = "you", local = true, canFlip = true)))
        assertEquals(listOf(TileMenuItemId.minimizeSelfView, TileMenuItemId.showFullVideo),
            items(context(slotId = "p:you", userId = "you", role = StageSlotRole.selfFloating, kind = StageKind.oneOnOne, local = true,
                canFlip = true)))
        assertEquals(listOf(TileMenuItemId.showSelfView),
            items(context(slotId = "p:you", userId = "you", role = StageSlotRole.selfMinimized, kind = StageKind.oneOnOne, local = true)))
        // iOS rule through the same policy.
        assertEquals(listOf(TileMenuItemId.pin, TileMenuItemId.flipCamera, TileMenuItemId.showFullVideo),
            items(context(slotId = "p:you", userId = "you", local = true, canFlip = true, offersFlip = true)))
        assertTrue(items(context(slotId = "share:r1", role = StageSlotRole.share, kind = StageKind.presentation)).isEmpty())
        assertTrue(items(context(role = StageSlotRole.programFeed, kind = StageKind.attendeeLive)).isEmpty())
        assertTrue(items(context(slotId = "p:you", userId = "you", role = StageSlotRole.spotlightMain, kind = StageKind.solo, local = true,
            cameraOff = true)).isEmpty())
    }

    @Test fun sectionsKeepTheStageFirstAndAndroidKeepsDisabledItems() {
        val reason = "Unavailable while reconnecting"
        val people = skip.lib.Array(listOf(
            MenuSectionModel(id = "ppl.1", items = skip.lib.Array(listOf(item("mute", "Mute", concept = "mute_person", enabled = false,
                reason = reason)))),
            MenuSectionModel(id = "ppl.0", items = skip.lib.Array(listOf(item("pin", "Pin", concept = "pin"),
                item("message", "Send private message", concept = "chat")))),
            MenuSectionModel(id = "ppl.3", items = skip.lib.Array(listOf(item("remove", "Remove from meeting…",
                concept = "remove_person", role = MenuItemRole.destructive)))),
        ))
        val sections = TileMenuPolicy.sections(context(), titles = titles, people = people)
        assertEquals(listOf(TileMenuPolicy.stageSectionId, "ppl.1", "ppl.0", "ppl.3"), sections.toList().map { it.id })
        assertEquals(listOf("message"), sections[2].items.toList().map { it.id })
        assertEquals(reason, sections[1].items[0].disabledReason)
        assertTrue(ConclaveMenuPolicy.destructiveItemsAreLast(sections))
        for (section in sections) assertTrue(section.id, ConclaveMenuPolicy.isIconConsistent(section))
        // The iOS context menu hides the disabled item; actions skip it on both platforms.
        assertEquals(listOf(TileMenuPolicy.stageSectionId, "ppl.0", "ppl.3"),
            TileMenuPolicy.contextMenuSections(sections).toList().map { it.id })
        assertEquals(listOf("pin", "showFullVideo", "message", "remove"), TileMenuPolicy.accessibilityItems(sections).toList().map { it.id })
        // The Android helper builds the same menu.
        val menu = stageTileMenu(StageSlot(id = "p:r1", role = StageSlotRole.grid, userId = "r1", fit = StageVideoFit.fill),
            TileChromeModel(userId = "r1", displayName = "Avery", avatarSeed = "Avery:r1", isLocal = false, isMuted = false,
                isCameraOff = false, isHandRaised = false, isPinned = false, isPresenting = false, isWeakConnection = false,
                isReconnecting = false, reconnectReason = "", isHost = false, isVoiceAgent = false),
            StageKind.grid, titles)
        assertTrue(menu.hasItems)
        assertEquals(listOf("pin", "showFullVideo"), menu.actionItems.map { it.id })
    }

    @Test fun dispatcherSendsCommandsAndWritesTheFit() {
        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.setViewport(iphoneSE)
        stage.apply(StageFixtureScript.inputs(StageFixtureState.grid6))
        val commands = mutableListOf<StageCommand>()
        stage.onCommand = { command -> commands.add(command) }
        var slot: StageSlot? = null
        for (candidate in stage.layout.slots) if (candidate.id == "p:r1") slot = candidate
        val menu = TileMenuContext.make(slot = slot!!, model = stage.tileChrome.entry("r1").model, kind = stage.kind,
            canFlipCamera = false, offersFlipItem = false)
        assertTrue(TileMenuDispatcher.perform("pin", context = menu, stage = stage))
        assertEquals(StageCommandKind.togglePin, commands.last().kind)
        assertEquals("r1", commands.last().userId)
        assertTrue(TileMenuDispatcher.perform("unpin", context = menu, stage = stage))
        assertEquals(StageCommandKind.clearPin, commands.last().kind)
        assertTrue(TileMenuDispatcher.perform("minimizeSelfView", context = menu, stage = stage))
        assertEquals("minimized", commands.last().value)
        assertTrue(TileMenuDispatcher.perform("showSelfView", context = menu, stage = stage))
        assertEquals("floating", commands.last().value)
        val count = commands.size
        assertTrue(TileMenuDispatcher.perform("showFullVideo", context = menu, stage = stage))
        var fit: StageVideoFit? = null
        for (candidate in stage.layout.slots) if (candidate.id == "p:r1") fit = candidate.fit
        assertEquals(StageVideoFit.fit, fit)
        assertFalse(TileMenuDispatcher.perform("mute", context = menu, stage = stage))
        assertEquals(count, commands.size)
    }

    @Test fun featuredSpeakerAndSpotlightMainMatchSwift() {
        val roster = skip.lib.Array(listOf(
            StageParticipantInput.make(userId = "you", displayName = "You", isLocal = true, isCameraOff = false),
            StageParticipantInput.make(userId = "r1", displayName = "Avery", isCameraOff = false, joinSerial = 1),
            StageParticipantInput.make(userId = "r2", displayName = "Ben", isCameraOff = true, joinSerial = 2),
            StageParticipantInput.make(userId = "r3", displayName = "Cai", isCameraOff = false, joinSerial = 3),
        ))
        assertEquals("r3", TileFeaturePolicy.spotlightCandidate(speakerUserId = "r3", featuredUserId = "r1", pinnedUserId = "", participants = roster))
        assertEquals("", TileFeaturePolicy.spotlightCandidate(speakerUserId = "r2", featuredUserId = "r1", pinnedUserId = "", participants = roster))
        assertEquals("", TileFeaturePolicy.spotlightCandidate(speakerUserId = "you", featuredUserId = "r1", pinnedUserId = "", participants = roster))
        assertEquals("", TileFeaturePolicy.spotlightCandidate(speakerUserId = "r3", featuredUserId = "r1", pinnedUserId = "r2", participants = roster))
        val audioOnly = StageFixtureScript.roster(count = 4, remoteCamerasOn = false)
        assertEquals("r2", TileFeaturePolicy.spotlightCandidate(speakerUserId = "r2", featuredUserId = "r1", pinnedUserId = "", participants = audioOnly))
        val order = skip.lib.Array(listOf("r2", "r3", "r1"))
        assertEquals("r3", TileFeaturePolicy.spotlightMainUserId(pinnedUserId = "", featuredUserId = "r2", remoteOrder = order,
            participants = roster, localUserId = "you"))
        assertEquals("r2", TileFeaturePolicy.spotlightMainUserId(pinnedUserId = "r2", featuredUserId = "r3", remoteOrder = order,
            participants = roster, localUserId = "you"))
        assertEquals("you", TileFeaturePolicy.spotlightMainUserId(pinnedUserId = "", featuredUserId = "", remoteOrder = skip.lib.Array(listOf<String>()),
            participants = roster, localUserId = "you"))
    }

    @Test fun pinAnnouncementsMatchSwift() {
        val base = StageFixtureScript.base(count = 6)
        val pinnedBen = StageFixtureScript.copy(base, pinnedUserId = "r2")
        val pinned = TileFeaturePolicy.pinAnnouncement(previous = base, next = pinnedBen)
        assertEquals(TileFeaturePolicy.pinnedKind, pinned.kind)
        assertEquals("Ben", pinned.name)
        assertEquals("", TileFeaturePolicy.pinAnnouncement(previous = pinnedBen, next = base).kind)
        val withoutBen = mutableListOf<StageParticipantInput>()
        for (row in StageFixtureScript.roster(count = 6)) if (row.userId != "r2") withoutBen.add(row)
        val left = StageFixtureScript.copy(pinnedBen, participants = skip.lib.Array(withoutBen))
        val cleared = TileFeaturePolicy.pinAnnouncement(previous = pinnedBen, next = left)
        assertEquals(TileFeaturePolicy.pinClearedKind, cleared.kind)
        assertEquals("Ben", cleared.name)
        assertEquals("", TileFeaturePolicy.pinAnnouncement(previous = left, next = StageFixtureScript.copy(left, pinnedUserId = "")).kind)
        assertEquals("", TileFeaturePolicy.pinAnnouncement(previous = StageInputs.make(), next = pinnedBen).kind)
    }

    @Test fun railGeometryAndOverlayDecisionsMatchSwift() {
        for (size in listOf(iphoneSE, android360)) {
            assertTrue(SpotlightRailPolicy.isStrip(size))
            assertEquals(80.0, SpotlightRailPolicy.tileWidth(size), 0.001)
            assertEquals(107.0, SpotlightRailPolicy.tileHeight(size), 0.001)
            assertEquals(4, SpotlightRailPolicy.capacity(viewport = size))
        }
        val landscape = stageViewportFrom(width = 800.0, height = 360.0, top = 24.0, bottom = 0.0, leading = 0.0, trailing = 48.0)
        assertFalse(SpotlightRailPolicy.isStrip(landscape))
        assertEquals(160.0, SpotlightRailPolicy.tileWidth(landscape), 0.001)
        assertEquals(90.0, SpotlightRailPolicy.tileHeight(landscape), 0.001)
        val tablet = stageViewportFrom(width = 1280.0, height = 800.0, top = 24.0, bottom = 48.0, leading = 0.0, trailing = 0.0)
        assertEquals(200.0, SpotlightRailPolicy.tileWidth(tablet), 0.001)
        assertEquals(0, SpotlightRailPolicy.capacity(viewport = StageViewport.zero))

        val pinnedModel = TileChromeModel(userId = "r1", displayName = "Avery", avatarSeed = "Avery:r1", isLocal = false, isMuted = false,
            isCameraOff = false, isHandRaised = false, isPinned = true, isPresenting = true, isWeakConnection = true, isReconnecting = false,
            reconnectReason = "", isHost = false, isVoiceAgent = false)
        // 48 dp target centered on the pinned badge with two badges after it: 8 + 2 x 28 + 12 - 24.
        assertEquals(52.0, TileFeaturePolicy.unpinTargetTrailingInset(model = pinnedModel, density = TileChromeDensity.spotlight,
            targetSize = TileFeaturePolicy.unpinTargetAndroid), 0.001)
        assertEquals(0.0, TileFeaturePolicy.unpinTargetTopInset(density = TileChromeDensity.spotlight,
            targetSize = TileFeaturePolicy.unpinTargetAndroid), 0.001)
        assertTrue(TileFeaturePolicy.showsUnpinTarget(role = StageSlotRole.spotlightMain, isPinned = true, isShare = false))
        assertFalse(TileFeaturePolicy.showsUnpinTarget(role = StageSlotRole.rail, isPinned = true, isShare = false))
        assertTrue(TileFeaturePolicy.showsOneOnOneCaption(kind = StageKind.oneOnOne, role = StageSlotRole.spotlightMain, isLocal = false,
            isCameraOff = true))
        assertFalse(TileFeaturePolicy.showsOneOnOneCaption(kind = StageKind.spotlight, role = StageSlotRole.spotlightMain, isLocal = false,
            isCameraOff = true))
        assertEquals("timeout", TileFeaturePolicy.reconnectReasonKind("ping timeout"))
        assertEquals("network", TileFeaturePolicy.reconnectReasonKind("transport close"))
        assertEquals("interrupted", TileFeaturePolicy.reconnectReasonKind(""))
        assertEquals(4500.0, TileFeaturePolicy.backOnlineMillis, 0.001)
        assertEquals(TileMenuPolicy.menuTransientId, "tile.menu")
    }
}
