#if os(iOS) && !SKIP
import SwiftUI

public struct ConclaveCallCommands: Commands {
    @FocusedValue(CallControlsPresenter.self) private var controls: CallControlsPresenter?

    public init() {}

    public var body: some Commands {
        CommandMenu(Text(CallCommandsCopy.menuTitle)) {
            if let controls {
                CallCommandButtons(controls: controls)
            }
        }
    }
}

private struct CallCommandButtons: View {
    let controls: CallControlsPresenter

    var body: some View {
        let commands = controls.commands
        ForEach(commands.items) { item in
            if item.isVisible {
                Button(CallCommandsCopy.title(item.command)) {
                    _ = controls.perform(item.command)
                }
                .keyboardShortcut(CallCommandsCopy.key(item.command), modifiers: CallCommandsCopy.modifiers(item.command))
                .disabled(!item.isEnabled)
            }
        }
    }
}

enum CallCommandsCopy {
    static var menuTitle: String { ConclaveStrings.text("Call") }

    static func title(_ command: CallCommandID) -> String {
        switch command {
        case .microphone: return ConclaveStrings.text("Mute or Unmute")
        case .camera: return ConclaveStrings.text("Turn Camera On or Off")
        case .hand: return ConclaveStrings.text("Raise or Lower Hand")
        case .chat: return ConclaveStrings.text("Show Chat")
        case .participants: return ConclaveStrings.text("Show Participants")
        case .screenShare: return ConclaveStrings.text("Share Screen")
        case .lockMeeting: return ConclaveStrings.text("Lock Meeting")
        }
    }

    static func key(_ command: CallCommandID) -> KeyEquivalent {
        switch command {
        case .microphone: return KeyEquivalent("d")
        case .camera: return KeyEquivalent("e")
        case .hand: return KeyEquivalent("h")
        case .chat: return KeyEquivalent("c")
        case .participants: return KeyEquivalent("p")
        case .screenShare: return KeyEquivalent("s")
        case .lockMeeting: return KeyEquivalent("l")
        }
    }

    static func modifiers(_ command: CallCommandID) -> EventModifiers {
        switch command {
        case .microphone, .camera: return [.command]
        case .hand: return [.command, .option]
        case .chat, .participants, .screenShare, .lockMeeting: return [.command, .shift]
        }
    }
}
#endif
