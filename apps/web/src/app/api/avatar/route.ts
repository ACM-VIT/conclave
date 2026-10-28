import { renderAvatarSvg } from "@/lib/avatar-svg";

export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const name = params.get("name");
  if (!name || name.length > 512) {
    return new Response("Provide a name between 1 and 512 characters.", { status: 400 });
  }
  return new Response(renderAvatarSvg(params), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
