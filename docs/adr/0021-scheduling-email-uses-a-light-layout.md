# 0021. Scheduling email uses a light layout

- Status: Accepted
- Date: 2026-11-22

## Context

Gmail and Outlook can wrap dark HTML email in white framing, and a dark slab reads heavy in a real inbox.

## Decision

The scheduling email is light. Conclave's identity comes from the coral accent, PolySans Bulky Wide display type, the `[ c0nclav3 ]` wordmark and the calendar chip, not from a dark background. The framing (wordmark, headline, date, call to action and sign-off) is centred, while the dense summary panel is left-aligned so the details scan.

## Consequences

- The email does not follow the dark in-app theme.

## Code

- `packages/sfu/server/email/schedulingTemplates.tsx`
