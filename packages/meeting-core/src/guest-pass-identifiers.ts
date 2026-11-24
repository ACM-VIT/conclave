export const GUEST_PASS_IDENTIFIERS = {
  seatKey: /guest-[A-Za-z0-9_-]{8,}/,
  passId: /(?<![A-Za-z0-9_-])gp_[A-Za-z0-9_-]{22}/,
  passCookie: /conclave-guest-[0-9a-f]{8}-/,
  signedToken: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
} as const;

export const namesGuestPassIdentifier = (value: unknown): boolean => {
  const text = JSON.stringify(value) ?? "";
  return Object.values(GUEST_PASS_IDENTIFIERS).some((shape) => shape.test(text));
};
