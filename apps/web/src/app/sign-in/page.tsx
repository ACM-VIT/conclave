import { Suspense } from "react";
import RouteLoadingState from "../components/RouteLoadingState";
import SignInClient from "./sign-in-client";
import { toSafeNextPath } from "../lib/safe-next-path";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const getParamValue = (
  value: string | string[] | undefined,
): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const sanitizeNext = (value: string | undefined): string =>
  toSafeNextPath(value) ?? "/";

export default function SignInPage({ searchParams }: SignInPageProps) {
  return (
    <Suspense
      fallback={
        <RouteLoadingState
          title="Preparing sign-in"
        />
      }
    >
      <SignInContent searchParams={searchParams} />
    </Suspense>
  );
}

async function SignInContent({ searchParams }: SignInPageProps) {
  const resolvedSearchParams = await (searchParams ??
    Promise.resolve({} as Record<string, string | string[] | undefined>));
  const next = sanitizeNext(getParamValue(resolvedSearchParams.next));
  return <SignInClient next={next} />;
}
