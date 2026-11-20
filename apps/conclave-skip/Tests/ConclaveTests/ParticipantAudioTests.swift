#if !SKIP
import Testing
@testable import Conclave

@MainActor
struct ParticipantAudioTests {
    private func makePeople() -> PeoplePresenter {
        let shell = MeetingShellPresenter()
        return PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
    }

    private func roster(session: Int = 1, attempt: Int = 1,
                        phase: String = MeetingPhaseKind.inCall.rawValue) -> PeopleInputs {
        PeopleInputs.make(callSession: session, attempt: attempt, phase: phase, localUserId: "me", participants: [
            PeopleParticipantInput.make(userId: "me", isLocal: true),
            PeopleParticipantInput.make(userId: "other", displayName: "Other"),
            PeopleParticipantInput.make(userId: "third"),
            PeopleParticipantInput.make(userId: "voice-agent-test"),
        ], isRosterLoaded: true)
    }

    @Test func defaultsAndIndependentParticipants() {
        let store = ParticipantAudioStore()
        #expect(store.preference(userId: "other") == ParticipantAudioPreference(muted: false, volume: 1))
        _ = store.setVolume(userId: "other", volume: 0.35)
        #expect(store.preference(userId: "other").gain == 0.35)
        #expect(store.preference(userId: "third").gain == 1)
    }

    @Test func clampsAndRejectsNaN() {
        let store = ParticipantAudioStore()
        #expect(store.setVolume(userId: "other", volume: -1).gain == 0)
        #expect(store.setVolume(userId: "other", volume: 10).gain == 1)
        #expect(store.setVolume(userId: "other", volume: .infinity).gain == 1)
        #expect(store.setVolume(userId: "other", volume: -.infinity).gain == 0)
        #expect(store.setVolume(userId: "other", volume: .nan).gain == 1)
    }

    @Test func mutePreservesVolumeAndMovingSliderUnmutes() {
        let store = ParticipantAudioStore()
        _ = store.setVolume(userId: "other", volume: 0.4)
        let muted = store.setMuted(userId: "other", muted: true)
        #expect(muted.muted)
        #expect(muted.volume == 0.4)
        #expect(muted.gain == 0)
        #expect(store.setMuted(userId: "other", muted: false).gain == 0.4)
        _ = store.setMuted(userId: "other", muted: true)
        #expect(store.setVolume(userId: "other", volume: 0.7) == ParticipantAudioPreference(muted: false, volume: 0.7))
        store.reset()
        #expect(store.preference(userId: "other").gain == 1)
    }

    @Test func localActionsExcludeSelfAgentsAttendeesAndDepartedPeople() {
        let excluded = [
            PeopleParticipantInput.make(userId: "me", isLocal: true),
            PeopleParticipantInput.make(userId: "voice-agent-test"),
            PeopleParticipantInput.make(userId: "test@agent.conclave#session"),
            PeopleParticipantInput.make(userId: ConclaveAssistantChatIdentity.userId),
            PeopleParticipantInput.make(userId: "shared-browser:test"),
            PeopleParticipantInput.make(userId: "gone", isLeaving: true),
            PeopleParticipantInput.make(userId: "attendee", isWebinarAttendee: true),
            PeopleParticipantInput.make(userId: ""),
        ]
        for person in excluded {
            #expect(!PeopleActionPolicy.canAdjustLocalAudio(person))
            let actions = PeopleActionPolicy.actions(person, role: .participant, context: .make(), pendingAction: "")
            #expect(!actions.contains { $0.action == .muteForMe || $0.action == .unmuteForMe || $0.action == .localVolume })
        }
        for viewer in PersonRole.allCases {
            let actions = PeopleActionPolicy.actions(.make(userId: "other"), role: .host,
                context: .make(viewerRole: viewer, blockedReason: PeopleActionReason.offline), pendingAction: "mute")
            #expect(actions.contains { $0.action == .muteForMe && $0.isEnabled })
            #expect(actions.contains { $0.action == .localVolume && $0.isEnabled })
        }
    }

    @Test func presenterDispatchesOnlyLocalGainAndPreservesRecoveryPreferences() {
        let people = makePeople()
        var gains: [Double] = []
        var targets: [String] = []
        var commands = 0
        people.onParticipantAudioChanged = { userId, preference in
            targets.append(userId)
            gains.append(preference.gain)
        }
        people.onCommand = { _, _ in commands += 1 }
        people.apply(roster())
        people.setParticipantVolume(rowId: "other", volume: 0.35)
        #expect(people.perform(.muteForMe, rowId: "other", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(people.rows.entry(for: "other").model.localAudio.isSilent)
        people.apply(roster(attempt: 2, phase: MeetingPhaseKind.recovering.rawValue))
        #expect(people.rows.entry(for: "other").model.localAudio.volume == 0.35)
        #expect(people.perform(.unmuteForMe, rowId: "other", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(gains == [0.35, 0, 0.35])
        #expect(targets == ["other", "other", "other"])
        #expect(commands == 0)
        #expect(people.rows.entry(for: "third").model.localAudio.gain == 1)
        #expect(people.perform(.muteForMe, rowId: "me", source: PeopleActionSource.rowMenu) == .ignored)
        people.setParticipantVolume(rowId: "voice-agent-test", volume: 0)
        people.setParticipantVolume(rowId: "me", volume: 0)
        #expect(gains.count == 3)
    }

    @Test func zeroVolumeCanBeUnmutedAndLeaveClearsSessionState() {
        let people = makePeople()
        var resets = 0
        people.onParticipantAudioReset = { resets += 1 }
        people.apply(roster())
        let baseline = resets
        people.setParticipantVolume(rowId: "other", volume: 0)
        #expect(people.rows.entry(for: "other").model.actions.contains { $0.action == .unmuteForMe })
        _ = people.perform(.unmuteForMe, rowId: "other", source: PeopleActionSource.rowMenu)
        #expect(people.rows.entry(for: "other").model.localAudio.gain == 1)
        people.setParticipantVolume(rowId: "other", volume: 0.2)
        _ = people.perform(.localVolume, rowId: "other", source: PeopleActionSource.rowMenu)
        #expect(people.localAudioRowId == "other")
        people.resetParticipantAudio()
        #expect(resets == baseline + 1)
        #expect(people.localAudioRowId.isEmpty)
        #expect(people.participantAudio.preference(userId: "other").gain == 1)
        people.apply(roster(session: 2))
        #expect(people.rows.entry(for: "other").model.localAudio.gain == 1)
        people.setParticipantVolume(rowId: "other", volume: 0.2)
        people.apply(roster(session: 3))
        #expect(people.rows.entry(for: "other").model.localAudio.gain == 1)
    }

    #if os(macOS)
    @Test func callCleanupResetsParticipantAudio() async {
        let viewModel = MeetingViewModel()
        viewModel.testDetachHostNetworkMonitor()
        viewModel.people.apply(roster())
        viewModel.people.setParticipantVolume(rowId: "other", volume: 0.25)
        #expect(viewModel.people.participantAudio.preference(userId: "other").gain == 0.25)
        await viewModel.cleanup(notifyLocalState: false)
        #expect(viewModel.people.participantAudio.preference(userId: "other").gain == 1)
    }
    #endif

}
#endif
