import Foundation

enum ActivityStatusBlockKind: String, CaseIterable, Equatable {
    case none, loading, failure
}

struct ActivityStatusBlock: Equatable {
    let kind: ActivityStatusBlockKind
    let showsRetry: Bool
    let needsUpdate: Bool

    static let none = ActivityStatusBlock(kind: ActivityStatusBlockKind.none, showsRetry: false, needsUpdate: false)
    static let loading = ActivityStatusBlock(kind: ActivityStatusBlockKind.loading, showsRetry: false, needsUpdate: false)

    static func failure(showsRetry: Bool, needsUpdate: Bool) -> ActivityStatusBlock {
        return ActivityStatusBlock(kind: ActivityStatusBlockKind.failure, showsRetry: showsRetry, needsUpdate: needsUpdate)
    }
}

enum AppHostStatusLine: String, CaseIterable, Equatable {
    case none, opening, unavailable, names, playback, locked, editors
}

enum AppHostBar: String, CaseIterable, Equatable {
    case none, whiteboard, wheel
}

enum ActivityGlyph: String, CaseIterable, Equatable {
    case game, whiteboard, wheel, watch, app, browser
}

enum ActivityGlyphPolicy {
    static func glyph(kind: String, appId: String) -> ActivityGlyph {
        if kind == ActivityKind.browser.rawValue { return ActivityGlyph.browser }
        if kind == ActivityKind.app.rawValue {
            if appId == "whiteboard" { return ActivityGlyph.whiteboard }
            if appId == "wheel" { return ActivityGlyph.wheel }
            if appId == "watch" { return ActivityGlyph.watch }
            return ActivityGlyph.app
        }
        return ActivityGlyph.game
    }
}

enum AppHostChromePolicy {
    static func isFailed(_ model: AppHostModel) -> Bool {
        return model.phase == AppHostPhase.failed || model.phase == AppHostPhase.versionMismatch
    }

    static func statusBlock(_ model: AppHostModel) -> ActivityStatusBlock {
        switch model.phase {
        case .opening: return ActivityStatusBlock.loading
        case .failed: return ActivityStatusBlock.failure(showsRetry: model.hasEmbed, needsUpdate: false)
        case .versionMismatch: return ActivityStatusBlock.failure(showsRetry: false, needsUpdate: true)
        case .ready, .readOnly, .closing: return ActivityStatusBlock.none
        }
    }

    static func chip(_ model: AppHostModel) -> AppHostTag {
        if isFailed(model) { return AppHostTag.none }
        if model.phase == AppHostPhase.opening && model.tag != AppHostTag.reconnecting { return AppHostTag.none }
        return model.tag
    }

    static func chipShowsLock(_ tag: AppHostTag) -> Bool {
        return tag == AppHostTag.viewOnly || tag == AppHostTag.lockedForOthers
    }

    static func statusLine(_ model: AppHostModel) -> AppHostStatusLine {
        if model.phase == AppHostPhase.opening { return AppHostStatusLine.opening }
        if model.appId.isEmpty { return AppHostStatusLine.none }
        if isFailed(model) { return AppHostStatusLine.unavailable }
        if model.appId == "wheel" && model.nameCount > 0 { return AppHostStatusLine.names }
        if model.appId == "watch" && (model.playback == "playing" || model.playback == "paused") { return AppHostStatusLine.playback }
        if model.isLocked && !chipShowsLock(chip(model)) { return AppHostStatusLine.locked }
        if model.appId == "whiteboard" && model.editorCount > 0 { return AppHostStatusLine.editors }
        return AppHostStatusLine.none
    }

    static func bar(_ model: AppHostModel) -> AppHostBar {
        if !model.canEdit { return AppHostBar.none }
        if model.phase != AppHostPhase.ready && model.phase != AppHostPhase.closing { return AppHostBar.none }
        if model.appId == "whiteboard" { return AppHostBar.whiteboard }
        if model.appId == "wheel" { return AppHostBar.wheel }
        return AppHostBar.none
    }

    static func showsBoardHint(_ model: AppHostModel, elementCount: Int, pageId: String) -> Bool {
        return bar(model) == AppHostBar.whiteboard && elementCount == 0 && !pageId.isEmpty
    }
}

enum BrowserChromePolicy {
    static func statusBlock(_ model: BrowserStageModel) -> ActivityStatusBlock {
        switch model.load {
        case .starting: return ActivityStatusBlock.loading
        case .failed: return ActivityStatusBlock.failure(showsRetry: true, needsUpdate: false)
        case .loading, .live, .reconnecting: return ActivityStatusBlock.none
        }
    }

    static func showsReconnectingChip(_ model: BrowserStageModel) -> Bool {
        return model.load == BrowserLoadState.reconnecting
    }

    static func canFocusKeyboard(_ model: BrowserStageModel) -> Bool {
        return model.inputInteractive && model.hasSurface
    }
}

enum ActivitiesSectionPolicy {
    static func showsBrowserSection(_ snapshot: ActivitiesSnapshot) -> Bool {
        let browser = snapshot.browser
        if !browser.isAvailable && !browser.isActive { return false }
        if snapshot.role == ActivityRole.host { return true }
        return !snapshot.isVoteOpen && browser.hasAudio
    }

    static func canToggleAppsLock(_ snapshot: ActivitiesSnapshot) -> Bool {
        return snapshot.appsReason != ActivitiesReason.noAppOpen && !snapshot.appsLockPending && !snapshot.isRecovering
    }
}

enum WhiteboardToolbarPolicy {
    static let drawingTools: [AppWhiteboardTool] = [AppWhiteboardTool.select, AppWhiteboardTool.pan, AppWhiteboardTool.pen,
                                                    AppWhiteboardTool.highlighter, AppWhiteboardTool.eraser]
    static let shapeTools: [AppWhiteboardTool] = [AppWhiteboardTool.rect, AppWhiteboardTool.ellipse, AppWhiteboardTool.line,
                                                  AppWhiteboardTool.arrow]
    static let markupTools: [AppWhiteboardTool] = [AppWhiteboardTool.text, AppWhiteboardTool.sticky, AppWhiteboardTool.laser]
    static let shapeCommands: [AppHostCommandKind] = [AppHostCommandKind.setTool, AppHostCommandKind.setFill]
    static let pageCommands: [AppHostCommandKind] = [AppHostCommandKind.setPage, AppHostCommandKind.addPage,
                                                     AppHostCommandKind.renamePage, AppHostCommandKind.deletePage]
    static let moreCommands: [AppHostCommandKind] = [AppHostCommandKind.setPage, AppHostCommandKind.addPage,
                                                     AppHostCommandKind.renamePage, AppHostCommandKind.deletePage,
                                                     AppHostCommandKind.zoomToFit, AppHostCommandKind.export]

    static func isSelected(_ tool: AppWhiteboardTool, current: String) -> Bool {
        return tool.rawValue == current
    }

    static func isShapeSelected(current: String) -> Bool {
        return AppWhiteboardTool(rawValue: current)?.isShape ?? false
    }

    static func shapeGlyph(current: String) -> AppWhiteboardTool {
        if let tool = AppWhiteboardTool(rawValue: current), tool.isShape { return tool }
        return AppWhiteboardTool.rect
    }

    static func isPending(_ kinds: [AppHostCommandKind], toolbar: AppToolbarModel) -> Bool {
        for kind in kinds {
            if toolbar.isPending(kind) { return true }
        }
        return false
    }

    static func canRenamePage(_ toolbar: AppToolbarModel) -> Bool {
        return !toolbar.pageId.isEmpty
    }

    static func canDeletePage(_ toolbar: AppToolbarModel) -> Bool {
        return toolbar.pages.count >= 2
    }
}
