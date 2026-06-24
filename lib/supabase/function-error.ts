import { FunctionsHttpError } from "@supabase/supabase-js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isResponse(value: unknown): value is Response {
  if (!isRecord(value)) return false;
  const response = value as { clone?: unknown; headers?: { get?: unknown } };
  return typeof response.clone === "function" && typeof response.headers?.get === "function";
}

function isFunctionsHttpError(error: unknown): error is Error & { context: unknown } {
  return (
    error instanceof FunctionsHttpError ||
    (error instanceof Error && error.name === "FunctionsHttpError" && "context" in error)
  );
}

function stringMessage(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function messageFromPayload(payload: unknown) {
  if (typeof payload === "string") return stringMessage(payload);
  if (!isRecord(payload)) return null;
  return stringMessage(payload.error) ?? stringMessage(payload.message);
}

function messageFromJsonText(text: string) {
  try {
    return messageFromPayload(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function edgeFunctionErrorMessage(error: unknown) {
  if (!isFunctionsHttpError(error) || !isResponse(error.context)) return null;

  const response = error.context;
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      return messageFromPayload(await response.clone().json());
    }

    const text = (await response.clone().text()).trim();
    if (!text) return null;
    return messageFromJsonText(text) ?? text;
  } catch {
    return null;
  }
}
