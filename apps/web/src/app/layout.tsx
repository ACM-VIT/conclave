import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: {
    default: "ACM-VIT | c0nclav3",
    template: "%s · c0nclav3",
  },
  description: "ACM-VIT's in-house video conferencing platform.",
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
    description: "ACM-VIT's in-house video conferencing platform.",
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
    description: "ACM-VIT's in-house video conferencing platform.",
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
  themeColor: "#0d0e0d",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
