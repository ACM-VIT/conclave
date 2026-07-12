import { describe, expect, it } from "vitest";
import {
  extractEmbedUrls,
  getYouTubeVideoId,
} from "../src/app/lib/link-embeds";
import {
  decodeHtmlEntities,
  isForbiddenUnfurlHost,
  parseUnfurlHtml,
  parseUnfurlableUrl,
} from "../src/app/lib/unfurl-html";
import {
  getSyndicationToken,
  getTweetIdFromUrl,
  parseTweetResult,
} from "../src/app/lib/unfurl-tweet";

const PAGE_URL = new URL("https://blog.example.com/posts/hello");

describe("extractEmbedUrls", () => {
  it("embeds explicit https and www links only", () => {
    const urls = extractEmbedUrls(
      "see https://example.com/a and www.example.org/b but not example.net",
    );
    expect(urls).toEqual([
      "https://example.com/a",
      "https://www.example.org/b",
    ]);
  });

  it("trims trailing punctuation like the linkifier", () => {
    expect(extractEmbedUrls("read https://example.com/docs.")).toEqual([
      "https://example.com/docs",
    ]);
  });

  it("skips links wrapped in angle brackets", () => {
    expect(extractEmbedUrls("quiet <https://example.com> link")).toEqual([]);
    expect(
      extractEmbedUrls("<https://a.example.com> https://b.example.com"),
    ).toEqual(["https://b.example.com/"]);
  });

  it("dedupes repeated links and caps the count", () => {
    const urls = extractEmbedUrls(
      "https://a.example.com https://a.example.com https://b.example.com https://c.example.com",
    );
    expect(urls).toEqual(["https://a.example.com/", "https://b.example.com/"]);
  });

  it("ignores email-looking matches", () => {
    expect(extractEmbedUrls("mail me at www.someone@example.com")).toEqual([]);
  });
});

describe("getYouTubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=10", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("extracts the id from %s", (url, id) => {
    expect(getYouTubeVideoId(url)).toBe(id);
  });

  it("rejects non-video and non-youtube urls", () => {
    expect(getYouTubeVideoId("https://www.youtube.com/@somechannel")).toBeNull();
    expect(getYouTubeVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(getYouTubeVideoId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(getYouTubeVideoId("not a url")).toBeNull();
  });
});

describe("isForbiddenUnfurlHost", () => {
  it.each([
    "localhost",
    "intranet",
    "router.local",
    "service.internal",
    "printer.home.arpa",
    "hidden.onion",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "[::1]",
    "[fd00::1]",
  ])("blocks %s", (host) => {
    expect(isForbiddenUnfurlHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "www.example.com",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "my.local.example.com",
  ])("allows %s", (host) => {
    expect(isForbiddenUnfurlHost(host)).toBe(false);
  });
});

describe("parseUnfurlableUrl", () => {
  it("accepts plain public http(s) urls", () => {
    expect(parseUnfurlableUrl("https://example.com/a?b=c")?.href).toBe(
      "https://example.com/a?b=c",
    );
    expect(parseUnfurlableUrl("http://example.com/")?.href).toBe(
      "http://example.com/",
    );
  });

  it("rejects other protocols, credentials, and bad input", () => {
    expect(parseUnfurlableUrl("ftp://example.com/")).toBeNull();
    expect(parseUnfurlableUrl("javascript:alert(1)")).toBeNull();
    expect(parseUnfurlableUrl("https://user:pass@example.com/")).toBeNull();
    expect(parseUnfurlableUrl("")).toBeNull();
    expect(parseUnfurlableUrl("not a url")).toBeNull();
    expect(parseUnfurlableUrl(`https://example.com/${"a".repeat(2100)}`)).toBeNull();
  });

  it("catches integer hosts that canonicalize to private addresses", () => {
    // WHATWG URL parsing turns http://2130706433/ into http://127.0.0.1/.
    expect(parseUnfurlableUrl("http://2130706433/")).toBeNull();
    expect(parseUnfurlableUrl("http://0x7f000001/")).toBeNull();
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named, decimal, and hex entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry&#39;s &#x1F600;")).toBe(
      "Tom & Jerry's 😀",
    );
  });

  it("leaves invalid escapes alone", () => {
    expect(decodeHtmlEntities("&notreal; &#xZZ; 100% &")).toBe(
      "&notreal; &#xZZ; 100% &",
    );
  });
});

describe("parseUnfurlHtml", () => {
  it("reads open graph metadata regardless of quoting and attribute order", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Hello &amp; Welcome">
        <meta content='A tiny&#39;s description' property='og:description'>
        <meta property="og:site_name" content="Example Blog"/>
        <meta property="og:image" content="https://cdn.example.com/hero.png">
      </head><body></body></html>`;
    const parsed = parseUnfurlHtml(html, PAGE_URL);
    expect(parsed.title).toBe("Hello & Welcome");
    expect(parsed.description).toBe("A tiny's description");
    expect(parsed.siteName).toBe("Example Blog");
    expect(parsed.imageUrl).toBe("https://cdn.example.com/hero.png");
  });

  it("falls back to twitter tags, meta description, and the title tag", () => {
    const html = `
      <head>
        <title> Fallback   Title </title>
        <meta name="description" content="Plain description">
        <meta name="twitter:image" content="/relative/image.jpg">
      </head>`;
    const parsed = parseUnfurlHtml(html, PAGE_URL);
    expect(parsed.title).toBe("Fallback Title");
    expect(parsed.description).toBe("Plain description");
    expect(parsed.imageUrl).toBe("https://blog.example.com/relative/image.jpg");
  });

  it("resolves protocol-relative images and rejects unsafe image urls", () => {
    const protocolRelative = parseUnfurlHtml(
      `<meta property="og:image" content="//cdn.example.com/pic.png">`,
      PAGE_URL,
    );
    expect(protocolRelative.imageUrl).toBe("https://cdn.example.com/pic.png");

    const unsafe = parseUnfurlHtml(
      `<meta property="og:title" content="x">
       <meta property="og:image" content="javascript:alert(1)">`,
      PAGE_URL,
    );
    expect(unsafe.imageUrl).toBeUndefined();

    const privateHost = parseUnfurlHtml(
      `<meta property="og:image" content="http://192.168.1.5/cam.jpg">`,
      PAGE_URL,
    );
    expect(privateHost.imageUrl).toBeUndefined();
  });

  it("finds favicons and falls back to /favicon.ico", () => {
    const withIcon = parseUnfurlHtml(
      `<link rel="shortcut icon" href="/assets/icon.png">`,
      PAGE_URL,
    );
    expect(withIcon.faviconUrl).toBe("https://blog.example.com/assets/icon.png");

    const withoutIcon = parseUnfurlHtml(`<title>x</title>`, PAGE_URL);
    expect(withoutIcon.faviconUrl).toBe("https://blog.example.com/favicon.ico");
  });

  it("classifies image layout from twitter card and og image width", () => {
    const large = parseUnfurlHtml(
      `<meta name="twitter:card" content="summary_large_image">
       <meta property="og:image" content="https://cdn.example.com/a.png">`,
      PAGE_URL,
    );
    expect(large.imageLayout).toBe("large");

    const wide = parseUnfurlHtml(
      `<meta property="og:image" content="https://cdn.example.com/a.png">
       <meta property="og:image:width" content="1200">`,
      PAGE_URL,
    );
    expect(wide.imageLayout).toBe("large");

    const small = parseUnfurlHtml(
      `<meta property="og:image" content="https://cdn.example.com/a.png">`,
      PAGE_URL,
    );
    expect(small.imageLayout).toBe("thumb");

    const none = parseUnfurlHtml(`<title>x</title>`, PAGE_URL);
    expect(none.imageLayout).toBeUndefined();
  });

  it("keeps the first occurrence of duplicated meta keys and caps lengths", () => {
    const html = `
      <meta property="og:title" content="First">
      <meta property="og:title" content="Second">
      <meta property="og:description" content="${"d".repeat(600)}">`;
    const parsed = parseUnfurlHtml(html, PAGE_URL);
    expect(parsed.title).toBe("First");
    expect(parsed.description?.length).toBe(400);
    expect(parsed.description?.endsWith("…")).toBe(true);
  });
});

describe("getTweetIdFromUrl", () => {
  const url = (value: string) => new URL(value);

  it.each([
    ["https://x.com/janedoe/status/1234567890123456789", "1234567890123456789"],
    ["https://twitter.com/janedoe/status/123?s=20&t=abc", "123"],
    ["https://mobile.twitter.com/janedoe/statuses/123", "123"],
    ["https://x.com/i/web/status/123", "123"],
  ])("extracts the id from %s", (href, id) => {
    expect(getTweetIdFromUrl(url(href))).toBe(id);
  });

  it("rejects non-status and non-twitter urls", () => {
    expect(getTweetIdFromUrl(url("https://x.com/janedoe"))).toBeNull();
    expect(getTweetIdFromUrl(url("https://x.com/janedoe/status/12a3"))).toBeNull();
    expect(getTweetIdFromUrl(url("https://x.com/janedoe/status/"))).toBeNull();
    expect(
      getTweetIdFromUrl(url("https://example.com/janedoe/status/123")),
    ).toBeNull();
  });
});

describe("getSyndicationToken", () => {
  it("produces the widget token shape (base36, no zeros or dots)", () => {
    const token = getSyndicationToken("1629307668568633344");
    expect(token).toMatch(/^[1-9a-z]+$/);
    expect(getSyndicationToken("1629307668568633344")).toBe(token);
    expect(getSyndicationToken("20")).toMatch(/^[1-9a-z]+$/);
  });
});

describe("parseTweetResult", () => {
  const visibleText = "Hi 👋 see https://t.co/abc";
  const fixture = {
    __typename: "Tweet",
    id_str: "1234567890123456789",
    created_at: "2026-01-02T03:04:05.000Z",
    text: `${visibleText} https://t.co/media1`,
    display_text_range: [0, Array.from(visibleText).length],
    entities: {
      urls: [
        {
          url: "https://t.co/abc",
          expanded_url: "https://example.com/page",
          display_url: "example.com/page",
        },
      ],
      media: [{ url: "https://t.co/media1" }],
    },
    user: {
      name: "Jane Doe",
      screen_name: "janedoe",
      profile_image_url_https:
        "https://pbs.twimg.com/profile_images/1/x_normal.jpg",
    },
    mediaDetails: [
      {
        type: "photo",
        media_url_https: "https://pbs.twimg.com/media/AAA.jpg",
        original_info: { width: 1200, height: 800 },
      },
      {
        type: "video",
        media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/BBB.jpg",
        video_info: {
          aspect_ratio: [16, 9],
          variants: [
            {
              bitrate: 256000,
              content_type: "video/mp4",
              url: "https://video.twimg.com/low.mp4",
            },
            {
              content_type: "application/x-mpegURL",
              url: "https://video.twimg.com/playlist.m3u8",
            },
            {
              bitrate: 2176000,
              content_type: "video/mp4",
              url: "https://video.twimg.com/high.mp4",
            },
            {
              bitrate: 832000,
              content_type: "video/mp4",
              url: "https://video.twimg.com/mid.mp4",
            },
          ],
        },
      },
    ],
  };

  it("maps a media tweet onto the preview shape", () => {
    const preview = parseTweetResult(fixture, "1234567890123456789");
    expect(preview).not.toBeNull();
    expect(preview?.kind).toBe("tweet");
    expect(preview?.url).toBe("https://x.com/janedoe/status/1234567890123456789");
    expect(preview?.title).toBe("Jane Doe (@janedoe)");
    expect(preview?.siteName).toBe("X");
    expect(preview?.imageLayout).toBe("large");
    expect(preview?.tweet?.authorHandle).toBe("janedoe");
    expect(preview?.tweet?.text).toBe("Hi 👋 see example.com/page");
    expect(preview?.tweet?.createdAt).toBe(
      Date.parse("2026-01-02T03:04:05.000Z"),
    );

    const [photo, video] = preview?.tweet?.media ?? [];
    expect(photo).toEqual({
      kind: "photo",
      url: "https://pbs.twimg.com/media/AAA.jpg?name=small",
      width: 1200,
      height: 800,
    });
    // Middle bitrate mp4: chat cards don't need the 2 Mbps rendition.
    expect(video?.kind).toBe("video");
    expect(video?.videoUrl).toBe("https://video.twimg.com/mid.mp4");
    expect(video?.url).toBe("https://pbs.twimg.com/ext_tw_video_thumb/BBB.jpg");
    expect(video?.width).toBe(16);
    expect(video?.height).toBe(9);
  });

  it("classifies animated gifs and strips trailing media links without ranges", () => {
    const preview = parseTweetResult(
      {
        ...fixture,
        text: "look at this https://t.co/media1",
        display_text_range: undefined,
        entities: { media: [{ url: "https://t.co/media1" }] },
        mediaDetails: [
          {
            type: "animated_gif",
            media_url_https: "https://pbs.twimg.com/tweet_video_thumb/CCC.jpg",
            video_info: {
              aspect_ratio: [4, 3],
              variants: [
                {
                  bitrate: 0,
                  content_type: "video/mp4",
                  url: "https://video.twimg.com/tweet_video/CCC.mp4",
                },
              ],
            },
          },
        ],
      },
      "42",
    );
    expect(preview?.tweet?.text).toBe("look at this");
    expect(preview?.tweet?.media[0]?.kind).toBe("gif");
    expect(preview?.tweet?.media[0]?.videoUrl).toBe(
      "https://video.twimg.com/tweet_video/CCC.mp4",
    );
  });

  it("supports the legacy photos/video payload shape", () => {
    const preview = parseTweetResult(
      {
        __typename: "Tweet",
        id_str: "7",
        text: "legacy",
        user: { name: "Jane", screen_name: "jane" },
        photos: [
          { url: "https://pbs.twimg.com/media/DDD.jpg", width: 800, height: 600 },
        ],
        video: {
          poster: "https://pbs.twimg.com/EEE.jpg",
          aspectRatio: [1, 1],
          variants: [
            { type: "video/mp4", src: "https://video.twimg.com/EEE.mp4" },
            { type: "application/x-mpegURL", src: "https://video.twimg.com/EEE.m3u8" },
          ],
        },
      },
      "7",
    );
    expect(preview?.tweet?.media).toHaveLength(2);
    expect(preview?.tweet?.media[0]?.url).toBe(
      "https://pbs.twimg.com/media/DDD.jpg?name=small",
    );
    expect(preview?.tweet?.media[1]?.videoUrl).toBe(
      "https://video.twimg.com/EEE.mp4",
    );
  });

  it("returns null for tombstones and malformed payloads", () => {
    expect(parseTweetResult({ __typename: "TweetTombstone" }, "1")).toBeNull();
    expect(parseTweetResult(null, "1")).toBeNull();
    expect(parseTweetResult({ text: "no user" }, "1")).toBeNull();
    expect(
      parseTweetResult(
        { __typename: "Tweet", user: { name: "x", screen_name: "y" } },
        "1",
      ),
    ).toBeNull();
  });
});
