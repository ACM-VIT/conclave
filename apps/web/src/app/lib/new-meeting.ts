let createdHere: string | null = null;

export const markMeetingCreatedHere = (roomId: string): void => {
  createdHere = roomId;
};

export const isMeetingCreatedHere = (roomId: string): boolean => createdHere === roomId;
