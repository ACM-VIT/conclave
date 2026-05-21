"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Plus, RefreshCw, Loader2 } from "lucide-react";
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

const FILTERS: Array<{ value: "upcoming" | "live" | "all"; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "live", label: "Live" },
  { value: "all", label: "All" },
];

export default function WebinarsDashboardClient({ user }: Props) {
  const [webinars, setWebinars] = useState<ScheduledWebinar[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] =
    useState<(typeof FILTERS)[number]["value"]>("upcoming");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedRecordingsWebinarId, setSelectedRecordingsWebinarId] =
    useState<string | null>(null);

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

  const liveCount = webinars.filter((w) => w.status === "live").length;
  const upcomingCount = webinars.filter(
    (w) => w.status === "scheduled",
  ).length;

  return (
    <div
      className="relative min-h-dvh bg-[#060606] text-[#FEFCD9] overflow-hidden"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
      <div className="absolute inset-0 acm-bg-radial pointer-events-none" />

      <header className="relative z-10 flex items-center justify-between px-6 py-5">
        <a
          href="/"
          className="flex items-center"
          aria-label="ACM-VIT"
        >
          <Image
            src="/assets/acm_topleft.svg"
            alt="ACM-VIT"
            width={120}
            height={32}
            priority
          />
        </a>
        <div className="hidden md:flex items-center gap-2 text-xs text-[#FEFCD9]/45">
          signed in as{" "}
          <span className="text-[#FEFCD9]/80">{user.email}</span>
        </div>
      </header>

      <main className="relative z-[5] mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pb-24 pt-8">
        <section className="flex flex-wrap items-end justify-between gap-6 animate-fade-in">
          <div>
            <p className="text-sm text-[#FEFCD9]/45">webinars</p>
            <h1
              className="mt-1 text-4xl md:text-5xl text-[#FEFCD9] tracking-tight"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              your sessions
            </h1>
            <p className="mt-3 text-sm md:text-base text-[#FEFCD9]/60 max-w-xl">
              Schedule, share, and run polished webinars from one place. Send
              attendees a public link or invite by email.
            </p>
            {(liveCount > 0 || upcomingCount > 0) && (
              <div className="mt-4 flex items-center gap-4 text-sm">
                {liveCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-[#F95F4A]">
                    <span className="block h-1.5 w-1.5 rounded-full bg-[#F95F4A] animate-pulse" />
                    {liveCount} live right now
                  </span>
                )}
                {upcomingCount > 0 && (
                  <span className="text-[#FEFCD9]/55">
                    {upcomingCount} scheduled
                  </span>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setIsCreateOpen((open) => !open)}
            className="group inline-flex items-center gap-2 rounded-lg bg-[#F95F4A] px-5 py-2.5 text-sm text-white transition-all hover:bg-[#e8553f] hover:gap-3"
          >
            <Plus className="h-4 w-4" />
            <span>{isCreateOpen ? "Close" : "Schedule a webinar"}</span>
          </button>
        </section>

        {isCreateOpen && (
          <section className="rounded-2xl border border-[#FEFCD9]/10 bg-black/35 p-6 animate-fade-in">
            <h2
              className="text-xl md:text-2xl text-[#FEFCD9] tracking-tight"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              schedule a new webinar
            </h2>
            <p className="mt-1 text-sm text-[#FEFCD9]/55">
              Hosts and co-hosts are auto-promoted on join. Attendees see a
              countdown until you open the room.
            </p>
            <div className="mt-6">
              <ScheduleWebinarForm
                defaultHostEmail={user.email}
                defaultHostName={user.name || undefined}
                onScheduled={(webinar) => {
                  setWebinars((prev) => [webinar, ...prev]);
                  setIsCreateOpen(false);
                }}
              />
            </div>
          </section>
        )}

        <section className="animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-1.5 rounded-full border border-[#FEFCD9]/10 bg-black/20 p-1">
              {FILTERS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  onClick={() => setFilter(entry.value)}
                  className={`rounded-full px-3.5 py-1 text-sm transition ${
                    filter === entry.value
                      ? "bg-[#F95F4A]/15 text-[#F95F4A]"
                      : "text-[#FEFCD9]/55 hover:text-[#FEFCD9]"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1.5 text-sm text-[#FEFCD9]/55 hover:text-[#FEFCD9] transition-colors"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>

          {error ? (
            <div className="rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/5 px-4 py-3 text-sm text-[#F95F4A]">
              {error}
            </div>
          ) : isLoading ? (
            <div className="flex items-center gap-3 py-12 text-sm text-[#FEFCD9]/45">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading your webinars…</span>
            </div>
          ) : webinars.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#FEFCD9]/15 bg-black/20 px-6 py-12 text-center">
              <h3
                className="text-2xl text-[#FEFCD9] tracking-tight"
                style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
              >
                nothing scheduled yet
              </h3>
              <p className="mt-2 text-sm text-[#FEFCD9]/55 max-w-sm mx-auto">
                Schedule your first webinar and share the public link with
                your attendees.
              </p>
              {!isCreateOpen && (
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(true)}
                  className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#F95F4A] px-5 py-2 text-sm text-white transition-all hover:bg-[#e8553f] hover:gap-3"
                >
                  <Plus className="h-4 w-4" />
                  Schedule a webinar
                </button>
              )}
            </div>
          ) : (
            <ScheduledWebinarList
              webinars={webinars}
              onChange={setWebinars}
              onRefresh={refresh}
            />
          )}
        </section>

        {webinars.length > 0 && (
          <section className="animate-fade-in">
            <h2
              className="text-2xl md:text-3xl text-[#FEFCD9] tracking-tight"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              recordings
            </h2>
            <p className="mt-1 text-sm text-[#FEFCD9]/55">
              Download MP4 archives of past sessions.
            </p>
            <div className="mt-4 max-w-md">
              <label className="block text-sm text-[#FEFCD9]/55 mb-2">
                View recordings for
              </label>
              <select
                value={selectedRecordingsWebinarId ?? ""}
                onChange={(event) =>
                  setSelectedRecordingsWebinarId(event.target.value || null)
                }
                className="w-full rounded-lg border border-[#FEFCD9]/15 bg-black/30 px-4 py-2.5 text-sm text-[#FEFCD9] focus:outline-none focus:border-[#FEFCD9]/35 transition-colors"
              >
                <option value="">Pick a webinar…</option>
                {webinars.map((webinar) => (
                  <option key={webinar.id} value={webinar.id}>
                    {webinar.title} ·{" "}
                    {new Date(webinar.scheduledStartAt).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </div>

            {selectedRecordingsWebinar && (
              <div className="mt-6">
                <WebinarRecordingsPanel
                  webinarId={selectedRecordingsWebinar.id}
                  webinarTitle={selectedRecordingsWebinar.title}
                />
              </div>
            )}
          </section>
        )}

        <footer className="mt-8 flex flex-col items-center text-[#FEFCD9]/30">
          <div className="relative inline-block">
            <span
              className="absolute -left-5 top-1/2 -translate-y-1/2 text-[#F95F4A]/40 text-2xl"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              [
            </span>
            <span
              className="text-2xl text-[#FEFCD9]/65 tracking-tight"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              c0nclav3
            </span>
            <span
              className="absolute -right-5 top-1/2 -translate-y-1/2 text-[#F95F4A]/40 text-2xl"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              ]
            </span>
          </div>
          <p className="mt-3 text-xs text-[#FEFCD9]/30">
            video conferencing by ACM-VIT
          </p>
        </footer>
      </main>
    </div>
  );
}
