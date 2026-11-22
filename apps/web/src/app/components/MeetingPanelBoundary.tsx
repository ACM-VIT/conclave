"use client";

import { Component, Suspense, type ReactNode } from "react";

type MeetingPanelBoundaryProps = {
  name: string;
  onClose?: () => void;
  children: ReactNode;
};

export default class MeetingPanelBoundary extends Component<
  MeetingPanelBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    const { children, name, onClose } = this.props;
    if (!this.state.failed) {
      return <Suspense fallback={null}>{children}</Suspense>;
    }

    return (
      <aside
        aria-label={name}
        className="safe-area-pt safe-area-pb fixed inset-y-0 right-0 z-40 w-full border-l border-white/10 bg-[#18181b] text-[#fafafa] sm:w-[360px]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 p-4">
          <h2 className="font-semibold">{name}</h2>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2"
            >
              Close panel
            </button>
          )}
        </div>
        <div role="alert" className="space-y-2 p-4 text-sm">
          <p>This panel couldn’t open.</p>
          <p>Reload this page when you’re ready to rejoin the call.</p>
        </div>
      </aside>
    );
  }
}
