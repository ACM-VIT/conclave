import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import ConclaveUpdatePill from "./components/ConclaveUpdatePill";
import TelemetryProvider from "./components/TelemetryProvider";
import { getConclaveClientVersion } from "./lib/site-version.server";
import { getPublicSiteUrl } from "@/lib/site-url";

const siteUrl = getPublicSiteUrl();

export const metadata: Metadata = {
  title: {
    default: "ACM-VIT | c0nclav3",
    template: "%s · c0nclav3",
  },
  description: "A video conferencing platform for meetings, webinars, and collaboration.",
  applicationName: "c0nclav3",
  metadataBase: new URL(siteUrl),
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    title: "ACM-VIT | c0nclav3",
    description: "A video conferencing platform for meetings, webinars, and collaboration.",
    url: "/",
    siteName: "c0nclav3",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "c0nclav3",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ACM-VIT | c0nclav3",
    description: "A video conferencing platform for meetings, webinars, and collaboration.",
    images: ["/og.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#131316",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const clientVersion = getConclaveClientVersion();

  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <TelemetryProvider>
          {children}
          <ConclaveUpdatePill currentVersion={clientVersion} />
        </TelemetryProvider>
      </body>
    </html>
  );
}
