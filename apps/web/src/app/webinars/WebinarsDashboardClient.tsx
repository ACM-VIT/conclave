"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarPlus, Loader2, RefreshCw } from "lucide-react";
import ScheduleWebinarForm from "../components/ScheduleWebinarForm";
import ScheduledWebinarList from "../components/ScheduledWebinarList";
import WebinarRecordingsPanel from "../components/WebinarRecordingsPanel";
import type { ScheduledWebinar } from "@/lib/scheduled-webinars";

type Props = {
  user: {
    id: string;
    email: string;
    name: string | null;
  };
};

export default function WebinarsDashboardClient({ user }: Props) {
  const [webinars, setWebinars] = useState<ScheduledWebinar[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"upcoming" | "live" | "all">("upcoming");
  const [selectedRecordingsWebinarId, setSelectedRecordingsWebinarId] = useState<
    string | null
  >(null);
  const selectedRecordingsWebinar = useMemo(
    () =>
      selectedRecordingsWebinarId
        ? webinars.find((w) => w.id === selectedRecordingsWebinarId) || null
        : null,
    [webinars, selectedRecordingsWebinarId],
  );

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter === "live") params.set("status", "live");
      if (filter === "upcoming") params.set("status", "scheduled,live");
      const response = await fetch(
        `/api/webinars/scheduled${params.toString() ? `?${params}` : ""}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: string }).error || "Failed to load")
            : "Failed to load webinars",
        );
      }
      const data = (await response.json()) as {
        scheduledWebinars?: ScheduledWebinar[];
      };
      setWebinars(data?.scheduledWebinars ?? []);
    } catch (err) {
      setError((err as Error).message || "Failed to load");
      setWebinars([]);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      className="min-h-screen bg-[#060606] text-[#FEFCD9]"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[#FEFCD9]/10 pb-4">
          <div>
            <p
              className="text-[11px] uppercase tracking-[0.2em] text-[#FEFCD9]/40"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              Conclave
            </p>
            <h1 className="text-2xl font-medium text-[#FEFCD9]">
              Webinars
            </h1>
            <p className="mt-1 text-xs text-[#FEFCD9]/50">
              Schedule, share, and run production-grade webinars from a single
              console. Signed in as{" "}
              <span className="text-[#FEFCD9]/80">{user.email}</span>.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {(["upcoming", "live", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.12em] transition ${
                  filter === value
                    ? "border-[#F95F4A]/50 bg-[#F95F4A]/10 text-[#F95F4A]"
                    : "border-[#FEFCD9]/10 text-[#FEFCD9]/55 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
                }`}
                style={{ fontFamily: "'PolySans Mono', monospace" }}
              >
                {value}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1 rounded-full border border-[#FEFCD9]/10 px-3 py-1 text-[11px] text-[#FEFCD9]/65 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          </div>
        </header>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
          <div className="rounded-2xl border border-[#FEFCD9]/10 bg-black/30 p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-[#FEFCD9]">
              <CalendarPlus className="h-4 w-4 text-[#F95F4A]" />
              Your webinars
            </h2>
            {error ? (
              <p className="mb-3 text-xs text-[#F95F4A]">{error}</p>
            ) : null}
            {isLoading ? (
              <div className="flex items-center gap-2 py-6 text-xs text-[#FEFCD9]/50">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </div>
            ) : (
              <>
                <ScheduledWebinarList
                  webinars={webinars}
                  onChange={setWebinars}
                  onRefresh={refresh}
                  emptyHint="Nothing scheduled. Use the panel to the right to create your first webinar."
                />
                {webinars.length > 0 ? (
                  <div className="mt-4">
                    <p
                      className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-[#FEFCD9]/40"
                      style={{ fontFamily: "'PolySans Mono', monospace" }}
                    >
                      View recordings for
                    </p>
                    <select
                      value={selectedRecordingsWebinarId ?? ""}
                      onChange={(event) =>
                        setSelectedRecordingsWebinarId(event.target.value || null)
                      }
                      className="w-full rounded-md border border-[#FEFCD9]/10 bg-black/40 px-3 py-1.5 text-xs text-[#FEFCD9]"
                    >
                      <option value="">Pick a webinar…</option>
                      {webinars.map((webinar) => (
                        <option key={webinar.id} value={webinar.id}>
                          {webinar.title} · {new Date(webinar.scheduledStartAt).toLocaleDateString()}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="rounded-2xl border border-[#FEFCD9]/10 bg-black/30 p-5">
            <h2 className="mb-3 text-sm font-medium text-[#FEFCD9]">
              Schedule new webinar
            </h2>
            <ScheduleWebinarForm
              defaultHostEmail={user.email}
              defaultHostName={user.name || undefined}
              onScheduled={(webinar) =>
                setWebinars((prev) => [webinar, ...prev])
              }
            />
            <div className="mt-4 rounded-lg border border-[#FEFCD9]/10 bg-black/40 p-3 text-[11px] leading-relaxed text-[#FEFCD9]/55">
              <p className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[#FEFCD9]/35" style={{ fontFamily: "'PolySans Mono', monospace" }}>
                Production checklist
              </p>
              <ul className="space-y-1 list-disc pl-4">
                <li>
                  Hosts and co-hosts are auto-promoted on join — no need to
                  enable webinar mode manually.
                </li>
                <li>
                  Public link opens at <strong>start − early entry</strong>;
                  attendees see a waiting room before then.
                </li>
                <li>
                  Send the .ics invite to all attendees; the file embeds the
                  link, organizer, and a 15-minute reminder.
                </li>
              </ul>
            </div>
          </div>
        </section>

        {selectedRecordingsWebinar ? (
          <section>
            <WebinarRecordingsPanel
              webinarId={selectedRecordingsWebinar.id}
              webinarTitle={selectedRecordingsWebinar.title}
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}
