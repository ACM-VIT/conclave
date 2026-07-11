import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
  render,
} from "react-email";
import { color, font, radius, space } from "@conclave/ui-tokens";
import type { CSSProperties } from "react";

export type SchedulingEmailRow = {
  label: string;
  value: string;
};

type SchedulingEmailWhen = {
  weekday: string;
  day: string;
  month: string;
  time: string;
  timeZone: string;
};

export type SchedulingEmailTemplateInput = {
  preview: string;
  heading: string;
  intro: string;
  eventTitle: string;
  when: SchedulingEmailWhen;
  durationLabel: string;
  rows: SchedulingEmailRow[];
  meetingLink: string;
  ctaLabel: string;
  disclaimer?: string | null;
};

export type RenderedSchedulingEmail = {
  html: string;
  text: string;
};

/**
 * Conclave's scheduling email. A light confirmation that reads cleanly in real
 * inboxes (a dark slab renders heavy and gets wrapped in white by
 * Gmail/Outlook). Identity is carried by the orange accent (#F95F4A), PolySans
 * Bulky Wide display type, the `[ c0nclav3 ]` wordmark from the OpenGraph card,
 * and the calendar chip, not by a black background.
 *
 * Alignment is deliberate, not uniform: the framing (wordmark, headline, the
 * date hero, the CTA, the sign-off) is centered for balance, while the dense
 * summary panel is left-aligned so the details scan and give the eye a steady
 * anchor in the middle. Centered → left → centered creates the rhythm.
 */
const palette = {
  page: "#f1f1f2",
  card: "#ffffff",
  panel: "#f7f7f8",
  border: "#e7e7ea",
  panelBorder: "#ededf0",
  ink: "#15151a",
  inkSoft: "#5d5d66",
  inkFaint: "#9a9aa2",
  accent: color.accent, // #F95F4A
  accentInk: "#d8462e", // deeper orange that stays legible on white
  onAccent: "#ffffff",
} as const;

const styles: Record<string, CSSProperties> = {
  body: {
    margin: 0,
    padding: 0,
    backgroundColor: palette.page,
    color: palette.ink,
    fontFamily: font.sans,
  },
  outer: {
    width: "100%",
    backgroundColor: palette.page,
    padding: `${space["2xl"]}px ${space.lg}px ${space["3xl"]}px`,
  },
  container: {
    maxWidth: "464px",
    margin: "0 auto",
    border: `1px solid ${palette.border}`,
    borderRadius: `${radius.lg}px`,
    backgroundColor: palette.card,
    overflow: "hidden",
    boxShadow: "0 1px 2px rgba(17, 17, 26, 0.04), 0 12px 32px rgba(17, 17, 26, 0.07)",
  },
  accentEdge: {
    height: "3px",
    lineHeight: "3px",
    fontSize: "3px",
    backgroundColor: palette.accent,
  },
  // ---- Framing: centered ----
  header: {
    padding: `${space.xl}px ${space.xl}px 0`,
    textAlign: "center",
  },
  wordmark: {
    margin: 0,
    color: palette.ink,
    fontFamily: font.display,
    fontSize: "15px",
    fontWeight: 700,
    letterSpacing: "0.01em",
    textAlign: "center",
  },
  bracket: {
    color: palette.accent,
  },
  heading: {
    margin: `${space.lg}px 0 0`,
    color: palette.ink,
    fontFamily: font.display,
    fontSize: "23px",
    lineHeight: "1.2",
    fontWeight: 700,
    letterSpacing: "-0.01em",
    textAlign: "center",
  },
  intro: {
    margin: `${space.sm}px auto 0`,
    color: palette.inkSoft,
    fontSize: "14px",
    lineHeight: "1.6",
    textAlign: "center",
    maxWidth: "330px",
  },
  // ---- Date hero: centered focal point ----
  hero: {
    padding: `${space.xl}px ${space.xl}px ${space.lg}px`,
    textAlign: "center",
  },
  chip: {
    width: "60px",
    display: "inline-block",
    border: `1px solid ${palette.border}`,
    borderRadius: `${radius.md}px`,
    backgroundColor: palette.card,
    overflow: "hidden",
  },
  chipMonth: {
    margin: 0,
    backgroundColor: palette.accent,
    color: palette.onAccent,
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.14em",
    textAlign: "center",
    padding: "5px 0",
  },
  chipDay: {
    margin: 0,
    color: palette.ink,
    fontFamily: font.display,
    fontSize: "27px",
    lineHeight: "1",
    fontWeight: 700,
    textAlign: "center",
    padding: "8px 0 10px",
  },
  heroEvent: {
    margin: `${space.lg}px 0 0`,
    color: palette.accentInk,
    fontSize: "13px",
    fontWeight: 600,
    lineHeight: "1.3",
    letterSpacing: "0.01em",
    textAlign: "center",
  },
  heroWeekday: {
    margin: "4px 0 0",
    color: palette.ink,
    fontFamily: font.display,
    fontSize: "22px",
    lineHeight: "1.18",
    fontWeight: 700,
    letterSpacing: "-0.01em",
    textAlign: "center",
  },
  heroMeta: {
    margin: "6px 0 0",
    color: palette.inkSoft,
    fontSize: "13px",
    lineHeight: "1.5",
    textAlign: "center",
  },
  // ---- Summary panel: left-aligned data ----
  panelWrap: {
    padding: `0 ${space.xl}px`,
  },
  panel: {
    border: `1px solid ${palette.panelBorder}`,
    borderRadius: `${radius.md}px`,
    backgroundColor: palette.panel,
    padding: `${space.xs}px ${space.lg}px`,
  },
  detailItem: {
    borderTop: `1px solid ${palette.panelBorder}`,
    padding: `${space.md}px 0`,
  },
  detailItemFirst: {
    padding: `${space.md}px 0`,
  },
  detailLabel: {
    margin: 0,
    color: palette.inkFaint,
    fontSize: "12px",
    lineHeight: "1.4",
  },
  detailValue: {
    margin: "3px 0 0",
    color: palette.ink,
    fontSize: "14px",
    lineHeight: "1.45",
  },
  // ---- Action + sign-off: centered ----
  action: {
    padding: `${space.xl}px ${space.xl}px ${space.lg}px`,
    textAlign: "center",
  },
  button: {
    backgroundColor: palette.accent,
    borderRadius: `${radius.md}px`,
    color: palette.onAccent,
    display: "inline-block",
    fontSize: "14px",
    fontWeight: 600,
    lineHeight: "1",
    padding: "14px 30px",
    textDecoration: "none",
  },
  linkText: {
    margin: `${space.md}px 0 0`,
    color: palette.inkFaint,
    fontSize: "12px",
    lineHeight: "1.55",
    textAlign: "center",
  },
  link: {
    color: palette.accentInk,
    textDecoration: "none",
    wordBreak: "break-all",
  },
  footerWrap: {
    maxWidth: "464px",
    margin: `${space.lg}px auto 0`,
    padding: `0 ${space.lg}px`,
  },
  disclaimer: {
    margin: 0,
    color: palette.inkFaint,
    fontSize: "11px",
    lineHeight: "1.6",
    textAlign: "center",
  },
};

function Wordmark() {
  return (
    <Text style={styles.wordmark}>
      <span style={styles.bracket}>[</span> c0nclav3{" "}
      <span style={styles.bracket}>]</span>
    </Text>
  );
}

function SummaryPanel({ rows }: { rows: SchedulingEmailRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Section style={styles.panelWrap}>
      <Section style={styles.panel}>
        {rows.map((row, index) => (
          <Section
            key={row.label}
            style={index === 0 ? styles.detailItemFirst : styles.detailItem}
          >
            <Text style={styles.detailLabel}>{row.label}</Text>
            <Text style={styles.detailValue}>{row.value}</Text>
          </Section>
        ))}
      </Section>
    </Section>
  );
}

function SchedulingEmailTemplate({
  preview,
  heading,
  intro,
  eventTitle,
  when,
  durationLabel,
  rows,
  meetingLink,
  ctaLabel,
  disclaimer,
}: SchedulingEmailTemplateInput) {
  const metaParts = [when.time, when.timeZone, durationLabel].filter(Boolean);

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Section style={styles.outer}>
          <Container style={styles.container}>
            <Section style={styles.accentEdge} />

            <Section style={styles.header}>
              <Wordmark />
              <Heading as="h1" style={styles.heading}>
                {heading}
              </Heading>
              <Text style={styles.intro}>{intro}</Text>
            </Section>

            <Section style={styles.hero}>
              <div style={styles.chip}>
                <div style={styles.chipMonth}>{when.month}</div>
                <div style={styles.chipDay}>{when.day}</div>
              </div>
              <Text style={styles.heroEvent}>{eventTitle}</Text>
              <Text style={styles.heroWeekday}>{when.weekday}</Text>
              <Text style={styles.heroMeta}>{metaParts.join("  ·  ")}</Text>
            </Section>

            <SummaryPanel rows={rows} />

            <Section style={styles.action}>
              <Button href={meetingLink} style={styles.button}>
                {ctaLabel}
              </Button>
              <Text style={styles.linkText}>
                Or open it directly:{" "}
                <Link href={meetingLink} style={styles.link}>
                  {meetingLink}
                </Link>
              </Text>
            </Section>
          </Container>

          {disclaimer ? (
            <Section style={styles.footerWrap}>
              <Text style={styles.disclaimer}>{disclaimer}</Text>
            </Section>
          ) : null}
        </Section>
      </Body>
    </Html>
  );
}

export default function SchedulingEmailPreview() {
  return (
    <SchedulingEmailTemplate
      preview="Intro Call is booked for Wed, Jul 1, 2026, 7:30 PM GMT+5:30."
      heading="You're booked"
      intro="Your Conclave meeting with Ada Host is confirmed."
      eventTitle="Intro Call"
      when={{
        weekday: "Wednesday",
        day: "1",
        month: "JUL",
        time: "7:30 PM",
        timeZone: "GMT+5:30",
      }}
      durationLabel="30 min"
      rows={[{ label: "Host", value: "Ada Host <host@example.com>" }]}
      meetingLink="https://conclave.acmvit.in/intro-1234"
      ctaLabel="Join the room"
      disclaimer="You're receiving this email because a Conclave meeting was scheduled with this address."
    />
  );
}

export const renderSchedulingEmail = async (
  input: SchedulingEmailTemplateInput,
): Promise<RenderedSchedulingEmail> => {
  const node = <SchedulingEmailTemplate {...input} />;
  const [html, text] = await Promise.all([
    render(node),
    render(node, { plainText: true }),
  ]);
  return { html, text };
};
