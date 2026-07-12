import { describe, expect, it, vi } from "vitest";
import { fetchUnfurlResource } from "../src/app/lib/unfurl-fetch";

describe("fetchUnfurlResource", () => {
  it("rejects a redirect to a private host before fetching it", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:3000/admin" },
        }),
      );

    const result = await fetchUnfurlResource(
      new URL("https://public.example.com/start"),
      {},
      fetcher,
    );

    expect(result).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates and follows relative public redirects manually", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await fetchUnfurlResource(
      new URL("https://public.example.com/start"),
      {},
      fetcher,
    );

    expect(result?.finalUrl.href).toBe("https://public.example.com/final");
    expect(await result?.response.text()).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(fetcher.mock.calls[1]?.[0].toString()).toBe(
      "https://public.example.com/final",
    );
  });

  it("stops redirect loops after the configured hop limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const current = new URL(input.toString());
      const hop = Number.parseInt(current.searchParams.get("hop") ?? "0", 10);
      return new Response(null, {
        status: 302,
        headers: { location: `/?hop=${hop + 1}` },
      });
    });

    const result = await fetchUnfurlResource(
      new URL("https://public.example.com/?hop=0"),
      {},
      fetcher,
    );

    expect(result).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
