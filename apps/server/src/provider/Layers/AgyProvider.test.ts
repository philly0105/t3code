import { describe, expect, it } from "@effect/vitest";

import { parseAgyModelsOutput } from "./AgyProvider.ts";

describe("parseAgyModelsOutput", () => {
  it("parses tab-separated slug and display name, skipping the fetch header", () => {
    const models = parseAgyModelsOutput(
      [
        "Fetching available models...",
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
        "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      ].join("\n"),
    );
    expect(models.map((model) => model.slug)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
    ]);
    expect(models[0]?.name).toBe("Gemini 3.7 Flash (High)");
    expect(models[0]?.isCustom).toBe(false);
  });

  it("falls back to the slug when no display name is present", () => {
    const models = parseAgyModelsOutput("gemini-3.7-flash-low");
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("gemini-3.7-flash-low");
  });

  it("returns an empty list for blank or header-only output", () => {
    expect(parseAgyModelsOutput("")).toEqual([]);
    expect(parseAgyModelsOutput("Fetching available models...")).toEqual([]);
  });
});
