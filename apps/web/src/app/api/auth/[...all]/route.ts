import { auth } from "@/lib/auth";
import {
  isDevEmailPasswordAuthPath,
  isLocalDevAuthRequest,
} from "@/lib/dev-auth";
import { toNextJsHandler } from "better-auth/next-js";

const authHandler = toNextJsHandler(auth);

export const GET = authHandler.GET;

export const POST = (request: Request) => {
  if (
    isDevEmailPasswordAuthPath(request) &&
    !isLocalDevAuthRequest(request)
  ) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return authHandler.POST(request);
};
