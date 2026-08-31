export const DEFAULT_MEET_VOLUME = 1;
export const DEFAULT_PARTICIPANT_VOLUME = 1;
export const MAX_PARTICIPANT_VOLUME = 1;

export const clampMeetVolume = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_MEET_VOLUME;
  return Math.min(1, Math.max(0, value));
};

export const clampParticipantVolume = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_PARTICIPANT_VOLUME;
  return Math.min(MAX_PARTICIPANT_VOLUME, Math.max(0, value));
};
