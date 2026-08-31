"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  clampMeetVolume,
  clampParticipantVolume,
  DEFAULT_MEET_VOLUME,
  DEFAULT_PARTICIPANT_VOLUME,
} from "../lib/meet-volume";

interface MeetVolumeContextValue {
  meetVolume: number;
  setMeetVolume: Dispatch<SetStateAction<number>>;
  getParticipantVolume: (userId: string) => number;
  setParticipantVolume: (userId: string, volume: number) => void;
}

const MeetVolumeContext = createContext<MeetVolumeContextValue>({
  meetVolume: DEFAULT_MEET_VOLUME,
  setMeetVolume: () => {},
  getParticipantVolume: () => DEFAULT_PARTICIPANT_VOLUME,
  setParticipantVolume: () => {},
});

interface MeetVolumeProviderProps {
  children: ReactNode;
  meetVolume: number;
  setMeetVolume: Dispatch<SetStateAction<number>>;
}

export function MeetVolumeProvider({
  children,
  meetVolume,
  setMeetVolume,
}: MeetVolumeProviderProps) {
  const [participantVolumes, setParticipantVolumes] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const getParticipantVolume = useCallback((userId: string) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) return DEFAULT_PARTICIPANT_VOLUME;
    return (
      participantVolumes.get(normalizedUserId) ?? DEFAULT_PARTICIPANT_VOLUME
    );
  }, [participantVolumes]);
  const setParticipantVolume = useCallback((userId: string, volume: number) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) return;
    const normalizedVolume = clampParticipantVolume(volume);
    setParticipantVolumes((current) => {
      const previous =
        current.get(normalizedUserId) ?? DEFAULT_PARTICIPANT_VOLUME;
      if (previous === normalizedVolume) return current;
      const next = new Map(current);
      if (normalizedVolume === DEFAULT_PARTICIPANT_VOLUME) {
        next.delete(normalizedUserId);
      } else {
        next.set(normalizedUserId, normalizedVolume);
      }
      return next;
    });
  }, []);
  const value = useMemo(
    () => ({
      meetVolume: clampMeetVolume(meetVolume),
      setMeetVolume,
      getParticipantVolume,
      setParticipantVolume,
    }),
    [getParticipantVolume, meetVolume, setMeetVolume, setParticipantVolume],
  );

  return createElement(MeetVolumeContext.Provider, { value }, children);
}

export function useMeetVolume() {
  return useContext(MeetVolumeContext);
}
