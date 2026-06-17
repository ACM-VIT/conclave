//
//  ChatCommands.swift
//  Conclave
//

import Foundation

// MARK: - Chat Command Types

enum ChatCommand: String, CaseIterable {
    case help = "help"
    case dm = "dm"
    case tts = "tts"
    case me = "me"
    case action = "action"
    case raise = "raise"
    case lower = "lower"
    case mute = "mute"
    case unmute = "unmute"
    case camera = "camera"
    case cameraOn = "cameraon"
    case cameraOff = "cameraoff"
    case leave = "leave"
    case clear = "clear"

    static let primaryCommands: [ChatCommand] = [
        .help,
        .dm,
        .tts,
        .me,
        .action,
        .raise,
        .lower,
        .mute,
        .unmute,
        .camera,
        .leave,
        .clear
    ]

    static var helpText: String {
        "Commands: \(primaryCommands.map(\.usage).joined(separator: ", "))"
    }

    var displayName: String {
        switch self {
        case .help: return "Help"
        case .dm: return "Private Message"
        case .tts: return "Text to Speech"
        case .me: return "Action"
        case .action: return "Action"
        case .raise: return "Raise Hand"
        case .lower: return "Lower Hand"
        case .mute: return "Mute"
        case .unmute: return "Unmute"
        case .camera: return "Camera"
        case .cameraOn: return "Camera On"
        case .cameraOff: return "Camera Off"
        case .leave: return "Leave"
        case .clear: return "Clear chat"
        }
    }

    var description: String {
        switch self {
        case .help: return "Show available commands"
        case .dm: return "Send a private message"
        case .tts: return "Read a message aloud"
        case .me: return "Send an action message"
        case .action: return "Send an action message"
        case .raise: return "Raise your hand"
        case .lower: return "Lower your hand"
        case .mute: return "Mute your microphone"
        case .unmute: return "Unmute your microphone"
        case .camera: return "Control your camera"
        case .cameraOn: return "Turn on your camera"
        case .cameraOff: return "Turn off your camera"
        case .leave: return "Leave the meeting"
        case .clear: return "Clear your local chat"
        }
    }

    var usage: String {
        switch self {
        case .help: return "/help"
        case .dm: return "/dm <user> <message>"
        case .tts: return "/tts <text>"
        case .me: return "/me <action>"
        case .action: return "/action <action>"
        case .raise: return "/raise"
        case .lower: return "/lower"
        case .mute: return "/mute"
        case .unmute: return "/unmute"
        case .camera: return "/camera on|off|toggle"
        case .cameraOn: return "/cameraon"
        case .cameraOff: return "/cameraoff"
        case .leave: return "/leave"
        case .clear: return "/clear"
        }
    }

    var insertText: String {
        switch self {
        case .dm: return "/dm "
        case .tts: return "/tts "
        case .me: return "/me "
        case .action: return "/action "
        case .camera: return "/camera "
        default: return "/\(rawValue)"
        }
    }

    var icon: String {
        switch self {
        case .help: return "questionmark.circle.fill"
        case .dm: return "lock.fill"
        case .tts: return "speaker.wave.2.fill"
        case .me: return "person.wave.2.fill"
        case .action: return "sparkles"
        case .raise: return "hand.raised.fill"
        case .lower: return "hand.raised.slash.fill"
        case .mute: return "mic.slash.fill"
        case .unmute: return "mic.fill"
        case .camera: return "video.fill"
        case .cameraOn: return "video.fill"
        case .cameraOff: return "video.slash.fill"
        case .leave: return "rectangle.portrait.and.arrow.right.fill"
        case .clear: return "trash.fill"
        }
    }
}

// MARK: - Parsed Command

struct ParsedCommand {
    let command: ChatCommand
    let arguments: [String]
    let originalText: String

    var argumentText: String {
        arguments.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Command Parser

struct ChatCommandParser {
    
    static func parse(_ text: String) -> ParsedCommand? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }

        let withoutSlash = String(trimmed.dropFirst())
        let components = withoutSlash.split(separator: " ", omittingEmptySubsequences: true)
        
        guard let commandPart = components.first else { return nil }
        
        let commandString = String(commandPart).lowercased()
        guard let command = ChatCommand(rawValue: commandString) else {
            return nil
        }

        let arguments = components.dropFirst().map { String($0) }
        
        return ParsedCommand(
            command: command,
            arguments: arguments,
            originalText: trimmed
        )
    }
    
    static func isCommandPrefix(_ text: String) -> Bool {
        return text.hasPrefix("/") && text.count == 1
    }

    /// Mirrors the SFU DM parser so native can block disabled private-message
    /// attempts before sending.
    static func parseDirectMessage(_ text: String) -> (target: String, body: String)? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let isAt = trimmed.hasPrefix("@")
        let isDm = trimmed.lowercased().hasPrefix("/dm ")
        guard isAt || isDm else { return nil }

        let tokens = trimmed.split(separator: " ", omittingEmptySubsequences: true).map { String($0) }

        var target: String
        let bodyTokens: [String]
        if isAt {
            guard tokens.count >= 2 else { return nil }
            target = tokens[0]
            bodyTokens = Array(tokens.dropFirst())
        } else {
            guard tokens.count >= 3 else { return nil }
            target = tokens[1]
            bodyTokens = Array(tokens.dropFirst(2))
        }

        while target.hasPrefix("@") { target = String(target.dropFirst()) }
        let trailingPunctuation = [",", ":", ";", ".", "!", "?"]
        while let last = target.last, trailingPunctuation.contains(String(last)) {
            target = String(target.dropLast())
        }

        let body = bodyTokens.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty, !body.isEmpty else { return nil }
        return (target, body)
    }
    
    static func matchesPartialCommand(_ text: String) -> [ChatCommand] {
        guard text.hasPrefix("/") else { return [] }
        
        let withoutSlash = String(text.dropFirst()).lowercased()
        
        if withoutSlash.isEmpty {
            return ChatCommand.primaryCommands
        }

        let searchableCommands = ChatCommand.primaryCommands + [.cameraOn, .cameraOff]
        return searchableCommands.filter { command in
            command.rawValue.hasPrefix(withoutSlash)
        }
    }
}

// MARK: - System Message

enum SystemMessageType {
    case commandExecuted(command: ChatCommand, userName: String)
    case commandFailed(command: ChatCommand, reason: String)
    case info(String)
}

/// A unified chat-log entry so user messages and system notes (slash-command
/// feedback) render in one timestamp-ordered timeline. Previously the chat view
/// iterated only `chatMessages`, so `systemMessages` (appended by every executed
/// command) were never shown and commands ran with no visible confirmation.
enum ChatTimelineEntry: Identifiable {
    case message(ChatMessage)
    case system(SystemMessage)

    var id: String {
        switch self {
        case .message(let m): return "m_\(m.id)"
        case .system(let s): return "s_\(s.id)"
        }
    }

    var timestamp: Date {
        switch self {
        case .message(let m): return m.timestamp
        case .system(let s): return s.timestamp
        }
    }
}

struct SystemMessage: Identifiable, Equatable {
    let id: String
    let type: SystemMessageType
    let timestamp: Date
    
    init(id: String = UUID().uuidString, type: SystemMessageType, timestamp: Date = Date()) {
        self.id = id
        self.type = type
        self.timestamp = timestamp
    }
    
    var displayText: String {
        switch type {
        case .commandExecuted(let command, let userName):
            return "\(userName) used /\(command.rawValue)"
        case .commandFailed(let command, let reason):
            return "Command /\(command.rawValue) failed: \(reason)"
        case .info(let text):
            return text
        }
    }
    
    static func == (lhs: SystemMessage, rhs: SystemMessage) -> Bool {
        lhs.id == rhs.id &&
        lhs.timestamp == rhs.timestamp &&
        lhs.displayText == rhs.displayText
    }
}
