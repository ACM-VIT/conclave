# 0009. MediaPipe telemetry is patched out of the vendored bundle

- Status: Accepted
- Date: 2026-11-22

## Context

The vendored `@mediapipe/tasks-vision` bundle that powers background effects ships a usage logger that reports to Google. Conclave patches it out, and `scripts/check-mediapipe-privacy.mjs` proves in Chrome that no reporting request leaves the page.

## Decision

The privacy check runs a negative control that restores the upstream initialization, and intercepts every reporting request before it leaves Chrome, so the check proves it can see the traffic it forbids. The patch and the check address the logger by its minified names in `@mediapipe/tasks-vision` 1.2.3.

## Consequences

- A MediaPipe upgrade must re-derive the minified names in the patch and the check. An issue tracks removing that coupling.

## Alternatives considered

- **Blocking the reporting host with CSP only:** rejected because the check would not prove the logger is disabled.

## Code

- `scripts/check-mediapipe-privacy.mjs`
- `package.json`: `check:mediapipe-privacy`
