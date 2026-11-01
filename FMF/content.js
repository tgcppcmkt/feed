
(() => {
  if (window.__FEEDLY_GPT_COLLECTOR_V051__) {
    chrome.runtime.sendMessage({type:"FGC_READY", reused:true, url:location.href}).catch(()=>{});
    return;
  }
  window.__FEEDLY_GPT_COLLECTOR_V051__ = true;

  const STORAGE_KEY = "feedlyCollectorArticles";
  const SESSION_KEY = "feedlyCollectorSessionStartedAt";
  
  const norm = s => (s || "").replace(/\s+/g, " ").replace(/\u200b/g, "").trim();
  const cleanUrl = href => {
    try {
      const u = new URL(href, location.href);
      u.hash = "";
      return u.href;
    } catch { return ""; }
  };
  const visible = el => {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };

  function isFeedlyUtilityUrl(href) {
    try {
      const u = new URL(href, location.href);
      if (!/(^|\.)feedly\.com$/i.test(u.hostname)) return false;
      return /\/i\/(?:subscription|discover|explore|sources?|collection|boards?)(?:\/|$)/i.test(u.pathname)
        || /\/(?:discover|explore)(?:\/|$)/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  function isExplicitArticleContainer(el) {
    if (!(el instanceof Element)) return false;
    return el.matches(
      "article,[role='article'],[data-entry-id],[data-entryid],[data-testid*='entry' i],[data-testid*='article' i],[class*='entry' i],[class*='article' i],[class*='story' i]"
    );
  }

  function looksLikeAuxiliaryCard(anchor, container) {
    if (!container) return true;
    const text = norm(container.innerText || container.textContent);

    // Feed/source recommendation cards commonly contain follower counts.
    if (/\bfollowers?\b/i.test(text)) return true;
    if (isFeedlyUtilityUrl(anchor.href)) return true;

    // Exclude recommendation/sidebar/right-rail UI unless Feedly explicitly marks it as an article.
    let p = container;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
      const marker = norm([
        p.id, p.className, p.getAttribute?.("role"), p.getAttribute?.("aria-label"), p.getAttribute?.("data-testid")
      ].filter(Boolean).join(" ")).toLowerCase();
      if (/recommend|suggest|related|discover|explore|subscription|sidebar|right[-_ ]?rail/.test(marker)) {
        if (!isExplicitArticleContainer(container)) return true;
      }
    }

    // Final guard for Feedly's recommendation rail: a narrow card far to the right is not a stream article.
    if (!isExplicitArticleContainer(container)) {
      const r = container.getBoundingClientRect();
      if (window.innerWidth > 900 && r.left > window.innerWidth * 0.58 && r.width < window.innerWidth * 0.42) {
        return true;
      }
    }

    return false;
  }

  async function initSession() {
    const obj = await chrome.storage.local.get([SESSION_KEY]);
    if (!obj[SESSION_KEY]) {
      await chrome.storage.local.set({[SESSION_KEY]: new Date().toISOString()});
    }
  }

  function score(a) {
    if (!visible(a)) return -999;
    if (a.closest("nav,aside,header,[role='navigation']")) return -20;
    const text = norm(a.innerText || a.textContent);
    const href = cleanUrl(a.href);
    if (!text || text.length < 5 || text.length > 500 || !href) return -999;

    let s = 0;
    if (text.length >= 10) s += 2;
    if (text.length >= 20) s += 2;
    if (text.length >= 40) s += 1;
    if (!new URL(href).hostname.endsWith("feedly.com")) s += 10;
    if (/\/i\/entry\//i.test(href)) s += 10;

    const cls = `${a.className || ""} ${a.parentElement?.className || ""}`.toLowerCase();
    if (/title|headline|entry|article|story/.test(cls)) s += 4;
    if (a.closest("article,[role='article'],[data-entry-id],[data-entryid],[class*='entry' i],[class*='article' i]")) s += 4;

    if (/settings|account|profile|discover|boards|sources|collection/i.test(href)) s -= 15;
    return s;
  }

  function findContainer(a) {
    let c = a.closest("article,[role='article'],[data-entry-id],[data-entryid],[data-testid*='entry' i],[data-testid*='article' i],[class*='entry' i],[class*='article' i],[class*='story' i]");
    if (c) return c;
    let p = a;
    for (let i=0; i<7 && p; i++, p=p.parentElement) {
      const t = norm(p.innerText || p.textContent);
      const n = p.querySelectorAll?.("a[href]")?.length || 0;
      if (t.length >= 15 && t.length <= 2500 && n >= 1 && n <= 20) return p;
    }
    return a.parentElement || a;
  }

  function extractFromAnchor(a, container = findContainer(a)) {
    let title = norm(a.innerText || a.textContent);

    for (const el of container.querySelectorAll?.("h1,h2,h3,h4,[role='heading'],[class*='title' i],[data-testid*='title' i]") || []) {
      const t = norm(el.innerText || el.textContent);
      if (t.length >= 5 && t.length <= 350 && t.length > title.length) title = t;
    }

    let source = "";
    for (const el of container.querySelectorAll?.("[class*='source' i],[class*='origin' i],[class*='feed' i],[data-testid*='source' i]") || []) {
      const t = norm(el.innerText || el.textContent);
      if (t && t.length <= 160) { source = t; break; }
    }

    let published = "";
    const time = container.querySelector?.("time");
    if (time) published = time.getAttribute("datetime") || norm(time.textContent);

    let summary = "";
    for (const el of container.querySelectorAll?.("p,[class*='summary' i],[class*='description' i],[class*='excerpt' i]") || []) {
      const t = norm(el.innerText || el.textContent);
      if (t && t !== title && t.length >= 20 && t.length <= 1200 && t.length > summary.length) summary = t;
    }

    return {title, url: cleanUrl(a.href), source, published, summary};
  }

  function collectCandidates() {
    // First, keep only the best anchor from each visible article card.
    // Feedly can render both image/title links (and sometimes internal/external links)
    // for the same card; counting by URL alone can otherwise produce +1 duplicates.
    const bestByContainer = new Map();

    for (const a of document.querySelectorAll("a[href]")) {
      const s = score(a);
      if (s < 5) continue;

      const container = findContainer(a);
      if (!container || !visible(container)) continue;
      if (looksLikeAuxiliaryCard(a, container)) continue;

      const item = extractFromAnchor(a, container);
      if (!item.title || !item.url) continue;

      const prev = bestByContainer.get(container);
      if (!prev || s > prev._score) {
        bestByContainer.set(container, {...item, _score:s});
      }
    }

    // Then dedupe across cards by canonical URL OR normalized title.
    // This catches Feedly virtual-DOM duplicates that may coexist briefly while switching views.
    const result = [];
    const byUrl = new Map();
    const byTitle = new Map();

    for (const item of bestByContainer.values()) {
      const urlKey = item.url;
      const titleKey = norm(item.title).toLocaleLowerCase();
      const prevIndex = byUrl.has(urlKey)
        ? byUrl.get(urlKey)
        : (titleKey.length >= 8 && byTitle.has(titleKey) ? byTitle.get(titleKey) : -1);

      if (prevIndex >= 0) {
        if (item._score > result[prevIndex]._score) result[prevIndex] = item;
        continue;
      }

      const index = result.length;
      result.push(item);
      byUrl.set(urlKey, index);
      if (titleKey.length >= 8) byTitle.set(titleKey, index);
    }

    return result;
  }

  async function scan() {
    const obj = await chrome.storage.local.get([STORAGE_KEY]);
    const existing = Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
    const map = new Map(existing.map(x => [x.url || x.title, x]));
    const candidates = collectCandidates();
    let added = 0;
    const now = new Date().toISOString();

    for (const c of candidates) {
      const key = c.url || c.title;
      if (!map.has(key)) {
        map.set(key, {
          title:c.title, url:c.url, source:c.source || "",
          published:c.published || "", summary:c.summary || "",
          collectedAt:now
        });
        added++;
      }
    }
    if (added) await chrome.storage.local.set({[STORAGE_KEY]: [...map.values()]});

    chrome.runtime.sendMessage({
      type:"FGC_SCAN_RESULT",
      count:map.size,
      candidates:candidates.length,
      added,
      url:location.href
    }).catch(()=>{});

    return {count:map.size, candidates:candidates.length, added};
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg?.type === "FGC_PING") sendResponse({ok:true, url:location.href, version:"0.5.1"});
      if (msg?.type === "FGC_SCAN") sendResponse({ok:true, ...(await scan())});
    })();
    return true;
  });

  initSession();
  chrome.runtime.sendMessage({type:"FGC_READY", reused:false, url:location.href}).catch(()=>{});
})();
