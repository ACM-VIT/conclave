"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
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
    return "Session expired. Sign in again and retry.";
  }
  return message || "Unable to delete account.";
};

const GoogleIcon = () => (
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

export default function DeleteAccountClient() {
  const { data: session } = useSession();
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isSignedIn = Boolean(session?.user?.id);
  const signedInEmail = session?.user?.email || "";

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
      if (!response.ok || !data?.success) {
        throw new Error(formatDeleteError(data, text));
      }
      setNotice("Account deleted.");
    } catch (deleteError) {
      const message =
        deleteError instanceof Error ? deleteError.message : "Unable to delete account.";
      setError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#060606] px-4 py-10 text-[#fefcd9]">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#111111] p-6 shadow-2xl shadow-black/40">
        <h1 className="text-2xl font-semibold">Delete account</h1>

        {notice ? (
          <div className="mt-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
            {notice}
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-2xl border border-[#f95f4a]/30 bg-[#f95f4a]/10 px-4 py-3 text-sm text-[#ffd2cc]">
            {error}
          </div>
        ) : null}

        {isSignedIn ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-[#fefcd9]/80">
              {signedInEmail || "Current account"}
            </div>

            <button
              type="button"
              onClick={handleDeleteAccount}
              disabled={isDeleting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#f95f4a] px-5 py-3 text-sm font-medium text-white transition hover:bg-[#ff755e] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isDeleting ? "Deleting..." : "Delete account"}
            </button>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <button
              type="button"
              onClick={() => handleSignIn("google")}
              disabled={activeProvider !== null}
              className="inline-flex w-full items-center justify-center gap-3 rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-medium text-[#fefcd9] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {activeProvider === "google" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GoogleIcon />
              )}
              {activeProvider === "google" ? "Redirecting..." : "Continue with Google"}
            </button>

            <button
              type="button"
              onClick={() => handleSignIn("apple")}
              disabled={activeProvider !== null}
              className="inline-flex w-full items-center justify-center gap-3 rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-medium text-[#fefcd9] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {activeProvider === "apple" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <img
                  src="/assets/apple-50.png"
                  alt=""
                  aria-hidden="true"
                  className="h-5 w-5 shrink-0 object-contain"
                />
              )}
              {activeProvider === "apple" ? "Redirecting..." : "Continue with Apple"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
