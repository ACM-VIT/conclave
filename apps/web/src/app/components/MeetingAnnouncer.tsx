"use client";

import { useEffect, useRef, useState } from "react";
import {
  chatAnnouncement,
  diffRoster,
  phraseAnnouncements,
  rosterOf,
  type MeetingAnnouncement,
  type RoomRoster,
} from "../lib/meeting-announcements";
import type { ChatMessage, Participant } from "../lib/types";

const SETTLE_MS = 3000;
const BATCH_MS = 1200;
const MIN_GAP_MS = 2500;
const CLEAR_AFTER_MS = 7000;

interface MeetingAnnouncerProps {
  isLive: boolean;
  participants: Map<string, Participant>;
  chatMessages: ChatMessage[];
  currentUserId: string;
  resolveDisplayName: (userId: string) => string;
}

interface AnnouncerState {
  roster: RoomRoster | null;
  liveSince: number;
  seenMessageIds: Set<string> | null;
  pending: MeetingAnnouncement[];
  timer: number | null;
  lastSpokenAt: number;
}

export default function MeetingAnnouncer({
  isLive,
  participants,
  chatMessages,
  currentUserId,
  resolveDisplayName,
}: MeetingAnnouncerProps) {
  const [spoken, setSpoken] = useState({ text: "", serial: 0 });
  const stateRef = useRef<AnnouncerState>({
    roster: null,
    liveSince: 0,
    seenMessageIds: null,
    pending: [],
    timer: null,
    lastSpokenAt: 0,
  });

  const enqueue = (events: MeetingAnnouncement[]) => {
    const state = stateRef.current;
    if (events.length === 0) return;
    state.pending.push(...events);
    if (state.timer !== null) return;
    const wait = Math.max(BATCH_MS, state.lastSpokenAt + MIN_GAP_MS - Date.now());
    state.timer = window.setTimeout(() => {
      state.timer = null;
      const text = phraseAnnouncements(state.pending);
      state.pending = [];
      state.lastSpokenAt = Date.now();
      if (text) setSpoken((previous) => ({ text, serial: previous.serial + 1 }));
    }, wait);
  };

  useEffect(() => {
    const state = stateRef.current;
    if (!isLive) {
      state.roster = null;
      state.pending = [];
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = null;
      return;
    }
    const roster = rosterOf(participants, currentUserId, resolveDisplayName);
    const previous = state.roster;
    state.roster = roster;
    if (!previous) {
      state.liveSince = Date.now();
      return;
    }
    if (Date.now() - state.liveSince < SETTLE_MS) return;
    enqueue(diffRoster(previous, roster));
  }, [isLive, participants, currentUserId, resolveDisplayName]);

  useEffect(() => {
    const state = stateRef.current;
    const ids = chatMessages.map((message) => message.id);
    if (!state.seenMessageIds) {
      state.seenMessageIds = new Set(ids);
      return;
    }
    const seen = state.seenMessageIds;
    const fresh = chatMessages.filter((message) => !seen.has(message.id));
    ids.forEach((id) => seen.add(id));
    const isHistoryLoad = fresh.length > 1;
    if (!isLive || isHistoryLoad) return;
    enqueue(
      fresh
        .filter((message) => message.userId !== currentUserId)
        .map(chatAnnouncement),
    );
  }, [isLive, chatMessages, currentUserId]);

  useEffect(() => {
    if (!spoken.text) return;
    const timeout = window.setTimeout(
      () => setSpoken((previous) => ({ ...previous, text: "" })),
      CLEAR_AFTER_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [spoken.serial, spoken.text]);

  useEffect(() => {
    const state = stateRef.current;
    return () => {
      if (state.timer !== null) window.clearTimeout(state.timer);
    };
  }, []);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {spoken.text && spoken.serial % 2 === 1
        ? `${spoken.text}\u00a0`
        : spoken.text}
    </div>
  );
}
