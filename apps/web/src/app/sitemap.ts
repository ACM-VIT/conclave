import type { MetadataRoute } from "next";
import { getPublicSiteUrl } from "@/lib/site-url";

const siteUrl = getPublicSiteUrl();

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/privacy`,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${siteUrl}/delete-account`,
      changeFrequency: "monthly",
      priority: 0.4,
    },
  ];
}
