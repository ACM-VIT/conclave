"use client";

import { useState, type ReactNode } from "react";
import { LogIn } from "lucide-react";

interface ReconnectInviteCodeFormProps {
  onSubmit: (inviteCode: string) => void;
  isBusy: boolean;
  children?: ReactNode;
}

export default function ReconnectInviteCodeForm({
  onSubmit,
  isBusy,
  children,
}: ReconnectInviteCodeFormProps) {
  const [inviteCode, setInviteCode] = useState("");
  const trimmed = inviteCode.trim();
  const canSubmit = trimmed.length > 0 && !isBusy;

  return (
    <form
      className="mx-auto mt-4 w-full max-w-[320px]"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit(trimmed);
      }}
    >
      <input
        value={inviteCode}
        onChange={(event) => setInviteCode(event.target.value)}
        aria-label="Invite code"
        placeholder="Invite code"
        autoFocus
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-xl border border-[#fafafa]/12 bg-black/40 px-3 py-2.5 text-center text-sm text-[#fafafa] outline-none placeholder:text-[#fafafa]/35 focus:border-[#fafafa]/35"
      />
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#F95F4A]/45 bg-[#F95F4A]/20 px-4 text-[12.5px] font-medium text-[#fafafa] transition-colors hover:border-[#F95F4A]/70 hover:bg-[#F95F4A]/35 disabled:cursor-not-allowed disabled:border-[#fafafa]/12 disabled:bg-[#fafafa]/8 disabled:text-[#fafafa]/42"
        >
          <LogIn size={14} strokeWidth={1.8} />
          {isBusy ? "Rejoining" : "Rejoin"}
        </button>
        {children}
      </div>
    </form>
  );
}
