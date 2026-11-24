export class UnsupportedShape extends Error {
  constructor(detail, subject = "the Dockerfile") {
    super(`unsupported shape: ${detail}; extend the guard or simplify ${subject}`);
  }
}
