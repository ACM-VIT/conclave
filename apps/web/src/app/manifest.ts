import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "c0nclav3",
    short_name: "c0nclav3",
    description: "A video conferencing platform for meetings, webinars, and collaboration.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d0e0d",
    theme_color: "#0d0e0d",
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/apple-touch-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
