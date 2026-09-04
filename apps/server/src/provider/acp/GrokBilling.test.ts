import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";

import { parseGrokUsageReport } from "../providerUsage.ts";
import {
  grokCliProxyBaseUrl,
  grokHomeDirectory,
  isGrokAcpBillingUnsupported,
  parseGrokCachedAuth,
  readGrokCliProxyBilling,
} from "./GrokBilling.ts";

describe("parseGrokCachedAuth", () => {
  it("reads key and user_id from the grok login cache", () => {
    expect(
      parseGrokCachedAuth({
        "https://auth.x.ai::account": {
          key: "tok_live",
          user_id: "user-1",
          expires_at: "2099-01-01T00:00:00Z",
        },
      }),
    ).toEqual({ key: "tok_live", userId: "user-1" });
  });

  it("returns undefined when no entry has a token", () => {
    expect(parseGrokCachedAuth({})).toBeUndefined();
    expect(
      parseGrokCachedAuth({ "https://auth.x.ai::account": { user_id: "user-1" } }),
    ).toBeUndefined();
    expect(parseGrokCachedAuth(null)).toBeUndefined();
  });
});

describe("grokHomeDirectory", () => {
  it("prefers GROK_HOME over the default ~/.grok", () => {
    expect(grokHomeDirectory({ GROK_HOME: "D:\\grok-home", USERPROFILE: "C:\\Users\\me" })).toBe(
      "D:\\grok-home",
    );
  });

  it("uses USERPROFILE/.grok when GROK_HOME is unset", () => {
    expect(grokHomeDirectory({ USERPROFILE: "C:\\Users\\me" })?.replaceAll("\\", "/")).toBe(
      "C:/Users/me/.grok",
    );
  });
});

describe("grokCliProxyBaseUrl", () => {
  it("defaults to the public CLI chat proxy", () => {
    expect(grokCliProxyBaseUrl()).toBe("https://cli-chat-proxy.grok.com/v1");
  });

  it("honors GROK_CLI_CHAT_PROXY_BASE_URL", () => {
    expect(grokCliProxyBaseUrl({ GROK_CLI_CHAT_PROXY_BASE_URL: "https://proxy.example/v1/" })).toBe(
      "https://proxy.example/v1",
    );
  });
});

describe("isGrokAcpBillingUnsupported", () => {
  it("detects the stdio Method not found wrapping Grok 1.0.13 returns", () => {
    const error = EffectAcpErrors.AcpRequestError.internalError(
      "Extension request failed",
      undefined,
      {
        method: "x.ai/billing",
        operation: "receive-response",
        cause: [{ _tag: "Die", defect: { code: -32601, message: "Method not found" } }],
      },
    );
    expect(isGrokAcpBillingUnsupported(error)).toBe(true);
  });

  it("is false for other ACP failures", () => {
    const error = EffectAcpErrors.AcpRequestError.internalError("Failed to fetch billing data");
    expect(isGrokAcpBillingUnsupported(error)).toBe(false);
  });
});

it.layer(NodeServices.layer)("readGrokCliProxyBilling", (it) => {
  it.effect("GETs credits with the cached grok.com token and does not spend a turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const grokHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "grok-billing-" });
      yield* fileSystem.writeFileString(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::account": { key: "tok_test", user_id: "user-1" },
        }),
      );

      const requests: Array<{
        url: string;
        authorization: string;
        tokenAuth: string;
        userId: string;
      }> = [];
      const body = {
        config: {
          creditUsagePercent: 15,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-04T06:07:01.863557+00:00",
            end: "2026-09-11T06:07:01.863557+00:00",
          },
          onDemandCap: { val: 0 },
        },
      };
      const result = yield* readGrokCliProxyBilling({
        fileSystem,
        path,
        environment: { GROK_HOME: grokHome },
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          requests.push({
            url: String(input),
            authorization: headers.get("authorization") ?? "",
            tokenAuth: headers.get("x-xai-token-auth") ?? "",
            userId: headers.get("x-userid") ?? "",
          });
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      expect(requests).toEqual([
        {
          url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          authorization: "Bearer tok_test",
          tokenAuth: "xai-grok-cli",
          userId: "user-1",
        },
      ]);
      expect(parseGrokUsageReport(result)).toEqual({
        windows: [
          {
            key: "weekly",
            label: "Weekly",
            utilization: 0.15,
            resetsAt: Math.floor(Date.parse("2026-09-11T06:07:01.863557+00:00") / 1000),
          },
        ],
      });
    }),
  );
});
