import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api provider preset client", () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps generic presets and official presets from the API response", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        presets: {
          openai: {
            base_url: "https://api.openai.com/v1",
            models_path: "/models",
            auth_header: "Bearer",
          },
        },
        official_presets: {
          "opencode-go-openai": {
            label: "OpenCode Go (OpenAI)",
            description: "Preset",
            type: "openai",
            base_url: "https://opencode.ai/zen/go/v1",
            docs_url: "https://opencode.ai/docs/ko/go/",
            api_key_hint: "Use an OpenCode Go direct API key for this endpoint.",
            api_key_placeholder: "sk-...",
            fallback_models: ["glm-5", "kimi-k2.5"],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const api = await import("./api");
    const catalog = await api.getApiProviderPresets();

    expect(catalog.presets.openai.base_url).toBe("https://api.openai.com/v1");
    expect(catalog.official_presets["opencode-go-openai"]).toMatchObject({
      type: "openai",
      base_url: "https://opencode.ai/zen/go/v1",
      fallback_models: ["glm-5", "kimi-k2.5"],
    });
  });
});
