import type {
  AssetUploadHandler,
  AssetUploadInput,
  AssetUploadResult,
} from "../types/index";

export type AssetUploadHandlerOptions = {
  endpoint?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  formFieldName?: string;
  headers?: HeadersInit;
  mapError?: (response: Response) => Promise<string>;
};

type ReactNativeFormFile = {
  uri: string;
  name: string;
  type: string;
};

type ReactNativeFormData = FormData & {
  append(name: string, value: Blob | string | ReactNativeFormFile, fileName?: string): void;
};

const isNativeRuntime =
  typeof navigator !== "undefined" && navigator.product === "ReactNative";
const DEFAULT_ENDPOINT = "/api/apps";

const defaultErrorMapper = async (response: Response): Promise<string> => {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }
  }
  return response.statusText || "Asset upload failed";
};

const isAssetUploadResult = (value: unknown): value is AssetUploadResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as { url?: unknown };
  return typeof result.url === "string" && result.url.trim().length > 0;
};

const appendAsset = async (
  form: FormData,
  fieldName: string,
  input: AssetUploadInput,
  fetchImpl: typeof fetch,
): Promise<void> => {
  if (typeof File !== "undefined" && input instanceof File) {
    form.append(fieldName, input);
    return;
  }

  if (input instanceof Blob) {
    if (typeof File !== "undefined") {
      form.append(fieldName, new File([input], "asset", { type: input.type }));
    } else {
      form.append(fieldName, input);
    }
    return;
  }

  if (isNativeRuntime) {
    (form as ReactNativeFormData).append(fieldName, {
      uri: input.uri,
      name: input.name,
      type: input.type ?? "application/octet-stream",
    });
    return;
  }

  const assetResponse = await fetchImpl(input.uri);
  if (!assetResponse.ok) {
    throw new Error("Asset fetch failed");
  }
  const blob = await assetResponse.blob();
  if (typeof File !== "undefined") {
    form.append(fieldName, new File([blob], input.name, { type: input.type ?? blob.type }));
  } else {
    form.append(fieldName, blob);
  }
};

export const createAssetUploadHandler = (
  options: AssetUploadHandlerOptions = {},
): AssetUploadHandler => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fieldName = options.formFieldName ?? "file";
  const mapError = options.mapError ?? defaultErrorMapper;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const resolvedEndpoint =
    options.baseUrl && endpoint.startsWith("/")
      ? `${options.baseUrl.replace(/\/$/, "")}${endpoint}`
      : endpoint;

  return async (input: AssetUploadInput): Promise<AssetUploadResult> => {
    const form = new FormData();
    await appendAsset(form, fieldName, input, fetchImpl);

    const response = await fetchImpl(resolvedEndpoint, {
      method: "POST",
      body: form,
      headers: options.headers,
    });

    if (!response.ok) {
      throw new Error(await mapError(response));
    }

    const payload = await response.json().catch(() => null);
    if (!isAssetUploadResult(payload)) {
      throw new Error("Asset upload returned an invalid response");
    }

    return payload;
  };
};
