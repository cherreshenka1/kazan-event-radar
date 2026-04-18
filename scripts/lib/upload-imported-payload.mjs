import fs from "node:fs/promises";

export async function uploadImportedPayloadInChunks(apiBaseUrl, payload, options = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return {
      ok: true,
      imported: 0,
      chunks: 0,
      failed: []
    };
  }

  const safeChunkSize = Math.max(1, Number(options.chunkSize) || 10);
  const pauseMs = Math.max(0, Number(options.pauseMs) || 800);
  const retries = Math.max(1, Number(options.retries) || 6);
  const continueOnError = options.continueOnError !== false;
  const log = typeof options.log === "function" ? options.log : () => {};

  let imported = 0;
  let chunks = 0;
  let lastResult = null;
  const failed = [];

  for (let index = 0; index < items.length; index += safeChunkSize) {
    const chunk = items.slice(index, index + safeChunkSize);
    const chunkNumber = Math.floor(index / safeChunkSize) + 1;
    const totalChunks = Math.ceil(items.length / safeChunkSize);
    const chunkMode = payload.mode === "replace_source" && index > 0 ? "merge" : payload.mode;

    const result = await uploadChunkSmart(apiBaseUrl, {
      ...payload,
      mode: chunkMode,
      items: chunk
    }, {
      retries,
      pauseMs,
      continueOnError,
      log
    }, failed, `chunk ${chunkNumber}/${totalChunks}`);

    imported += Number(result?.imported || 0);
    lastResult = result?.lastResult || lastResult;
    chunks += 1;
    log(`Uploaded chunk ${chunkNumber}/${totalChunks}: ${Number(result?.imported || 0)}/${chunk.length} (${chunkMode})`);

    if (pauseMs && index + safeChunkSize < items.length) {
      await sleep(pauseMs);
    }
  }

  return {
    ...(lastResult || { ok: true }),
    imported,
    chunks,
    failed
  };
}

export async function postImportedPayload(apiBaseUrl, payload, options = {}) {
  const user = options.user || process.env.ANALYTICS_USERNAME || "admin";
  const password = options.password || process.env.ANALYTICS_PASSWORD || "";

  if (!password) {
    throw new Error("ANALYTICS_PASSWORD is not configured.");
  }

  if (!apiBaseUrl) {
    throw new Error("WORKER_API_BASE_URL is not configured.");
  }

  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/admin/import-events`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(options.timeoutMs) || 60000)
  });

  const raw = await response.text();
  let result = {};

  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    result = {};
  }

  if (!response.ok) {
    const fallbackMessage = raw
      ? raw.slice(0, 220).replace(/\s+/g, " ").trim()
      : `Import failed with HTTP ${response.status}`;
    throw new Error(result.error || fallbackMessage || `Import failed with HTTP ${response.status}`);
  }

  return result;
}

export async function readMiniAppApiBaseUrl(configPath) {
  try {
    const file = await fs.readFile(configPath, "utf8");
    return file.match(/apiBaseUrl:\s*"([^"]+)"/)?.[1] || "";
  } catch {
    return "";
  }
}

async function postImportedPayloadWithRetry(apiBaseUrl, payload, options) {
  const log = typeof options.log === "function" ? options.log : () => {};
  let lastError = null;

  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      return await postImportedPayload(apiBaseUrl, payload, options);
    } catch (error) {
      lastError = error;
      if (attempt >= options.retries) break;
      log(`Retry ${attempt}/${options.retries - 1} after error: ${error.message}`);
      await sleep(1000 * attempt);
    }
  }

  throw lastError || new Error("Upload failed.");
}

async function uploadChunkSmart(apiBaseUrl, payload, options, failed, label) {
  try {
    const lastResult = await postImportedPayloadWithRetry(apiBaseUrl, payload, options);
    return {
      imported: Number(lastResult?.imported || payload.items.length),
      lastResult
    };
  } catch (error) {
    const items = Array.isArray(payload?.items) ? payload.items : [];

    if (items.length > 1) {
      options.log?.(`${label}: splitting ${items.length} items after error: ${error.message}`);
      const middle = Math.ceil(items.length / 2);
      const left = await uploadChunkSmart(apiBaseUrl, {
        ...payload,
        items: items.slice(0, middle)
      }, options, failed, `${label}a`);
      if (options.pauseMs) await sleep(options.pauseMs);
      const right = await uploadChunkSmart(apiBaseUrl, {
        ...payload,
        items: items.slice(middle)
      }, options, failed, `${label}b`);

      return {
        imported: Number(left?.imported || 0) + Number(right?.imported || 0),
        lastResult: right?.lastResult || left?.lastResult || null
      };
    }

    const failedItem = items[0] || {};
    failed.push({
      url: failedItem.url || null,
      title: failedItem.title || null,
      error: error.message
    });

    if (!options.continueOnError) {
      throw error;
    }

    options.log?.(`${label}: skipped 1 item after repeated error: ${failedItem.title || failedItem.url || "unknown item"}`);
    return {
      imported: 0,
      lastResult: null
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
