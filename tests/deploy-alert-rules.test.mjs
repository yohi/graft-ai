import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deployAlertRuleFile,
  parseCliArgs,
  prepareAlertRule,
} from "../scripts/deploy-alert-rules.mjs";

test("default alert deployment targets include Ollama and OTel rules", () => {
  const parsed = parseCliArgs([]);

  assert.deepEqual(parsed, {
    dryRun: false,
    targetFiles: [
      "grafana/alerts/graft-ai-ollama-cloud-rules.json",
      "grafana/alerts/graft-ai-otel-rules.json",
    ],
  });
});

test("prepareAlertRule replaces the file org id with the active Grafana org", () => {
  const rule = { uid: "example", orgId: 1, title: "Example" };

  assert.deepEqual(prepareAlertRule(rule, 42), {
    uid: "example",
    orgId: 42,
    title: "Example",
  });
});

test("normalizes explicit general folder UID and preserves custom UIDs", async () => {
  for (const [configuredFolderUid, expectedFolderUid] of [
    ["general", "graft-ai-alerts"],
    ["custom-alerts", "custom-alerts"],
  ]) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/api/org/")) {
        return jsonResponse({ id: 42 });
      }
      if (url.endsWith(`/api/folders/${expectedFolderUid}`)) {
        return jsonResponse({ uid: expectedFolderUid });
      }
      if (url.endsWith("/api/v1/provisioning/alert-rules")) {
        return jsonResponse([]);
      }
      return jsonResponse({ status: "success" });
    };

    await deployAlertRuleFile("grafana/alerts/graft-ai-otel-rules.json", {
      grafanaUrl: "https://grafana.example",
      token: "test-token",
      folderUid: configuredFolderUid,
      fetchImpl,
    });

    const folderLookupCall = calls.find(({ url }) =>
      url.endsWith(`/api/folders/${expectedFolderUid}`),
    );
    assert.ok(folderLookupCall);
    assert.equal(
      folderLookupCall.url,
      `https://grafana.example/api/folders/${expectedFolderUid}`,
    );

    const ruleCreateCall = calls.find(
      ({ url, options }) =>
        url.endsWith("/api/v1/provisioning/alert-rules") &&
        options.method === "POST",
    );
    assert.ok(ruleCreateCall);
    assert.equal(
      JSON.parse(ruleCreateCall.options.body).folderUID,
      expectedFolderUid,
    );
  }
});

test("creates the alert folder before deploying rules", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/org/")) {
      return jsonResponse({ id: 42 });
    }
    if (url.endsWith("/api/folders/graft-ai-alerts")) {
      return jsonResponse({ message: "folder not found" }, 404);
    }
    if (url.endsWith("/api/folders")) {
      return jsonResponse(
        { uid: "graft-ai-alerts", title: "graft-ai Alerts" },
        200,
      );
    }
    if (url.endsWith("/api/v1/provisioning/alert-rules")) {
      return jsonResponse([]);
    }
    return jsonResponse({ status: "success" });
  };

  await deployAlertRuleFile("grafana/alerts/graft-ai-otel-rules.json", {
    grafanaUrl: "https://grafana.example",
    token: "test-token",
    fetchImpl,
  });

  const folderCreateCalls = calls.filter(
    ({ url, options }) =>
      url.endsWith("/api/folders") && options.method === "POST",
  );
  assert.equal(folderCreateCalls.length, 1);
  assert.deepEqual(JSON.parse(folderCreateCalls[0].options.body), {
    uid: "graft-ai-alerts",
    title: "graft-ai Alerts",
  });

  const ruleCreateCall = calls.find(
    ({ url, options }) =>
      url.endsWith("/api/v1/provisioning/alert-rules") &&
      options.method === "POST",
  );
  assert.equal(
    JSON.parse(ruleCreateCall.options.body).folderUID,
    "graft-ai-alerts",
  );
});

test("continues when a concurrent deployment creates the alert folder", async () => {
  const calls = [];
  let folderLookups = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/org/")) {
      return jsonResponse({ id: 42 });
    }
    if (url.endsWith("/api/folders/graft-ai-alerts")) {
      folderLookups += 1;
      return folderLookups === 1
        ? jsonResponse({ message: "folder not found" }, 404)
        : jsonResponse({ uid: "graft-ai-alerts" });
    }
    if (url.endsWith("/api/folders")) {
      return jsonResponse(
        { message: "the folder has been changed by someone else" },
        412,
      );
    }
    if (url.endsWith("/api/v1/provisioning/alert-rules")) {
      return jsonResponse([]);
    }
    return jsonResponse({ status: "success" });
  };

  const result = await deployAlertRuleFile(
    "grafana/alerts/graft-ai-otel-rules.json",
    {
      grafanaUrl: "https://grafana.example",
      token: "test-token",
      fetchImpl,
    },
  );

  assert.equal(result.success, true);
  assert.equal(folderLookups, 2);
  assert.equal(
    calls.filter(({ url }) => url.endsWith("/api/folders")).length,
    1,
  );
});

test("dry-run validates an alert rule file without Grafana credentials", async () => {
  const result = await deployAlertRuleFile(
    "grafana/alerts/graft-ai-otel-rules.json",
    {
      dryRun: true,
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.ruleCount, 4);
});

test("deploys existing alert rules with PUT and new rules with POST", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/org/")) {
      return jsonResponse({ id: 42 });
    }
    if (url.endsWith("/api/v1/provisioning/alert-rules")) {
      return jsonResponse([{ uid: "graft-otel-backend-export-exhausted" }]);
    }
    return jsonResponse({ status: "success" });
  };

  const result = await deployAlertRuleFile(
    "grafana/alerts/graft-ai-otel-rules.json",
    {
      grafanaUrl: "https://grafana.example",
      token: "test-token",
      fetchImpl,
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.ruleCount, 4);
  assert.equal(calls.length, 7);
  assert.equal(calls[3].options.method, "PUT");
  assert.equal(calls[4].options.method, "POST");
  assert.equal(calls[5].options.method, "POST");
  assert.equal(calls[6].options.method, "POST");
  assert.equal(JSON.parse(calls[3].options.body).orgId, 42);
  assert.equal(calls[3].options.headers.Authorization, "Bearer test-token");
});

test("uses a fresh timeout for each request during a slow deployment", async () => {
  const calls = [];
  const requestDelayMs = 10;
  const timeoutMs = 30;
  const fetchImpl = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(options.signal?.reason ?? new Error("request aborted"));
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        calls.push({ url, options });
        const value = url.endsWith("/api/org/")
          ? { id: 42 }
          : url.endsWith("/api/v1/provisioning/alert-rules") &&
              options.method === "GET"
            ? []
            : {};
        resolve(jsonResponse(value));
      }, requestDelayMs);

      if (options.signal?.aborted) {
        onAbort();
      } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
      }
    });

  const result = await deployAlertRuleFile(
    "grafana/alerts/graft-ai-otel-rules.json",
    {
      grafanaUrl: "https://grafana.example",
      token: "test-token",
      fetchImpl,
      timeoutMs,
    },
  );

  assert.equal(result.success, true);
  assert.equal(calls.length, 7);
  assert.equal(
    new Set(calls.map(({ options }) => options.signal)).size,
    calls.length,
  );
});

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    },
  };
}
