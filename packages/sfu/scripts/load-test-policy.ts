export const loadTestClientPolicies = (clientId: string): string =>
  JSON.stringify({ [clientId]: { useWaitingRoom: false, knockByDefault: false } });
