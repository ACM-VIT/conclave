import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isLocalDevAuthRequest } from "@/lib/dev-auth";


const DEV_AUTH_PASSWORD = "conclave-dev-password";

const readString = (
  value: unknown,
  fallback: string,
  maxLength: number,
): string => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return normalized || fallback;
};

const readEmail = (value: unknown): string => {
  if (typeof value !== "string") return "dev@conclave.local";
  const normalized = value.trim().toLowerCase().slice(0, 320);
  return normalized.includes("@") ? normalized : "dev@conclave.local";
};

type AuthResult<T> =
  | T
  | {
      headers?: Headers;
      response?: T | Response;
    };

const extractHeaders = (result: unknown): Headers => {
  if (
    result &&
    typeof result === "object" &&
    "headers" in result &&
    result.headers instanceof Headers
  ) {
    return result.headers;
  }
  if (
    result &&
    typeof result === "object" &&
    "response" in result &&
    result.response instanceof Response
  ) {
    return result.response.headers;
  }
  return new Headers();
};

const extractData = <T,>(result: AuthResult<T>): T => {
  if (
    result &&
    typeof result === "object" &&
    "response" in result &&
    result.response instanceof Response
  ) {
    throw new Error("Unexpected auth response");
  }
  if (result && typeof result === "object" && "response" in result) {
    return result.response as T;
  }
  if (result && typeof result === "object" && "headers" in result) {
    const maybeData = result as { data?: T };
    if (maybeData.data) return maybeData.data;
  }
  return result as T;
};

const withAuthCookies = (data: unknown, authHeaders: Headers): NextResponse => {
  const response = NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
  const getSetCookie = (
    authHeaders as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const setCookies = getSetCookie
    ? getSetCookie.call(authHeaders)
    : authHeaders.get("set-cookie")
      ? [authHeaders.get("set-cookie") as string]
      : [];
  for (const cookie of setCookies) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
};

export async function POST(request: Request) {
  if (!isLocalDevAuthRequest(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => ({}));
  const email = readEmail((body as { email?: unknown }).email);
  const name = readString(
    (body as { name?: unknown }).name,
    "Conclave Dev",
    120,
  );

  try {
    const signedIn = await auth.api.signInEmail({
      body: {
        email,
        password: DEV_AUTH_PASSWORD,
        rememberMe: true,
      },
      headers: request.headers,
      returnHeaders: true,
    });
    return withAuthCookies(
      { user: extractData(signedIn).user },
      extractHeaders(signedIn),
    );
  } catch {
    try {
      const signedUp = await auth.api.signUpEmail({
        body: {
          name,
          email,
          password: DEV_AUTH_PASSWORD,
          rememberMe: true,
        },
        headers: request.headers,
        returnHeaders: true,
      });
      return withAuthCookies(
        { user: extractData(signedUp).user },
        extractHeaders(signedUp),
      );
    } catch (error) {
      return NextResponse.json(
        {
          error:
            (error as Error).message ||
            "Could not create the local development session.",
        },
        { status: 500 },
      );
    }
  }
}
