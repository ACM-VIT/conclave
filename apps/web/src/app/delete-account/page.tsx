import type { Metadata } from "next";
import Link from "next/link";

const SUPPORT_EMAIL = "technicaldirector.acmvit@gmail.com";

export const metadata: Metadata = {
  title: "Delete Account",
};

export default function DeleteAccountPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-8 text-base leading-relaxed [&>p]:mb-4 [&>ul]:mb-4 [&>h2]:mt-6">
      <h1>Delete Account</h1>

      <p>
        If you want to delete your c0nclav3 account, send a request to{" "}
        <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
          {SUPPORT_EMAIL}
        </a>{" "}
        from the email address linked to your account.
      </p>

      <h2>What to include in your request</h2>
      <ul>
        <li>Your registered email address</li>
        <li>Subject line: Delete c0nclav3 account</li>
      </ul>

      <h2>What happens after your request</h2>
      <ul>
        <li>
          We will confirm your request and process account deletion within 7
          business days.
        </li>
        <li>
          Account-related profile data (such as account identifier, name, and
          email) will be deleted.
        </li>
        <li>
          Real-time meeting media and chat content are not retained after a
          session ends.
        </li>
      </ul>

      <h2>Need more details?</h2>
      <p>
        See our <Link className="underline" href="/privacy">Privacy Policy</Link>{" "}
        for additional information about data handling.
      </p>

      <p>Last updated: February 18, 2026</p>
    </main>
  );
}
