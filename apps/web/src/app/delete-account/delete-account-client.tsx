"use client";

import { AlertTriangle, Apple, CheckCircle2, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { signIn, useSession } from "@/lib/auth-client";

type Provider = "google" | "apple";

type DeleteUserResponse = {
  success?: boolean;
  message?: string;
  error?: string;
};

const readResponsePayload = async (
  response: Response
): Promise<{ data: DeleteUserResponse | null; text: string }> => {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = (await response.json().catch(() => null)) as DeleteUserResponse | null;
    return { data, text: "" };
  }
  const text = await response.text().catch(() => "");
  return { data: null, text };
};

const formatDeleteError = (payload: DeleteUserResponse | null, fallbackText: string) => {
  const message = payload?.error || payload?.message || fallbackText;
  if (/session expired/i.test(message)) {
    return "Your session expired. Sign in again, then retry deletion.";
  }
  return message || "Unable to delete your account right now.";
};

export default function DeleteAccountClient() {
  const { data: session } = useSession();
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isSignedIn = Boolean(session?.user?.id);
  const signedInEmail = session?.user?.email || "";

  const providerButtons = useMemo(
    () => [
      {
        id: "google" as const,
        label: "Continue with Google",
        icon: <span className="text-base font-semibold text-[#4285F4]">G</span>,
      },
      {
        id: "apple" as const,
        label: "Continue with Apple",
        icon: <Apple className="h-4 w-4" />,
      },
    ],
    []
  );

  const handleSignIn = async (provider: Provider) => {
    setActiveProvider(provider);
    setError(null);
    setNotice(null);
    try {
      await signIn.social({
        provider,
        callbackURL: `${window.location.origin}/delete-account`,
      });
    } catch (signInError) {
      const message =
        signInError instanceof Error ? signInError.message : "Unable to start sign-in.";
      setError(message);
      setActiveProvider(null);
    }
  };

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/delete-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const { data, text } = await readResponsePayload(response);
      if (!response.ok) {
        throw new Error(formatDeleteError(data, text));
      }
      if (!data?.success) {
        throw new Error(formatDeleteError(data, text));
      }
      setNotice("Your account has been deleted.");
    } catch (deleteError) {
      const message =
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete your account right now.";
      setError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-5 py-10 text-[#fefcd9]">
      <div className="rounded-[28px] border border-[#fefcd9]/10 bg-[#111111]/90 p-6 shadow-2xl shadow-black/40">
        <p className="mb-3 text-xs uppercase tracking-[0.3em] text-[#fefcd9]/50">
          Account deletion
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Delete your c0nclav3 account</h1>
        <p className="mt-4 text-sm leading-6 text-[#fefcd9]/75">
          This page lets you permanently delete the account used with c0nclav3. You do not need to
          email support.
        </p>

        <div className="mt-6 rounded-2xl border border-[#f95f4a]/25 bg-[#f95f4a]/8 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#f95f4a]" />
            <div className="space-y-2 text-sm leading-6 text-[#fefcd9]/80">
              <p>Deleting your account is permanent.</p>
              <p>Profile data tied to your account is removed. Live meeting media is not retained after sessions end.</p>
            </div>
          </div>
        </div>

        {notice ? (
          <div className="mt-6 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-4 text-sm text-emerald-100">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <p>{notice}</p>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="mt-6 rounded-2xl border border-[#f95f4a]/30 bg-[#f95f4a]/10 p-4 text-sm text-[#ffd2cc]">
            {error}
          </div>
        ) : null}

        {isSignedIn ? (
          <div className="mt-8 space-y-4">
            <div className="rounded-2xl border border-[#fefcd9]/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[#fefcd9]/45">Signed in as</p>
              <p className="mt-2 text-sm text-[#fefcd9]">{signedInEmail || "Current account"}</p>
            </div>

            <button
              type="button"
              onClick={handleDeleteAccount}
              disabled={isDeleting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#f95f4a] px-5 py-3 text-sm font-medium text-white transition hover:bg-[#ff755e] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isDeleting ? "Deleting account..." : "Delete account"}
            </button>
          </div>
        ) : (
          <div className="mt-8 space-y-4">
            <p className="text-sm leading-6 text-[#fefcd9]/75">
              Sign in with the account you want to remove, then confirm deletion.
            </p>
            <div className="space-y-3">
              {providerButtons.map((provider) => {
                const isLoading = activeProvider === provider.id;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => handleSignIn(provider.id)}
                    disabled={activeProvider !== null}
                    className="inline-flex w-full items-center justify-center gap-3 rounded-full border border-[#fefcd9]/12 bg-white/5 px-5 py-3 text-sm font-medium text-[#fefcd9] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : provider.icon}
                    {isLoading ? "Redirecting..." : provider.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <p className="mt-8 text-xs leading-5 text-[#fefcd9]/45">
          If your browser says your session expired, sign in again and retry. This page is the
          direct deletion endpoint linked from the iOS app.
        </p>
      </div>
    </main>
  );
}
