#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SYS3NotificationsTests {
    private static let room = "lily-zoro-iris"

    @MainActor
    final class RecordingCenter {
        var requests: [String] = []
        var refreshes = 0
        var posted: [LocalNotificationRequest] = []
        var removed: [String] = []
        var opened: [String] = []

        func center() -> LocalNotificationCenter {
            LocalNotificationCenter(
                name: "recording",
                requestAuthorization: { [weak self] reason in self?.requests.append(reason) },
                refreshStatus: { [weak self] in self?.refreshes += 1 },
                post: { [weak self] request in self?.posted.append(request) },
                removeDelivered: { [weak self] roomId, identifiers in
                    self?.removed.append(roomId + ":" + identifiers.joined(separator: ","))
                },
                openSystemSettings: { [weak self] channel in self?.opened.append(channel) }
            )
        }
    }

    private func freshDefaults() -> UserDefaults {
        let suite = "sys3-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite) ?? UserDefaults.standard
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func make(android: Bool, defaults: UserDefaults? = nil) -> (SystemNotifications, RecordingCenter) {
        let presenter = SystemNotifications(isAndroid: android, defaults: defaults ?? freshDefaults())
        let recorder = RecordingCenter()
        presenter.install(center: recorder.center())
        return (presenter, recorder)
    }

    private func androidReading(api: Int = 35, granted: Bool = false, appEnabled: Bool = true, rationale: Bool = false,
                                callChannel: Bool = true, admission: Bool = true, messages: Bool = true) -> NotificationStatusReading {
        NotificationStatusReading.make(apiLevel: api, permissionGranted: granted, appNotificationsEnabled: appEnabled,
                                       showsRationale: rationale, callChannelEnabled: callChannel,
                                       admissionChannelEnabled: admission, messagesChannelEnabled: messages)
    }

    private func liveInputs(session: Int = 1, active: Bool = true, entering: Bool = false, pip: Bool = false,
                            native: Bool = true, chatVisible: Bool = false, attendee: Bool = false,
                            roomId: String = SYS3NotificationsTests.room) -> SystemNotificationInputs {
        SystemNotificationInputs.make(callSession: session, presenceSession: session + 10, roomId: roomId, roomLabel: roomId,
                                      isLive: true, isEntering: entering, isInPictureInPicture: pip, isAppActive: active,
                                      isChatVisible: chatVisible, isAttendee: attendee, usesNativeStage: native,
                                      nativeRoutesActive: true)
    }

    @Test func permissionStateTableFollowsS70Section2d() {
        #expect(NotificationPermissionStatePolicy.state(granted: false, asked: false, rationale: false) == .notDetermined)
        #expect(NotificationPermissionStatePolicy.state(granted: false, asked: true, rationale: true) == .denied)
        #expect(NotificationPermissionStatePolicy.state(granted: false, asked: true, rationale: false) == .permanentlyDenied)
        #expect(NotificationPermissionStatePolicy.state(granted: true, asked: false, rationale: false) == .granted)

        #expect(NotificationPermissionStatePolicy.androidState(apiLevel: 32, permissionGranted: false, appNotificationsEnabled: true,
                                                               asked: false, rationale: false) == .granted)
        #expect(NotificationPermissionStatePolicy.androidState(apiLevel: 32, permissionGranted: true, appNotificationsEnabled: false,
                                                               asked: false, rationale: false) == .permanentlyDenied)
        #expect(NotificationPermissionStatePolicy.androidState(apiLevel: 35, permissionGranted: true, appNotificationsEnabled: false,
                                                               asked: true, rationale: false) == .permanentlyDenied)
        #expect(NotificationPermissionStatePolicy.iosState(authorization: "notDetermined") == .notDetermined)
        #expect(NotificationPermissionStatePolicy.iosState(authorization: "authorized") == .granted)
        #expect(NotificationPermissionStatePolicy.iosState(authorization: "provisional") == .granted)
        #expect(NotificationPermissionStatePolicy.iosState(authorization: "denied") == .denied)

        #expect(NotificationPermissionStatePolicy.canRequest(.denied, isAndroid: true))
        #expect(!NotificationPermissionStatePolicy.canRequest(.denied, isAndroid: false))
        #expect(!NotificationPermissionStatePolicy.canRequest(.permanentlyDenied, isAndroid: true))
        #expect(NotificationPermissionStatePolicy.offersOpenSettings(.permanentlyDenied, isAndroid: true))
        #expect(NotificationPermissionStatePolicy.offersOpenSettings(.denied, isAndroid: false))
        #expect(!NotificationPermissionStatePolicy.offersOpenSettings(.notDetermined, isAndroid: false))
        #expect(NotificationPermissionStatePolicy.settingsPermission(.permanentlyDenied) == .denied)
        #expect(NotificationPermissionStatePolicy.askedPreferenceKey == "conclave.pref.notificationsPermissionAsked")
    }

    @Test func aDroppedRequestLeavesAskedFalseAndAnAnswerWritesIt() {
        let defaults = freshDefaults()
        let (presenter, recorder) = make(android: true, defaults: defaults)
        presenter.statusRead(androidReading())
        #expect(presenter.snapshot.permission == .notDetermined)
        presenter.requestPermission(reason: .call)
        #expect(recorder.requests == ["call"])

        presenter.permissionAnswered(granted: false, answered: false)
        #expect(!NotificationPreferences.permissionAsked(defaults: defaults))
        presenter.statusRead(androidReading())
        #expect(presenter.snapshot.permission == .notDetermined)

        presenter.requestPermission(reason: .messages)
        presenter.permissionAnswered(granted: false, answered: true)
        #expect(NotificationPreferences.permissionAsked(defaults: defaults))
        presenter.statusRead(androidReading(rationale: true))
        #expect(presenter.snapshot.permission == .denied)
        presenter.statusRead(androidReading(rationale: false))
        #expect(presenter.snapshot.permission == .permanentlyDenied)
        #expect(presenter.snapshot.offersOpenSettings)
        #expect(presenter.snapshot.settingsPermission == .denied)
    }

    @Test func primingBannerShowsOnlyAfterStageEntryOncePerProcess() {
        let (presenter, recorder) = make(android: true)
        presenter.statusRead(androidReading())
        presenter.apply(liveInputs(session: 1, entering: true))
        #expect(!presenter.snapshot.showsPrimingBanner, "never during the entry")
        presenter.apply(liveInputs(session: 1))
        #expect(!presenter.snapshot.showsPrimingBanner, "not before stageEntryFinished")
        presenter.stageEntryFinished()
        #expect(presenter.snapshot.showsPrimingBanner)
        presenter.apply(liveInputs(session: 1, pip: true))
        #expect(!presenter.snapshot.showsPrimingBanner, "never in PiP")
        presenter.apply(liveInputs(session: 1))
        #expect(presenter.snapshot.showsPrimingBanner)
        presenter.dismissPriming()
        #expect(!presenter.snapshot.showsPrimingBanner, "Not now keeps it away for the session")

        presenter.apply(SystemNotificationInputs.none)
        presenter.apply(liveInputs(session: 2))
        presenter.stageEntryFinished()
        #expect(!presenter.snapshot.showsPrimingBanner)
        #expect(recorder.requests.isEmpty)
    }

    @Test func allowRequestsOnceAndTheBannerLeaves() {
        var changes = 0
        let (presenter, recorder) = make(android: true)
        presenter.onChange = { changes += 1 }
        presenter.statusRead(androidReading())
        presenter.apply(liveInputs())
        presenter.stageEntryFinished()
        #expect(presenter.snapshot.showsPrimingBanner)
        presenter.requestPermission(reason: .call)
        presenter.requestPermission(reason: .call)
        #expect(recorder.requests == ["call"], "one system request")
        #expect(!presenter.snapshot.showsPrimingBanner)
        presenter.permissionAnswered(granted: true, answered: true)
        presenter.statusRead(androidReading(granted: true))
        #expect(presenter.snapshot.permission == .granted)
        #expect(!presenter.snapshot.showsPrimingBanner)
        #expect(changes > 0, "platform answers reach the core")
    }

    @Test func primingWaitsOutARecoveryInTheSameSession() {
        let (presenter, _) = make(android: true)
        presenter.statusRead(androidReading())
        presenter.apply(liveInputs(session: 3))
        presenter.stageEntryFinished()
        #expect(presenter.snapshot.showsPrimingBanner)
        presenter.apply(SystemNotificationInputs.make(callSession: 3, presenceSession: 13, roomId: Self.room, roomLabel: Self.room,
                                                      isRecovering: true, usesNativeStage: true, nativeRoutesActive: true))
        #expect(!presenter.snapshot.showsPrimingBanner, "only in a live call")
        presenter.apply(liveInputs(session: 3))
        #expect(presenter.snapshot.showsPrimingBanner, "the same session keeps its stage entry")
    }

    @Test func primingPolicyRows() {
        let base = NotificationPrimingInputs.make(isAndroid: true, apiLevel: 35, hasReadStatus: true, permission: .notDetermined,
                                                  usesNativeStage: true, isLive: true, stageEntryFinished: true)
        #expect(NotificationPrimingPolicy.showsBanner(base))
        #expect(!NotificationPrimingPolicy.showsBanner(NotificationPrimingInputs.make(isAndroid: true, apiLevel: 32, hasReadStatus: true,
            permission: .notDetermined, usesNativeStage: true, isLive: true, stageEntryFinished: true)), "API 32: implicit grant")
        #expect(!NotificationPrimingPolicy.showsBanner(NotificationPrimingInputs.make(isAndroid: false, apiLevel: 35, hasReadStatus: true,
            permission: .notDetermined, usesNativeStage: true, isLive: true, stageEntryFinished: true)), "iOS has no banner")
        #expect(NotificationPrimingPolicy.showsBanner(NotificationPrimingInputs.make(isAndroid: true, apiLevel: 35, hasReadStatus: true,
            permission: .denied, usesNativeStage: true, isLive: true, stageEntryFinished: true)), "denied once: a new process asks again")
        #expect(!NotificationPrimingPolicy.showsBanner(NotificationPrimingInputs.make(isAndroid: true, apiLevel: 35, hasReadStatus: true,
            permission: .permanentlyDenied, usesNativeStage: true, isLive: true, stageEntryFinished: true)))
        #expect(!NotificationPrimingPolicy.showsBanner(NotificationPrimingInputs.make(isAndroid: true, apiLevel: 35, hasReadStatus: true,
            permission: .notDetermined, usesNativeStage: false, isLive: true, stageEntryFinished: true)), "legacy root keeps its prompt")
        #expect(NotificationPrimingPolicy.usesLegacyPrompt(isAndroid: true, usesNativeStage: false))
        #expect(!NotificationPrimingPolicy.usesLegacyPrompt(isAndroid: true, usesNativeStage: true))
        #expect(!NotificationPrimingPolicy.usesLegacyPrompt(isAndroid: false, usesNativeStage: false))
    }

    @Test func iosRowAndToggleRequestOnceAndReadOnOnlyWhenGranted() {
        #expect(LocalNotificationPostPolicy.authorizationOptions == ["alert", "sound"], "no badge")
        let (presenter, recorder) = make(android: false)
        presenter.statusRead(NotificationStatusReading.make(authorization: "notDetermined"))
        #expect(!presenter.snapshot.messageNotificationsOn, "not determined reads Off although the default is on")
        #expect(presenter.snapshot.messageNotificationsPreference)
        presenter.setMessageNotifications(true)
        presenter.setMessageNotifications(true)
        #expect(recorder.requests == ["messages"], "one tap, exactly one request")
        presenter.permissionAnswered(granted: false, answered: true)
        presenter.statusRead(NotificationStatusReading.make(authorization: "denied"))
        #expect(!presenter.snapshot.messageNotificationsOn)
        #expect(presenter.snapshot.offersOpenSettings)
        presenter.setAdmissionNotify(true)
        #expect(recorder.requests == ["messages"], "iOS never asks twice")
        presenter.openSystemSettings(channel: "")
        #expect(recorder.opened == [""])
    }

    @Test func waitingRowRequestsOnceAndReadsOnWhenGranted() {
        let (presenter, recorder) = make(android: false)
        presenter.statusRead(NotificationStatusReading.make(authorization: "notDetermined"))
        #expect(!presenter.snapshot.admissionNotifyOn)
        presenter.setAdmissionNotify(true)
        #expect(recorder.requests == ["admission"])
        #expect(presenter.snapshot.isRequesting)
        presenter.permissionAnswered(granted: true, answered: true)
        presenter.statusRead(NotificationStatusReading.make(authorization: "authorized"))
        #expect(presenter.snapshot.admissionNotifyOn)
        #expect(!presenter.snapshot.isRequesting)
    }

    @Test func admissionPostsOnlyWhileInactiveWithTheRoomThread() {
        let (presenter, recorder) = make(android: false)
        presenter.statusRead(NotificationStatusReading.make(authorization: "authorized"))
        presenter.setAdmissionNotify(true)
        presenter.apply(SystemNotificationInputs.make(callSession: 4, presenceSession: 7, roomId: Self.room, roomLabel: Self.room,
                                                      isWaiting: true, isAppActive: true, nativeRoutesActive: true))
        presenter.admittedWhileBackgrounded(roomLabel: Self.room)
        #expect(recorder.posted.isEmpty, "an admission while active posts nothing")
        presenter.apply(SystemNotificationInputs.make(callSession: 4, presenceSession: 7, roomId: Self.room, roomLabel: Self.room,
                                                      isWaiting: true, isAppActive: false, nativeRoutesActive: true))
        presenter.admittedWhileBackgrounded(roomLabel: Self.room)
        #expect(recorder.posted.count == 1)
        let request = recorder.posted.first
        #expect(request?.kind == .admission)
        #expect(request?.identifier == "admitted.4")
        #expect(request?.threadIdentifier == "meeting." + Self.room)
        #expect(request?.channelId == "conclave_admission")
        #expect(request?.presenceSession == 7)
        #expect(request?.roomLabel == Self.room)

        presenter.apply(SystemNotificationInputs.make(callSession: 4, presenceSession: 7, roomId: Self.room, roomLabel: Self.room,
                                                      isConnecting: true, isAppActive: false, nativeRoutesActive: true))
        #expect(recorder.removed.isEmpty)
        presenter.apply(SystemNotificationInputs.make(callSession: 4, presenceSession: 7, roomId: Self.room, roomLabel: Self.room,
                                                      isLive: true, isAppActive: true, nativeRoutesActive: true))
        #expect(recorder.removed.contains(Self.room + ":admitted.4"))
    }

    @Test func theLegacyRootsPostNothingAndRecoveryKeepsTheRoom() {
        let (presenter, recorder) = make(android: true)
        presenter.statusRead(androidReading(granted: true))

        presenter.apply(SystemNotificationInputs.make(callSession: 1, presenceSession: 2, roomId: Self.room, roomLabel: Self.room,
                                                      isLive: true, isAppActive: false))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m1", senderId: "a", text: "x", isPrivate: true))
        presenter.admittedWhileBackgrounded(roomLabel: Self.room)
        #expect(recorder.posted.isEmpty)
        #expect(!LocalNotificationPostPolicy.postsForRoutes(nativeRoutesActive: false))

        presenter.apply(liveInputs(active: false))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m2", senderId: "a", text: "y", isPrivate: true))
        #expect(recorder.posted.count == 1)
        presenter.apply(SystemNotificationInputs.make(callSession: 1, presenceSession: 11, roomId: Self.room, roomLabel: Self.room,
                                                      isRecovering: true, isAppActive: false, nativeRoutesActive: true))
        #expect(recorder.removed.isEmpty)
        presenter.apply(SystemNotificationInputs.none)
        #expect(recorder.removed == [Self.room + ":chat.m2"])
    }

    @Test func iosAdmissionNeedsTheRowAndAndroidNeedsNone() {
        #expect(!LocalNotificationPostPolicy.postsAdmission(isAndroid: false, isAppActive: false, permission: .granted,
                                                            admissionNotifyOn: false, channelEnabled: true))
        #expect(LocalNotificationPostPolicy.postsAdmission(isAndroid: true, isAppActive: false, permission: .granted,
                                                           admissionNotifyOn: false, channelEnabled: true))
        #expect(!LocalNotificationPostPolicy.postsAdmission(isAndroid: true, isAppActive: false, permission: .granted,
                                                            admissionNotifyOn: false, channelEnabled: false), "a blocked channel")
        #expect(!LocalNotificationPostPolicy.postsAdmission(isAndroid: true, isAppActive: false, permission: .denied,
                                                            admissionNotifyOn: true, channelEnabled: true))
    }

    @Test func privateMessagesAndMentionsPostAndRoomMessagesDoNot() {
        let (presenter, recorder) = make(android: true)
        presenter.statusRead(androidReading(granted: true))
        presenter.apply(liveInputs(active: false))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m1", senderId: "a", senderName: "Avery", text: "hi", isPrivate: true))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m2", senderId: "b", senderName: "Blake", text: "@you", isMention: true))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m3", senderId: "c", senderName: "Casey", text: "room hello"))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m4", senderId: "me", senderName: "Me", text: "mine",
                                                               isPrivate: true, isFromSelf: true))
        #expect(recorder.posted.map { $0.identifier } == ["chat.m1", "chat.m2"])
        #expect(recorder.posted.map { $0.kind } == [.privateMessage, .mention])
        #expect(recorder.posted.allSatisfy { $0.channelId == "conclave_messages" })

        presenter.apply(liveInputs(active: false, chatVisible: true))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m5", senderId: "a", text: "x", isPrivate: true))
        presenter.apply(liveInputs(active: true))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m6", senderId: "a", text: "x", isPrivate: true))
        presenter.apply(liveInputs(active: false, attendee: true))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m7", senderId: "a", text: "x", isPrivate: true))
        presenter.apply(liveInputs(active: false))
        presenter.setMessageNotifications(false)
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m8", senderId: "a", text: "x", isPrivate: true))
        #expect(recorder.posted.count == 2)

        presenter.setMessageNotifications(true)
        presenter.apply(liveInputs(active: false, pip: true, chatVisible: true))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m9", senderId: "a", text: "x", isPrivate: true))
        #expect(recorder.posted.count == 3)
    }

    @Test func tenMessagesFromTwoSendersShareOneRoomNotification() {
        let (presenter, recorder) = make(android: true)
        presenter.statusRead(androidReading(granted: true))
        presenter.apply(liveInputs(active: false))
        let senders = ["a", "a", "a", "b", "b", "a", "a", "b", "b", "b"]
        for (index, sender) in senders.enumerated() {
            presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m\(index)", senderId: sender, senderName: sender,
                                                                   text: "line \(index)", isPrivate: true))
        }
        #expect(recorder.posted.count == 10)

        #expect(Set(recorder.posted.map { $0.threadIdentifier }) == ["meeting." + Self.room])
        #expect(LocalNotificationPostPolicy.messagesNotificationId != LocalNotificationPostPolicy.admissionNotificationId)

        #expect(recorder.posted.map { $0.alertsOnce } == [false, true, true, false, true, false, true, false, true, true])
    }

    @Test func chatOpenAndCallEndRemoveTheRoomsNotifications() {
        let (presenter, recorder) = make(android: false)
        presenter.statusRead(NotificationStatusReading.make(authorization: "authorized"))
        presenter.apply(liveInputs(active: false))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m1", senderId: "a", text: "x", isPrivate: true))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m2", senderId: "a", text: "y", isPrivate: true))
        presenter.apply(liveInputs(active: true, chatVisible: true))
        #expect(recorder.removed.contains(Self.room + ":chat.m1,chat.m2"))
        presenter.apply(liveInputs(active: false))
        presenter.chatMessageForYou(LocalChatMessageInput.make(messageId: "m3", senderId: "a", text: "z", isPrivate: true))
        presenter.apply(SystemNotificationInputs.none)
        #expect(recorder.removed.last == Self.room + ":chat.m3", "the call ended")
    }

    @Test func mentionsAndBodiesFollowTheChatRules() {
        #expect(LocalNotificationPostPolicy.mentionsYou(text: "hey @averylee look", localName: "Avery Lee"))
        #expect(LocalNotificationPostPolicy.mentionsYou(text: "@averylee.", localName: "Avery Lee"))
        #expect(!LocalNotificationPostPolicy.mentionsYou(text: "email averylee@example.com", localName: "Avery Lee"))
        #expect(!LocalNotificationPostPolicy.mentionsYou(text: "hey @blake", localName: "Avery Lee"))
        #expect(!LocalNotificationPostPolicy.mentionsYou(text: "@averylee", localName: ""))
        #expect(LocalNotificationPostPolicy.messageKind(isPrivate: false, isMention: false) == nil)
        #expect(LocalNotificationPostPolicy.messageKind(isPrivate: true, isMention: true) == .privateMessage)
        let photo = ChatMessage(id: "p1", userId: "u1", displayName: "Avery", content: "IMG_1.jpg",
                                image: ChatImageAttachment(id: "img1", url: "https://x/IMG_1.jpg", fileName: "IMG_1.jpg",
                                                           mimeType: "image/jpeg", size: 1024),
                                isDirect: true)
        let input = LocalChatMessageInput.from(message: photo, localName: "Blake", isFromSelf: false)
        #expect(input.text.isEmpty, "a photo never shows its file name")
        #expect(input.bodyKind == "photo")
        #expect(input.isPrivate)
        let assistant = ChatMessage(id: "a1", userId: ConclaveAssistantChatIdentity.userId, displayName: "Conclave AI", content: "@blake done")
        #expect(LocalChatMessageInput.from(message: assistant, localName: "Blake", isFromSelf: false).isAssistant)
    }

    @Test func aTapIsHeldUntilTheCoreInstallsItsHandler() {
        let (presenter, _) = make(android: false)
        let tap = LocalNotificationTap.from(kind: "privateMessage", roomId: Self.room, messageId: "m1", callSession: 2, presenceSession: 9)
        #expect(tap != nil)
        #expect(LocalNotificationTap.from(kind: "nope", roomId: "", messageId: "", callSession: 0, presenceSession: 0) == nil)
        if let tap { presenter.notificationTapped(tap) }
        #expect(presenter.pendingTap?.messageId == "m1")
        var received: [LocalNotificationTap] = []
        presenter.onTap = { received.append($0) }
        #expect(presenter.takePendingTap()?.presenceSession == 9)
        #expect(presenter.pendingTap == nil)
        if let tap { presenter.notificationTapped(tap) }
        #expect(received.count == 1)
        #expect(LocalNotificationTap.presenceSessionKey == "conclave.presenceSession", "the call notification's extra key")
    }

    @Test func applyNeverCallsTheCoreBack() {
        var changes = 0
        let (presenter, recorder) = make(android: true)
        presenter.onChange = { changes += 1 }
        presenter.apply(liveInputs(active: false))
        presenter.apply(liveInputs(active: true))
        #expect(changes == 0)
        #expect(recorder.refreshes >= 2, "install and the foreground return re-read the status")
        presenter.statusRead(androidReading())
        #expect(changes == 1)
        presenter.statusRead(androidReading())
        #expect(changes == 1, "an unchanged reading is not a change")
    }

    @Test func waitingRowCapabilityFollowsO3() {
        #expect(!AdmissionNotifyCapability.waitingRoomCellPassed, "the O3 cell has not run")
        #expect(!AdmissionNotifyCapability.offersRow(isAndroid: false, cellPassed: false, isWaiting: true, isPromotion: false))
        #expect(AdmissionNotifyCapability.offersRow(isAndroid: false, cellPassed: true, isWaiting: true, isPromotion: false))
        #expect(!AdmissionNotifyCapability.offersRow(isAndroid: true, cellPassed: true, isWaiting: true, isPromotion: false))
        #expect(!AdmissionNotifyCapability.offersRow(isAndroid: false, cellPassed: true, isWaiting: false, isPromotion: false))
        #expect(!AdmissionNotifyCapability.offersRow(isAndroid: false, cellPassed: true, isWaiting: true, isPromotion: true))
    }

    @Test func theIOSAdapterFollowsTheSpec() throws {
        let ios = try sys3Source("Sources/Conclave/Core/Call/LocalNotifications+iOS.swift")
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(ios.contains("requestAuthorization(options: [.alert, .sound])"))
        #expect(!ios.contains(".badge"))
        #expect(!ios.contains("summaryArgument"), "deprecated and ignored since iOS 15")
        #expect(ios.contains("content.interruptionLevel = .active"))
        #expect(!ios.contains("timeSensitive"))
        #expect(ios.contains("content.threadIdentifier = request.threadIdentifier"))
        #expect(ios.contains("UIApplication.openNotificationSettingsURLString"))
        #expect(ios.contains("UNUserNotificationCenter.current().delegate = shared"))
        #expect(sys3Flat(ios).contains("willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [] }"))
        #expect(ios.contains("guard UIApplication.shared.applicationState != .active else { return }"))
        let rows = try sys3Source("Sources/Conclave/Features/Lobby/NotificationRows+iOS.swift")
        #expect(rows.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(rows.contains("Toggle(ConclaveStrings.text(\"Notify Me When I’m Let In\"), isOn: isOn)"))
        #expect(rows.contains("Toggle(ConclaveStrings.text(\"Message Notifications\"), isOn: isOn)"))
        #expect(!rows.contains(".tint(.green)"), "the system green toggle, untinted (R06)")
        let lobby = try sys3Source("Sources/Conclave/Features/Lobby/LobbyView+iOS.swift")
        #expect(lobby.contains("AdmissionNotifySection(premeeting: premeeting)"))
    }

    @Test func theDelegateIsInstalledFromOnInit() throws {

        let app = try sys3Source("Sources/Conclave/ConclaveApp.swift")
        let start = try #require(app.range(of: "public func onInit() {"))
        let end = try #require(app.range(of: "public func onLaunch() {", range: start.upperBound..<app.endIndex))
        let body = String(app[start.lowerBound..<end.lowerBound])
        #expect(body.contains("LocalNotificationDelegate.install()"))
    }

    @Test func theAndroidBridgeFollowsTheSpec() throws {
        let bridge = sys3Flat(try sys3Source("Sources/Conclave/Skip/LocalNotifications.kt"))
        #expect(bridge.contains("NotificationCompat.CATEGORY_STATUS"))
        #expect(bridge.contains(".setAutoCancel(true)"))
        #expect(bridge.contains("NotificationCompat.MessagingStyle(me)"))
        #expect(bridge.contains(".setGroup(request.threadIdentifier)"))
        #expect(bridge.contains(".setOnlyAlertOnce(request.alertsOnce)"))
        #expect(bridge.contains("LocalNotificationChannel.importanceHigh"))
        #expect(bridge.contains("PermissionHelper.requestNotificationsPermissionIfNeeded { granted ->"))
        #expect(bridge.contains("if (isAppInForeground()) return"))
        #expect(!bridge.contains("ActivityResultContracts"), "one prompt owner: the serialized queue")
        let helper = sys3Flat(try sys3Source("Sources/Conclave/Skip/PermissionHelper.kt"))
        #expect(helper.contains("if (permissions.isNotEmpty()) NotificationPreferences.setPermissionAsked()"))
        #expect(helper.contains("ActivityCompat.shouldShowRequestPermissionRationale(activity, android.Manifest.permission.POST_NOTIFICATIONS)"))
        #expect(helper.contains("Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)"))

        #expect(helper.contains("answered = permissions.isNotEmpty()"))
        #expect(helper.contains("NOTIFICATIONS_REQUEST_CODE -> notificationsPermissionWaiters"))
        let transition = sys3Flat(try sys3Source("Sources/Conclave/Skip/ui/lobby/EntryTransition.kt"))
        #expect(transition.contains("if (settled) { SystemNotifications.shared.stageEntryFinished() }"))
    }

    @Test func theCoreWiringLandsWithTheRequests() throws {

        let vm = try sys3Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(vm.contains("NotificationPrimingPolicy.usesLegacyPrompt("))
        #expect(vm.contains("SystemNotifications.shared.requestPermission(reason: NotificationRequestReason.call)"))
        #expect(vm.contains("SystemNotifications.shared.admittedWhileBackgrounded(roomLabel:"))
        #expect(vm.contains("SystemNotifications.shared.chatMessageForYou("))
        #expect(vm.contains("showsNotificationsPrime: SystemNotifications.shared.snapshot.showsPrimingBanner"))

        #expect(vm.contains("PermissionHelper.requestNotificationsPermissionIfNeeded { granted in"))
        #expect(vm.contains("self.hasRequestedCallNotificationPermission = false"))
    }

    @Test func sys3FilesStayFlatQuietAndDashFree() throws {
        let files = [
            "Sources/Conclave/Core/Call/NotificationPermissionStatePolicy.swift",
            "Sources/Conclave/Core/Call/LocalNotifications+iOS.swift",
            "Sources/Conclave/Features/Lobby/NotificationRows+iOS.swift",
            "Sources/Conclave/Skip/LocalNotifications.kt",
            "Sources/Conclave/Skip/ui/lobby/NotificationRows.kt",
            "Sources/Conclave/Skip/PermissionHelper.kt"
        ]
        for file in files {
            let text = try sys3Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(!text.contains("Color.white") && !text.contains("Color.black"), "\(file)")
            #expect(!text.contains("Haptic") && !text.contains("haptic("), "\(file): no haptics on system surfaces (S70 D7)")
        }
        let shared = try sys3Source("Sources/Conclave/Core/Call/NotificationPermissionStatePolicy.swift")
        #expect(!shared.contains("import UIKit") && !shared.contains("import UserNotifications"), "no platform import")
        #expect(!shared.contains("protocol "), "closure sets, not protocols (S1C 3.6)")
        #expect(!shared.contains(".map(String.init)"))
    }

    @Test func sys3StringsResolveOnBothPlatforms() throws {

        let catalog = try sys3Source("Sources/Conclave/Resources/Localizable.xcstrings")
        for key in ["Notify Me When I’m Let In", "We’ll notify you when you’re let in.", "You’re in. Tap to return to the call.",
                    "Mentioned you", "Private message", "Message Notifications", "Notifications are off for Conclave.",
                    "Get notified about private messages and mentions while you’re in another app.", "Open Settings"] {
            #expect(catalog.contains("\"" + key + "\""), "missing iOS key \(key)")
        }
        let strings = try sys3Source("Android/app/src/main/res/values/strings.xml")
        for name in ["sys_notif_admitted_body", "sys_notif_mention", "sys_notif_mention_line", "sys_channel_admission",
                     "sys_channel_admission_desc", "sys_channel_messages", "sys_channel_messages_desc", "sys_notif_prime_updates",
                     "sys_notif_prime_call", "sys_allow", "ds_not_now", "sys_notif_off", "ds_open_settings", "set_message_notifications",
                     "set_message_notifications_desc", "sys_call_notif_title", "sys_call_notif_on", "sys_call_notif_off", "chat_you",
                     "chat_preview_photo", "chat_reply_gif", "chat_sticker", "chat_clip", "chat_voice", "chat_private_received"] {
            #expect(strings.contains("name=\"" + name + "\""), "missing Android resource \(name)")
        }

        #expect(catalog.contains("\"Private message\"") && catalog.contains("\"Mentioned you\""))
    }
}

private func sys3Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func sys3Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
