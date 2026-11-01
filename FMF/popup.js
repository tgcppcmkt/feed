const STORAGE_KEY = "feedlyCollectorArticles";
const SESSION_KEY = "feedlyCollectorSessionStartedAt";
const EXPECTED_CONTENT_VERSION = "0.5.1";

const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const scanBtn = document.getElementById("scan");
const exportBtn = document.getElementById("exportTsv");

function setStatus(message) {
  statusEl.textContent = message;
}

async function refreshCount() {
  const obj = await chrome.storage.local.get([STORAGE_KEY]);
  const items = Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
  countEl.textContent = String(items.length);
  return items;
}

async function getFeedlyTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("アクティブタブがありません");
  if (!/^https:\/\/([^/]+\.)?feedly\.com\//i.test(tab.url || "")) {
    throw new Error("Feedlyのタブで実行してください");
  }
  return tab;
}

async function ping(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "FGC_PING" });
  } catch {
    return null;
  }
}

async function ensureInjected() {
  const tab = await getFeedlyTab();
  let response = await ping(tab);
  if (response?.ok && response.version === EXPECTED_CONTENT_VERSION) {
    return tab;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ["content.js"]
  });
  await new Promise(resolve => setTimeout(resolve, 250));

  response = await ping(tab);
  if (!response?.ok) throw new Error("Feedlyへ接続できませんでした");
  return tab;
}

function cleanCell(value) {
  return String(value ?? "")
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function makeTsv(items) {
  const lines = [["ID", "source", "published", "title", "summary", "url"].join("\t")];
  items.forEach((item, index) => {
    lines.push([
      index + 1,
      cleanCell(item.source),
      cleanCell(item.published),
      cleanCell(item.title),
      cleanCell(item.summary),
      cleanCell(item.url)
    ].join("\t"));
  });
  return lines.join("\r\n");
}

function makeFilename() {
  const d = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `feedly_gpt_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.tsv`;
}

async function downloadTsv(items) {
  const blob = new Blob(["\uFEFF", makeTsv(items)], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: makeFilename(), saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function resetSession() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: [],
    [SESSION_KEY]: new Date().toISOString()
  });
  countEl.textContent = "0";
  setStatus("前回の取得データをクリアしました。スキャンしてください。");
}

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  setStatus("スキャン中...");
  try {
    const tab = await ensureInjected();
    const result = await chrome.tabs.sendMessage(tab.id, { type: "FGC_SCAN" });
    if (!result?.ok) throw new Error("スキャン結果を取得できませんでした");
    await refreshCount();
    setStatus(`候補 ${result.candidates}件 / 追加 ${result.added}件 / 合計 ${result.count}件`);
  } catch (error) {
    setStatus(`スキャン失敗：${error.message || error}`);
  } finally {
    scanBtn.disabled = false;
  }
});

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  try {
    const items = await refreshCount();
    if (!items.length) {
      setStatus("出力する記事がありません。先にスキャンしてください。");
      return;
    }
    await downloadTsv(items);
    setStatus(`${items.length}件をTSVで出力しました。`);
  } catch (error) {
    setStatus(`TSV出力失敗：${error.message || error}`);
  } finally {
    exportBtn.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) refreshCount();
});

resetSession().catch(error => {
  setStatus(`初期化失敗：${error.message || error}`);
});
