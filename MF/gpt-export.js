(() => {
  "use strict";

  window.__MYFEED_GPT_EXPORT_VERSION__ = "5.0-gpt-text-final";

  const SUMMARY_MAX = 800;
  const BUTTON_ID = "gptExportBtn";

  function cleanCell(value) {
    return String(value ?? "")
      .replace(/\t/g, " ")
      .replace(/\r?\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function trimSummary(value) {
    const text = cleanCell(value);
    return text.length <= SUMMARY_MAX ? text : text.slice(0, SUMMARY_MAX) + "…";
  }

  function toIso(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? cleanCell(value) : date.toISOString();
  }

  function makeText(items) {
    const viewTitle = document.getElementById("viewTitle")?.textContent?.trim() || "MyFeed";
    const displayCount = document.getElementById("articleCount")?.textContent?.trim() || "";
    const exportedAt = new Date().toISOString();

    const lines = [
      "MYFEED_GPT_EXPORT",
      `TOTAL_ARTICLES: ${items.length}`,
      `EXPORTED_AT: ${exportedAt}`,
      `VIEW: ${cleanCell(viewTitle)}`,
      `DISPLAY_COUNT: ${cleanCell(displayCount)}`,
      "",
      "INSTRUCTION: Process every ARTICLE block from 1 through TOTAL_ARTICLES. Do not stop after a partial sample.",
      ""
    ];

    items.forEach((article, index) => {
      const number = index + 1;
      lines.push(
        `=== ARTICLE ${number} / ${items.length} ===`,
        `SOURCE: ${cleanCell(article.sourceName || article.source || "")}`,
        `PUBLISHED: ${toIso(article.publishedAt || article.published || "")}`,
        `TITLE: ${cleanCell(article.title || "")}`,
        `SUMMARY: ${trimSummary(article.description || article.summary || "")}`,
        `URL: ${cleanCell(article.url || "")}`,
        ""
      );
    });

    return lines.join("\r\n");
  }

  function makeFilename() {
    const d = new Date();
    const pad = value => String(value).padStart(2, "0");
    return `myfeed_gpt_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
  }

  function downloadText(text) {
    const blob = new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = makeFilename();
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function getExportItems() {
    if (typeof dbGetAllArticles !== "function") {
      throw new Error("記事データ取得機能が見つかりません");
    }
    if (typeof getFilteredArticles !== "function") {
      throw new Error("表示中の記事抽出機能が見つかりません");
    }

    const allArticles = await dbGetAllArticles();
    const filtered = getFilteredArticles(allArticles);

    return Array.isArray(filtered) ? filtered : [];
  }

  function installButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const refreshBtn = document.getElementById("refreshBtn");
    const actions = document.querySelector(".topbar-actions");
    if (!actions || !refreshBtn) return;

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.className = "ghost-btn";
    btn.textContent = "⇩ GPT用TXT";
    btn.title = "選択中のフォルダ/フィード等に該当する全記事をGPT向けTXTで出力";
    actions.insertBefore(btn, refreshBtn);

    btn.addEventListener("click", async () => {
      const defaultText = "⇩ GPT用TXT";
      btn.disabled = true;
      btn.textContent = "出力中…";

      try {
        const items = await getExportItems();
        if (!items.length) {
          btn.textContent = "記事なし";
          setTimeout(() => { btn.textContent = defaultText; }, 1800);
          return;
        }

        downloadText(makeText(items));
        btn.textContent = `✓ TXT ${items.length}件`;
        setTimeout(() => { btn.textContent = defaultText; }, 2200);
      } catch (error) {
        console.error("[MyFeed GPT Export]", error);
        btn.textContent = "出力失敗";
        btn.title = String(error?.message || error);
        setTimeout(() => {
          btn.textContent = defaultText;
          btn.title = "選択中のフォルダ/フィード等に該当する全記事をGPT向けTXTで出力";
        }, 2500);
      } finally {
        setTimeout(() => { btn.disabled = false; }, 300);
      }
    });
  }

  installButton();

  const observer = new MutationObserver(() => {
    if (!document.getElementById(BUTTON_ID)) installButton();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
