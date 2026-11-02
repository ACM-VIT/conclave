enum ChatClipPlaybackPolicy {
    static let maximumPlayers = 2

    static func autoplayAllowed(reduceMotion: Bool, panelOpen: Bool, appActive: Bool) -> Bool {
        return !reduceMotion && panelOpen && appActive
    }

    static func playingIDs(visibleIDs: [String], requestedIDs: [String], reduceMotion: Bool,
                           panelOpen: Bool, appActive: Bool) -> [String] {
        guard panelOpen && appActive else { return [] }
        let autoplay = autoplayAllowed(reduceMotion: reduceMotion, panelOpen: panelOpen, appActive: appActive)
        var result: [String] = []
        for id in requestedIDs + visibleIDs {
            if result.count >= maximumPlayers { break }
            if !id.isEmpty && visibleIDs.contains(id) && !result.contains(id)
                && (autoplay || requestedIDs.contains(id)) {
                result.append(id)
            }
        }
        return result
    }
}
