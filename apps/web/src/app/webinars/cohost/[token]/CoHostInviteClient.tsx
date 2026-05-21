"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, ShieldAlert, Video } from "lucide-react";
import type { ScheduledWebinar } from "@/lib/scheduled-webinars";

type Props = {
  token: string;
};

type ClaimState =
  | { status: "loading" }
  | { status: "accepted"; webinar: ScheduledWebinar }
  | { status: "error"; message: string; authRequired: boolean };

const monoFontStyle = { fontFamily: "'PolySans Mono', monospace" };

export default function CoHostInviteClient({ token }: Props) {
  const [state, setState] = useState<ClaimState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const accept = async () => {
      try {
        const response = await fetch(
          `/api/webinars/cohost-invites/${encodeURIComponent(token)}/accept`,
          {
            method: "POST",
            cache: "no-store",
          },
        );
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          const message =
            data && typeof data === "object" && "error" in data
              ? String((data as { error?: string }).error || "Invite failed")
              : "Invite failed";
          if (!cancelled) {
            setState({
              status: "error",
              message,
              authRequired: response.status === 401,
            });
          }
          return;
        }
        const webinar = (data as { scheduledWebinar?: ScheduledWebinar } | null)
          ?.scheduledWebinar;
        if (!webinar) {
          throw new Error("Invite accepted but webinar details were missing.");
        }
        if (!cancelled) {
          setState({ status: "accepted", webinar });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            message: (error as Error).message || "Invite failed",
            authRequired: false,
          });
        }
      }
    };
    void accept();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const hostJoinHref = useMemo(() => {
    if (state.status !== "accepted") return "";
    return `/webinars/host/${encodeURIComponent(state.webinar.id)}`;
  }, [state]);

  const signInHref = useMemo(
    () =>
      `/?next=${encodeURIComponent(`/webinars/cohost/${encodeURIComponent(token)}`)}`,
    [token],
  );

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[#060606] px-4 text-[#FEFCD9]"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="w-full max-w-md rounded-xl border border-[#FEFCD9]/10 bg-black/35 p-6 text-center shadow-2xl">
        {state.status === "loading" ? (
          <>
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#F95F4A]" />
            <p
              className="mt-4 text-[10px] uppercase tracking-[0.16em] text-[#FEFCD9]/40"
              style={monoFontStyle}
            >
              Co-host invite
            </p>
            <h1 className="mt-2 text-xl font-medium text-[#FEFCD9]">
              Claiming access…
            </h1>
          </>
        ) : state.status === "accepted" ? (
          <>
            <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-300" />
            <p
              className="mt-4 text-[10px] uppercase tracking-[0.16em] text-[#FEFCD9]/40"
              style={monoFontStyle}
            >
              Co-host access granted
            </p>
            <h1 className="mt-2 text-xl font-medium text-[#FEFCD9]">
              {state.webinar.title}
            </h1>
            <p className="mt-2 text-sm text-[#FEFCD9]/55">
              This webinar now appears in your webinar console, and you will
              join it with host permissions.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <a
                href={hostJoinHref}
                className="inline-flex items-center gap-2 rounded-md border border-[#F95F4A]/40 bg-[#F95F4A]/15 px-3 py-2 text-sm text-[#F95F4A] hover:bg-[#F95F4A]/25"
              >
                <Video className="h-4 w-4" />
                Join as host
              </a>
              <a
                href="/webinars"
                className="inline-flex items-center rounded-md border border-[#FEFCD9]/10 px-3 py-2 text-sm text-[#FEFCD9]/65 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
              >
                Open console
              </a>
            </div>
          </>
        ) : (
          <>
            <ShieldAlert className="mx-auto h-7 w-7 text-[#F95F4A]" />
            <p
              className="mt-4 text-[10px] uppercase tracking-[0.16em] text-[#FEFCD9]/40"
              style={monoFontStyle}
            >
              Co-host invite
            </p>
            <h1 className="mt-2 text-xl font-medium text-[#FEFCD9]">
              Could not claim invite
            </h1>
            <p className="mt-2 text-sm text-[#FEFCD9]/55">{state.message}</p>
            <a
              href={state.authRequired ? signInHref : "/webinars"}
              className="mt-5 inline-flex items-center rounded-md border border-[#FEFCD9]/10 px-3 py-2 text-sm text-[#FEFCD9]/70 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
            >
              {state.authRequired ? "Sign in" : "Open webinar console"}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
