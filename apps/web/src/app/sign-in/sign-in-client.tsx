"use client";

import Image from "next/image";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { signIn, useSession } from "@/lib/auth-client";

type AuthProviderId = "google" | "apple" | "roblox" | "vercel";

type ProvidersResponse = {
  providers?: AuthProviderId[];
};

type SignInClientProps = {
  next: string;
};

const providerLabels: Record<AuthProviderId, string> = {
  google: "Google",
  apple: "Apple",
  roblox: "Roblox",
  vercel: "Vercel",
};

const providerOrder: AuthProviderId[] = ["google", "apple", "roblox", "vercel"];

const sanitizeNext = (value: string): string => {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
};

const providerIcon = (provider: AuthProviderId) => {
  if (provider === "google") {
    return (
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        />
        <path
          fill="#34A853"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="#FBBC05"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          fill="#EA4335"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    );
  }

  if (provider === "apple") {
    return (
      <Image
        src="/assets/apple-50.png"
        alt=""
        aria-hidden="true"
        width={20}
        height={20}
        className="h-5 w-5 shrink-0 object-contain"
      />
    );
  }

  if (provider === "roblox") {
    return (
      <Image
        src="/roblox-logo.png"
        alt=""
        aria-hidden="true"
        width={20}
        height={20}
        className="h-5 w-5 shrink-0 object-contain invert"
      />
    );
  }

  return (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#fff" d="M12 4l8 14H4z" />
    </svg>
  );
};

export default function SignInClient({ next }: SignInClientProps) {
  const safeNext = useMemo(() => sanitizeNext(next), [next]);
  const [providers, setProviders] = useState<AuthProviderId[]>([]);
  const [status, setStatus] = useState<"loading" | "idle" | "error">("loading");
  const [activeProvider, setActiveProvider] = useState<AuthProviderId | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const { data: session } = useSession();

  useEffect(() => {
    if (!session?.user) return;
    window.location.replace(safeNext);
  }, [safeNext, session?.user]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetch("/api/auth/providers", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: ProvidersResponse | null) => {
        if (cancelled) return;
        const enabled = Array.isArray(data?.providers) ? data.providers : [];
        const ordered = providerOrder.filter((provider) =>
          enabled.includes(provider),
        );
        setProviders(ordered);
        setStatus("idle");
      })
      .catch(() => {
        if (cancelled) return;
        setProviders([]);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignIn = useCallback(
    async (provider: AuthProviderId) => {
      if (activeProvider) return;
      setActiveProvider(provider);
      setError(null);
      try {
        await signIn.social({
          provider,
          callbackURL: `${window.location.origin}${safeNext}`,
        });
      } catch (signInError) {
        setError(
          signInError instanceof Error
            ? signInError.message
            : "Unable to start sign-in.",
        );
        setActiveProvider(null);
      }
    },
    [activeProvider, safeNext],
  );

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
      <section className="animate-fade-in w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#0e0e10] p-5 sm:p-6">
        <a
          href={safeNext}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[12px] text-[#fafafa]/65 transition-colors hover:bg-white/5 hover:text-[#fafafa]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Conclave
        </a>

        <div className="mt-8">
          <p className="text-[13px] text-[#fafafa]/45">authenticate</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#fafafa]">
            Continue to Conclave
          </h1>
          <p className="mt-2 text-sm leading-6 text-[#fafafa]/55">
            Sign in to schedule meetings, see history, and keep your Conclave
            identity across rooms.
          </p>
        </div>

        <div className="mt-7 grid gap-3">
          {status === "loading" ? (
            <div className="flex h-12 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-sm text-[#fafafa]/55">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading providers
            </div>
          ) : null}

          {status !== "loading" && providers.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4 text-sm text-[#fafafa]/55">
              Authentication is not configured for this deployment.
            </div>
          ) : null}

          {providers.map((provider) => (
            <button
              key={provider}
              type="button"
              onClick={() => void handleSignIn(provider)}
              disabled={activeProvider !== null}
              className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] text-[14px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {activeProvider === provider ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                providerIcon(provider)
              )}
              {activeProvider === provider
                ? "Redirecting..."
                : `Continue with ${providerLabels[provider]}`}
            </button>
          ))}
        </div>

        {error ? <p className="mt-4 text-sm text-[#F95F4A]">{error}</p> : null}
      </section>
    </main>
  );
}
