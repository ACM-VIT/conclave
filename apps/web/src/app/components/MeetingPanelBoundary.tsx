"use client";

import { Component, Suspense, type ReactNode } from "react";
import { telemetry } from "../lib/telemetry";

export function meetingPanelKey(
  panel: "chat" | "transcript",
  userId: string,
  roomId: string,
) {
  return `${panel}:${userId}:${roomId}`;
}

type MeetingPanelBoundaryProps = {
  name: string;
  onClose?: () => void;
  children: ReactNode;
};

type MeetingPanelBoundaryState = {
  status: "ready" | "failed" | "dismissed";
};

export default class MeetingPanelBoundary extends Component<
  MeetingPanelBoundaryProps,
  MeetingPanelBoundaryState
> {
  state: MeetingPanelBoundaryState = { status: "ready" };

  static getDerivedStateFromError(): MeetingPanelBoundaryState {
    return { status: "failed" };
  }

  // The call goes on, so the failure would otherwise never be reported. Its
  // type and frames are sent; its message is withheld like any other.
  componentDidCatch(error: unknown) {
    telemetry.captureException(error, { source: "react_error_boundary", boundary: "panel" });
  }

  render() {
    const { children, name, onClose } = this.props;
    if (this.state.status === "dismissed") return null;
    if (this.state.status === "ready") {
      return <Suspense fallback={null}>{children}</Suspense>;
    }

    return (
      <aside
        aria-label={name}
        className="safe-area-pt safe-area-pb fixed inset-y-0 right-0 z-40 w-full border-l border-white/10 bg-[#18181b] text-[#fafafa] sm:w-[360px]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 p-4">
          <h2 className="font-semibold">{name}</h2>
          <button
            type="button"
            onClick={onClose ?? (() => this.setState({ status: "dismissed" }))}
            className="rounded-md px-2 py-1 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2"
          >
            Close panel
          </button>
        </div>
        <div role="alert" className="space-y-2 p-4 text-sm">
          <p>This panel couldn’t open.</p>
          <p>Reload this page when you’re ready to rejoin the call.</p>
        </div>
      </aside>
    );
  }
}
