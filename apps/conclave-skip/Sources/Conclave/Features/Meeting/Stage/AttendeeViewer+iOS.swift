#if os(iOS) && !SKIP
import SwiftUI

struct AttendeeWaitingLayer: View {
    let stage: StagePresenter

    var body: some View {
        if let viewer = stage.attendee, !viewer.isLive {
            AttendeeWaitingCard(count: viewer.waitingCount)
                .padding(.horizontal, 24)
                .padding(.top, StageCanvasMetrics.topReserve)
                .padding(.bottom, StageCanvasMetrics.barReserve)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .accessibilityIdentifier("stage.attendee.waiting")
        }
    }
}

private struct AttendeeWaitingCard: View {
    let count: Int

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(ConclaveStrings.text("The Webinar Will Begin Soon"))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            } icon: {
                Image(systemName: ConclaveSymbols.dotRadiowavesLeftAndRight)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityHidden(true)
            }
        } description: {
            if AttendeeViewerPolicy.showsWaitingCount(count) {
                Text(AttendeeViewerCopy.waitingCount(count))
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
        }
    }
}

struct AttendeeRoleLayer: View {
    let stage: StagePresenter

    var body: some View {
        let people = stage.people
        let invitation = people?.stageInvitation
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .alert(ConclaveStrings.text("You\u{2019}re Invited on Stage"),

                   isPresented: Binding(get: { invitation != nil }, set: { _ in }),
                   presenting: invitation) { open in
                Button(ConclaveStrings.text("Join as a Speaker")) {
                    people?.acceptStageInvitation(id: open.id)
                }
                .accessibilityIdentifier("stage.invite.accept")
                Button(ConclaveStrings.text("Not Now"), role: .cancel) {
                    people?.declineStageInvitation(id: open.id)
                }
                .accessibilityIdentifier("stage.invite.decline")
            } message: { open in
                Text(AttendeeViewerCopy.invitationMessage(open.promotedByName))
            }
            .accessibilityIdentifier("stage.attendee.role")
    }
}

enum AttendeeViewerCopy {

    static func capsuleSubtitle() -> String {
        ConclaveStrings.text("Live")
    }

    static func title(_ title: String) -> String {
        title.isEmpty ? ConclaveStrings.text("Webinar") : title
    }

    static func waitingCount(_ count: Int) -> String {
        ConclaveStrings.format("Webinar Waiting Count %lld", count)
    }

    static func feedLabel(isShare: Bool, name: String) -> String {
        isShare ? ConclaveStrings.format("Shared Screen from %@", name) : ConclaveStrings.format("Live Video from %@", name)
    }

    static func invitationMessage(_ name: String) -> String {
        if name.isEmpty {
            return ConclaveStrings.text("A host wants to bring you into the conversation. You\u{2019}ll rejoin as a speaker and can turn on your microphone and camera.")
        }
        return ConclaveStrings.format("%@ wants to bring you into the conversation. You\u{2019}ll rejoin as a speaker and can turn on your microphone and camera.", name)
    }

    static func announcement(kind: String) -> String? {
        switch kind {
        case AttendeeViewerPolicy.demotedAnnouncement:
            return ConclaveStrings.text("You’re now watching as an attendee.")
        case AttendeeViewerPolicy.webinarLiveAnnouncement:
            return ConclaveStrings.text("The webinar is live.")
        default:
            return nil
        }
    }
}
#endif
