export type AiChatMessage = {
  role: "system" | "user" | "assistant" | string;
  content: string;
};

export type AiJsonObjectResult = {
  ok: true;
  object: Record<string, unknown>;
  provider: string;
  model: string;
} | {
  ok: false;
  error: string;
  detail?: string;
  provider?: string;
  model?: string;
  status?: number;
};

type AiProviderConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  provider: string;
};

export async function requestAiJsonObject(messages: AiChatMessage[]): Promise<Record<string, unknown> | null> {
  const result = await requestAiJsonObjectWithDiagnostics(messages);
  return result.ok ? result.object : null;
}

export async function requestAiJsonObjectWithDiagnostics(messages: AiChatMessage[]): Promise<AiJsonObjectResult> {
  const config = aiProviderConfig();
  if (!config) return { ok: false, error: "missing_ai_api_key" };

  const attempts = shouldRetryWithoutJsonMode()
    ? [
      { name: "json_mode", useJsonMode: true, messages },
      { name: "minimal", useJsonMode: false, messages },
      { name: "compact", useJsonMode: false, messages: compactMessages(messages) },
    ]
    : [{ name: "json_mode", useJsonMode: true, messages }];
  const urls = chatCompletionUrls(config.baseUrl, config.provider);

  let lastFailure: AiJsonObjectResult = { ok: false, error: "not_attempted", provider: config.provider, model: config.model };
  for (const url of urls) {
    for (const attempt of attempts) {
      const result = await requestAiJsonObjectAttempt(config, attempt.messages, `${url.label}_${attempt.name}`, attempt.useJsonMode, url.href);
      if (result.ok) return result;
      lastFailure = result;
      if (result.status === 401 || result.status === 403) return result;
    }
  }

  return lastFailure;
}

function aiProviderConfig(): AiProviderConfig | null {
  const apiKey = envString("AI_API_KEY")
    ?? envString("MAAS_API_KEY")
    ?? envString("WOLF_AI_API_KEY");
  if (!apiKey) return null;

  const baseUrl = (envString("AI_API_BASE_URL")
    ?? envString("MAAS_API_BASE_URL")
    ?? "https://maas-api.cn-huabei-1.xf-yun.com/v2").replace(/\/+$/, "");
  const provider = (envString("AI_PROVIDER") ?? (baseUrl.includes("maas-api") ? "maas" : "openai-compatible")).toLowerCase();

  return {
    apiKey,
    baseUrl,
    model: envString("AI_MODEL_ID") ?? envString("AI_MODEL") ?? envString("MAAS_MODEL_ID") ?? envString("WOLF_AI_MODEL") ?? "fast",
    timeoutMs: positiveNumber(envString("AI_TIMEOUT_MS") ?? envString("MAAS_TIMEOUT_MS"), 12000),
    temperature: finiteNumber(envString("AI_TEMPERATURE") ?? envString("MAAS_TEMPERATURE"), 0.7),
    maxTokens: positiveNumber(envString("AI_MAX_TOKENS") ?? envString("MAAS_MAX_TOKENS"), 384),
    provider,
  };
}

function aiHeaders(config: AiProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
  };

  const extraHeaders = parseJsonEnv("AI_EXTRA_HEADERS_JSON");
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (typeof value === "string") headers[key] = value;
  }

  const loraId = envString("AI_LORA_ID") ?? envString("MAAS_LORA_ID");
  if (loraId && !headers.lora_id) headers.lora_id = loraId;

  return headers;
}

async function requestAiJsonObjectAttempt(
  config: AiProviderConfig,
  messages: AiChatMessage[],
  attempt: string,
  useJsonMode: boolean,
  endpoint: string,
): Promise<AiJsonObjectResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: aiHeaders(config),
      signal: controller.signal,
      body: JSON.stringify(aiRequestBody(config, messages, useJsonMode)),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = httpErrorDetail(body);
      console.warn("AI provider HTTP error", {
        provider: config.provider,
        model: config.model,
        attempt,
        status: response.status,
        endpoint: endpointLabel(endpoint),
        body: body.slice(0, 500),
      });
      return {
        ok: false,
        error: `${attempt}_http_${response.status}`,
        detail,
        provider: config.provider,
        model: config.model,
        status: response.status,
      };
    }

    const data = await response.json();
    const content = responseContent(data);
    if (!content) {
      console.warn("AI provider returned no message content", {
        provider: config.provider,
        model: config.model,
        attempt,
        endpoint: endpointLabel(endpoint),
      });
      return { ok: false, error: `${attempt}_empty_content`, provider: config.provider, model: config.model };
    }

    const object = parseJsonObject(content);
    if (!object) {
      console.warn("AI provider returned invalid JSON content", {
        provider: config.provider,
        model: config.model,
        attempt,
        endpoint: endpointLabel(endpoint),
        content: content.slice(0, 500),
      });
      return { ok: false, error: `${attempt}_invalid_json`, provider: config.provider, model: config.model };
    }

    return { ok: true, object, provider: config.provider, model: config.model };
  } catch (error) {
    const reason = error instanceof DOMException && error.name === "AbortError"
      ? "timeout"
      : error instanceof Error ? error.name || "fetch_error" : "fetch_error";
    console.warn("AI provider request failed", {
      provider: config.provider,
      model: config.model,
      attempt,
      endpoint: endpointLabel(endpoint),
      error: reason,
    });
    return { ok: false, error: `${attempt}_${reason}`, provider: config.provider, model: config.model };
  } finally {
    clearTimeout(timeout);
  }
}

function chatCompletionUrls(baseUrl: string, provider: string): Array<{ href: string; label: string }> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const primary = normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
  const urls = [{ href: primary, label: versionLabel(primary) }];

  if (provider === "maas" && envString("AI_TRY_ALTERNATE_API_VERSION") === "true") {
    const alternate = primary.includes("/v2/")
      ? primary.replace("/v2/", "/v1/")
      : primary.includes("/v1/")
        ? primary.replace("/v1/", "/v2/")
        : "";
    if (alternate && alternate !== primary) urls.push({ href: alternate, label: versionLabel(alternate) });
  }

  return urls;
}

function httpErrorDetail(body: string): string {
  if (!body.trim()) return "";
  try {
    const parsed = asRecord(JSON.parse(body));
    const error = asRecord(parsed.error);
    const message = typeof error.message === "string"
      ? error.message
      : typeof parsed.message === "string" ? parsed.message : "";
    const type = typeof error.type === "string" ? error.type : "";
    return [type, message].filter(Boolean).join(": ").slice(0, 500);
  } catch {
    return body.replace(/\s+/g, " ").trim().slice(0, 500);
  }
}

function compactMessages(messages: AiChatMessage[]): AiChatMessage[] {
  return [{
    role: "user",
    content: messages
      .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
      .join("\n\n"),
  }];
}

function versionLabel(endpoint: string): string {
  if (endpoint.includes("/v1/")) return "v1";
  if (endpoint.includes("/v2/")) return "v2";
  return "configured";
}

function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return endpoint.slice(0, 120);
  }
}

function aiRequestBody(config: AiProviderConfig, messages: AiChatMessage[], useJsonMode: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };

  if (useJsonMode) {
    body.response_format = { type: "json_object" };
  }

  if (useJsonMode && config.provider === "maas") {
    body.search_disable = true;
  }

  return {
    ...body,
    ...parseJsonEnv("AI_EXTRA_BODY_JSON"),
  };
}

function shouldRetryWithoutJsonMode(): boolean {
  return Deno.env.get("AI_RETRY_WITHOUT_JSON_MODE") !== "false";
}

function responseContent(data: unknown): string {
  const payload = asRecord(data);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice.message);
  const openAiContent = message.content;
  if (typeof openAiContent === "string") return openAiContent;
  if (openAiContent && typeof openAiContent === "object") return JSON.stringify(openAiContent);

  const anthropicContent = Array.isArray(payload.content) ? payload.content : [];
  const textParts = anthropicContent
    .map((part) => asRecord(part).text)
    .filter((text): text is string => typeof text === "string");
  return textParts.join("\n");
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  if (!content.trim()) return null;
  const trimmed = content.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : trimmed.slice(Math.max(0, trimmed.indexOf("{")), trimmed.lastIndexOf("}") + 1);
  if (!jsonText.trim()) return null;

  try {
    const parsed = JSON.parse(jsonText);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function parseJsonEnv(name: string): Record<string, unknown> {
  const value = envString(name);
  if (!value?.trim()) return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function envString(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const numberValue = finiteNumber(value, fallback);
  return numberValue > 0 ? numberValue : fallback;
}

function finiteNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
