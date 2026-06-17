import SignInClient from "./sign-in-client";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const getParamValue = (
  value: string | string[] | undefined,
): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const sanitizeNext = (value: string | undefined): string => {
  const next = value?.trim() || "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const resolvedSearchParams = await (searchParams ??
    Promise.resolve({} as Record<string, string | string[] | undefined>));
  const next = sanitizeNext(getParamValue(resolvedSearchParams.next));
  return <SignInClient next={next} />;
}
