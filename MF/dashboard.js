const DB_NAME = 'myfeed-db';
const DB_VERSION = 1;
const ARTICLE_STORE = 'articles';
const PAGE_SIZE = 50;
const IMAGE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_ENRICH_CONCURRENCY = 3;
const DEDUPE_VERSION = 1;
const DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEDUPE_MAX_ARTICLES = 2500;
const DEDUPE_SIMILARITY = 0.76;
const CACHE_RETENTION_MS = 72 * 60 * 60 * 1000;
const BACKUP_FORMAT = 'myfeed-backup';
const BACKUP_VERSION = 1;
const APP_VERSION = '0.3.0';

function v031StartupViewFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const view = params.get('view') || '';
    if (view === 'source') {
      return { filter: 'all', sourceId: params.get('source') || '', categoryId: null, favoriteCategoryId: null };
    }
    if (view === 'category') {
      const raw = params.get('category');
      return { filter: 'all', sourceId: '', categoryId: raw === '__uncategorized__' ? '' : (raw || null), favoriteCategoryId: null };
    }
    return { filter: 'all', sourceId: '', categoryId: null, favoriteCategoryId: null };
  } catch {
    return { filter: 'all', sourceId: '', categoryId: null, favoriteCategoryId: null };
  }
}

const V031_STARTUP_VIEW = v031StartupViewFromUrl();
let currentFilter = V031_STARTUP_VIEW.filter;
let currentSourceId = V031_STARTUP_VIEW.sourceId;
let currentCategoryId = V031_STARTUP_VIEW.categoryId;
let currentFavoriteCategoryId = V031_STARTUP_VIEW.favoriteCategoryId;
let renderedLimit = PAGE_SIZE;
let autoRefreshTimer = null;
let cacheCleanupTimer = null;
let imageObserver = null;
let imageEnrichActive = 0;
const imageEnrichQueue = [];
const imageEnrichQueued = new Set();
let renderedArticleMap = new Map();
let currentRenderSources = [];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const elements = {
  navList: $('#navList'),
  sourceNav: $('#sourceNav'),
  viewTitle: $('#viewTitle'),
  statusText: $('#statusText'),
  searchInput: $('#searchInput'),
  refreshBtn: $('#refreshBtn'),
  sortSelect: $('#sortSelect'),
  markAllReadBtn: $('#markAllReadBtn'),
  viewCardBtn: $('#viewCardBtn'),
  viewCompactBtn: $('#viewCompactBtn'),
  articleCount: $('#articleCount'),
  emptyState: $('#emptyState'),
  feedList: $('#feedList'),
  loadMoreWrap: $('#loadMoreWrap'),
  loadMoreBtn: $('#loadMoreBtn'),
  sourcesDialog: $('#sourcesDialog'),
  sourceForm: $('#sourceForm'),
  sourceType: $('#sourceType'),
  sourceName: $('#sourceName'),
  sourceValue: $('#sourceValue'),
  sourceCategory: $('#sourceCategory'),
  sourceValueLabel: $('#sourceValueLabel'),
  sourceHint: $('#sourceHint'),
  sourceList: $('#sourceList'),
  sourceCount: $('#sourceCount'),
  settingsDialog: $('#settingsDialog'),
  settingsForm: $('#settingsForm'),
  autoRefreshMinutes: $('#autoRefreshMinutes'),
  themeMode: $('#themeMode'),
  categoryNameInput: $('#categoryNameInput'),
  addCategoryBtn: $('#addCategoryBtn'),
  categoryManagerList: $('#categoryManagerList'),
  clearArticlesBtn: $('#clearArticlesBtn'),
  exportDataBtn: $('#exportDataBtn'),
  importDataBtn: $('#importDataBtn'),
  importDataInput: $('#importDataInput'),
  toast: $('#toast')
};

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ARTICLE_STORE)) {
        const store = db.createObjectStore(ARTICLE_STORE, { keyPath: 'id' });
        store.createIndex('publishedAt', 'publishedAt');
        store.createIndex('sourceType', 'sourceType');
        store.createIndex('read', 'read');
        store.createIndex('favorite', 'favorite');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbPutArticles(articles) {
  if (!articles.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);

    for (const article of articles) {
      const getReq = store.get(article.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) {
          store.put(article);
          return;
        }

        store.put({
          ...existing,
          ...article,
          imageUrl: article.imageUrl || existing.imageUrl || '',
          imageCheckedAt: article.imageUrl ? '' : (existing.imageCheckedAt || article.imageCheckedAt || ''),
          read: existing.read,
          favorite: existing.favorite
        });
      };
    }

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbGetAllArticles() {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readonly');
    const req = tx.objectStore(ARTICLE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function dbPatchArticle(id, patch) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) store.put({ ...req.result, ...patch });
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbPatchMany(ids, patch) {
  if (!ids.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);
    for (const id of ids) {
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, ...patch });
      };
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbPatchArticles(updates) {
  if (!updates.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);
    for (const { id, patch } of updates) {
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, ...patch });
      };
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbClearArticles() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    tx.objectStore(ARTICLE_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbDeleteArticles(ids) {
  if (!ids.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function cleanupExpiredArticles() {
  const allArticles = await dbGetAllArticles();
  const cutoff = Date.now() - CACHE_RETENTION_MS;
  const expiredIds = allArticles
    .filter(article => {
      if (article.favorite) return false;
      const time = new Date(article.publishedAt || article.fetchedAt || 0).getTime();
      return Number.isFinite(time) && time > 0 && time < cutoff;
    })
    .map(article => article.id);

  if (!expiredIds.length) return { deleted: 0 };

  await dbDeleteArticles(expiredIds);
  const expiredSet = new Set(expiredIds);
  const survivors = allArticles.filter(article => !expiredSet.has(article.id));
  const groupCounts = new Map();
  for (const article of survivors) {
    if (!article.duplicateGroupId) continue;
    groupCounts.set(article.duplicateGroupId, (groupCounts.get(article.duplicateGroupId) || 0) + 1);
  }

  const orphanUpdates = survivors
    .filter(article => article.duplicateGroupId && (groupCounts.get(article.duplicateGroupId) || 0) < 2)
    .map(article => ({
      id: article.id,
      patch: {
        duplicateGroupId: '',
        duplicateRepresentative: false,
        read: article.duplicateAutoRead ? false : article.read,
        duplicateAutoRead: false
      }
    }));
  await dbPatchArticles(orphanUpdates);

  await chrome.storage.local.set({ dedupeMeta: { version: 0, lastFetchedAt: '' } });
  return { deleted: expiredIds.length };
}

async function getState() {
  return chrome.storage.local.get({
    sources: [],
    categories: [],
    categoryLayoutInitialized: false,
    settings: { autoRefreshMinutes: 30, viewMode: 'card', sortMode: 'newest', themeMode: 'system' },
    collapsedCategories: {},
    dedupeMeta: { version: 0, lastFetchedAt: '' },
    demoSeeded: false
  });
}

async function saveSources(sources) {
  await chrome.storage.local.set({ sources });
}

async function saveCategories(categories) {
  await chrome.storage.local.set({ categories });
}

async function toggleCategoryCollapsed(categoryId) {
  const { collapsedCategories } = await getState();
  const next = { ...(collapsedCategories || {}) };
  next[categoryId] = !next[categoryId];
  await chrome.storage.local.set({ collapsedCategories: next });
  await render();
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

function normalizeThemeMode(mode) {
  return ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
}

function normalizeSortMode(mode) {
  if (mode === 'unread') return 'unreadOnly';
  return ['newest', 'oldest', 'unreadOnly', 'readOnly', 'all'].includes(mode) ? mode : 'newest';
}

function applyTheme(mode) {
  const normalized = normalizeThemeMode(mode);
  document.documentElement.dataset.theme = normalized;
}

function uid() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

async function hashText(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function stripHtml(html = '') {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function typeLabel(type) {
  return type === 'rss' ? 'WEB' : type === 'google' ? 'News' : 'X';
}

function typeIcon(type) {
  return type === 'rss' ? '🌐' : type === 'google' ? '🔎' : '𝕏';
}

function categoryKey(source) {
  return source.categoryId || '';
}

function orderedCategories(categories = []) {
  return [...categories].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function orderedSources(sources = []) {
  return [...sources].sort((a, b) => {
    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

function normalizeXHandle(value = '') {
  let handle = value.trim();
  handle = handle.replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, '');
  handle = handle.replace(/^@/, '');
  handle = handle.split(/[/?#]/)[0].trim();
  return handle;
}

function sourceUrl(source) {
  if (source.type === 'rss') return source.value.trim();
  if (source.type === 'google') {
    const q = encodeURIComponent(source.value.trim());
    return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
  }
  if (source.type === 'x') {
    const handle = normalizeXHandle(source.value);
    if (!handle) throw new Error('Xアカウント名が空です');
    return `https://nitter.net/${encodeURIComponent(handle)}/rss`;
  }
  throw new Error('不明なフィード種別です');
}

async function fetchXml(url) {
  const meta = await fetchFeedMeta(url);
  return meta.text;
}

function resolveHttpUrl(value = '', baseUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const resolved = new URL(raw, baseUrl || undefined);
    if (!['http:', 'https:'].includes(resolved.protocol)) return '';
    return resolved.href;
  } catch {
    return '';
  }
}

function candidateFromSrcset(srcset = '', baseUrl = '') {
  if (!srcset) return '';
  const candidates = srcset.split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .map(value => resolveHttpUrl(value, baseUrl))
    .filter(Boolean);
  return candidates.at(-1) || '';
}

function extractFirstImageFromHtml(html = '', baseUrl = '') {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const image = doc.querySelector('img');
  if (!image) return '';

  const candidates = [
    image.getAttribute('src'),
    image.getAttribute('data-src'),
    image.getAttribute('data-original'),
    image.getAttribute('data-lazy-src'),
    candidateFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '', baseUrl)
  ];

  for (const candidate of candidates) {
    const resolved = resolveHttpUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return '';
}

function firstChildText(root, tagNames) {
  for (const name of tagNames) {
    const node = root.getElementsByTagName(name)[0];
    const value = node?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

function imageFromXmlEntry(entry, rawHtml, baseUrl, articleUrl = '') {
  const preferredBase = articleUrl || baseUrl;
  const mediaTags = ['media:content', 'media:thumbnail', 'thumbnail'];

  for (const tag of mediaTags) {
    for (const node of Array.from(entry.getElementsByTagName(tag))) {
      const rawUrl = node.getAttribute('url') || node.getAttribute('href');
      const medium = (node.getAttribute('medium') || '').toLowerCase();
      const type = (node.getAttribute('type') || '').toLowerCase();
      if (medium && medium !== 'image') continue;
      if (type && !type.startsWith('image/')) continue;
      const resolved = resolveHttpUrl(rawUrl, preferredBase);
      if (resolved) return resolved;
    }
  }

  for (const enclosure of Array.from(entry.getElementsByTagName('enclosure'))) {
    const type = (enclosure.getAttribute('type') || '').toLowerCase();
    if (type && !type.startsWith('image/')) continue;
    const resolved = resolveHttpUrl(enclosure.getAttribute('url'), preferredBase);
    if (resolved) return resolved;
  }

  return extractFirstImageFromHtml(rawHtml, preferredBase);
}

function parseFeed(xmlText, source, feedUrl = '') {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('RSS/XMLを解析できませんでした');

  const toItem = item => {
    const link = firstChildText(item, ['link']);
    const rawDescription = firstChildText(item, ['content:encoded', 'description']);
    const rdfAbout = item.getAttributeNS?.('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'about')
      || item.getAttribute('rdf:about')
      || '';
    return {
      title: firstChildText(item, ['title']) || '(無題)',
      url: resolveHttpUrl(link, feedUrl) || link || rdfAbout,
      description: rawDescription,
      imageUrl: imageFromXmlEntry(item, rawDescription, feedUrl, link || rdfAbout),
      publishedAt: firstChildText(item, ['pubDate', 'dc:date', 'date']),
      guid: firstChildText(item, ['guid']) || rdfAbout || link
    };
  };

  // RSS 2.0
  const rssItems = Array.from(xml.querySelectorAll('channel > item'));
  if (rssItems.length) return rssItems.map(toItem);

  // RSS 1.0 / RDF
  // <rdf:RDF> の直下に <item> が並ぶ形式。
  const root = xml.documentElement;
  if ((root?.localName || '').toLowerCase() === 'rdf') {
    const rdfItems = Array.from(root.children || []).filter(node => (node.localName || '').toLowerCase() === 'item');
    if (rdfItems.length) return rdfItems.map(toItem);
  }

  // 名前空間やブラウザ実装差の保険。
  const looseRdfItems = Array.from(xml.getElementsByTagName('*')).filter(node =>
    (node.localName || '').toLowerCase() === 'item' &&
    node.parentElement === root
  );
  if (looseRdfItems.length) return looseRdfItems.map(toItem);

  // Atom
  const atomEntries = Array.from(xml.querySelectorAll('feed > entry'));
  return atomEntries.map(entry => {
    const alternate = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link[href]');
    const link = alternate?.getAttribute('href') || '';
    const rawDescription = firstChildText(entry, ['content', 'summary']);
    return {
      title: firstChildText(entry, ['title']) || '(無題)',
      url: resolveHttpUrl(link, feedUrl) || link,
      description: rawDescription,
      imageUrl: imageFromXmlEntry(entry, rawDescription, feedUrl, link),
      publishedAt: firstChildText(entry, ['published', 'updated']),
      guid: firstChildText(entry, ['id'])
    };
  });
}

async function normalizeItems(items, source) {
  const result = [];
  for (const item of items) {
    const title = stripHtml(item.title || '(無題)');
    const url = item.url || '';
    const basis = item.guid || url || `${source.id}|${title}|${item.publishedAt}`;
    result.push({
      id: await hashText(basis),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title,
      description: stripHtml(item.description || '').slice(0, 500),
      imageUrl: resolveHttpUrl(item.imageUrl || '', url || sourceUrl(source)),
      imageCheckedAt: '',
      url,
      publishedAt: normalizeDate(item.publishedAt),
      fetchedAt: new Date().toISOString(),
      read: false,
      favorite: false
    });
  }
  return result;
}


function canonicalArticleUrl(value = '') {
  const resolved = resolveHttpUrl(value);
  if (!resolved) return '';
  try {
    const url = new URL(resolved);
    url.hash = '';
    const drop = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'yclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 's'
    ];
    drop.forEach(key => url.searchParams.delete(key));
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return resolved;
  }
}

function normalizeDuplicateTitle(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s(?:-|–|—|\||｜)\s[^|｜]{2,40}$/, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[【\[［(（][^】\]］)）]{0,16}(?:速報|更新|写真|動画|解説|独自|注目|ニュース)[^】\]］)）]{0,16}[】\]］)）]/g, '')
    .replace(/(?:速報|更新|写真|動画|解説|独自)[:：\s]*/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？“”"'‘’「」『』【】\[\]［］()（）・、,，.。:：;；|｜/／\\—–ー~〜…]/g, '')
    .trim();
}

function makeBigrams(text = '') {
  const normalized = normalizeDuplicateTitle(text);
  const grams = new Set();
  if (!normalized) return grams;
  if (normalized.length < 2) {
    grams.add(normalized);
    return grams;
  }
  for (let i = 0; i < normalized.length - 1; i++) grams.add(normalized.slice(i, i + 2));
  return grams;
}

function diceSimilarity(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let common = 0;
  const [small, large] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet];
  for (const gram of small) if (large.has(gram)) common++;
  return (2 * common) / (aSet.size + bSet.size);
}

function japaneseTitleCore(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[a-z0-9_+.#-]+/g, '')
    .replace(/(?:速報|更新|写真|動画|解説|独自|発表)/g, '')
    .replace(/[^ぁ-んァ-ヶ一-龯々]/g, '');
}

function rawBigrams(text = '') {
  const grams = new Set();
  if (!text) return grams;
  if (text.length < 2) {
    grams.add(text);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2));
  return grams;
}

function titleLooksDuplicate(a, b) {
  const aText = a._dedupeTitle;
  const bText = b._dedupeTitle;
  if (!aText || !bText) return false;
  if (aText === bText && aText.length >= 7) return true;

  const minLen = Math.min(aText.length, bText.length);
  const maxLen = Math.max(aText.length, bText.length);
  if (minLen < 9 || minLen / maxLen < 0.48) return false;

  if ((aText.includes(bText) || bText.includes(aText)) && minLen >= 12) return true;

  const score = diceSimilarity(a._dedupeBigrams, b._dedupeBigrams);
  if (score < DEDUPE_SIMILARITY) return false;

  // ブランド名だけが共通する別ニュースを誤って束ねないため、日本語部分も補助確認する。
  const aJapanese = japaneseTitleCore(a.title || aText);
  const bJapanese = japaneseTitleCore(b.title || bText);
  if (aJapanese.length >= 4 && bJapanese.length >= 4) {
    const japaneseScore = diceSimilarity(rawBigrams(aJapanese), rawBigrams(bJapanese));
    if (japaneseScore < 0.28 && score < 0.90) return false;
  }

  // 短い見出しほど誤判定しやすいので、少し厳しくする。
  if (minLen < 16 && score < 0.84) return false;
  return true;
}

function representativeScore(article) {
  let score = 0;
  if (article.favorite) score += 1000;
  if (article.sourceType === 'rss') score += 80;
  else if (article.sourceType === 'google') score += 45;
  else if (article.sourceType === 'x') score += 20;

  const host = (() => {
    try { return new URL(article.url || '').hostname.toLowerCase(); } catch { return ''; }
  })();
  if (host && !host.includes('news.google.') && !host.includes('nitter.')) score += 30;
  if (article.imageUrl) score += 15;
  score += Math.min(25, Math.floor((article.description || '').length / 40));
  return score;
}

function duplicateArticleTime(article) {
  const published = new Date(article?.publishedAt || '').getTime();
  if (Number.isFinite(published)) return published;
  const fetched = new Date(article?.fetchedAt || '').getTime();
  return Number.isFinite(fetched) ? fetched : 0;
}

function chooseClusterRepresentative(cluster) {
  return [...cluster].sort((a, b) => {
    const timeDiff = duplicateArticleTime(b) - duplicateArticleTime(a);
    if (timeDiff) return timeDiff;

    const fetchedA = new Date(a.fetchedAt || 0).getTime();
    const fetchedB = new Date(b.fetchedAt || 0).getTime();
    const fetchedDiff = (Number.isFinite(fetchedB) ? fetchedB : 0) - (Number.isFinite(fetchedA) ? fetchedA : 0);
    if (fetchedDiff) return fetchedDiff;

    const scoreDiff = representativeScore(b) - representativeScore(a);
    if (scoreDiff) return scoreDiff;
    return String(a.id || '').localeCompare(String(b.id || ''), 'ja');
  })[0];
}

function findDuplicateClusters(articles) {
  if (articles.length < 2) return [];
  const items = [...articles]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, DEDUPE_MAX_ARTICLES)
    .map(article => ({
      ...article,
      _dedupeTitle: normalizeDuplicateTitle(article.title),
      _dedupeBigrams: makeBigrams(article.title),
      _dedupeUrl: canonicalArticleUrl(article.url),
      _dedupeTime: new Date(article.publishedAt).getTime()
    }));

  const parent = items.map((_, index) => index);
  const rank = items.map(() => 0);
  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
  };

  const urlOwner = new Map();
  items.forEach((item, index) => {
    if (!item._dedupeUrl) return;
    if (urlOwner.has(item._dedupeUrl)) union(index, urlOwner.get(item._dedupeUrl));
    else urlOwner.set(item._dedupeUrl, index);
  });

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      const diff = Math.abs(a._dedupeTime - b._dedupeTime);
      if (diff > DEDUPE_WINDOW_MS) break;
      if (a._dedupeUrl && b._dedupeUrl && a._dedupeUrl === b._dedupeUrl) continue;
      if (titleLooksDuplicate(a, b)) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });

  return [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => group.map(({ _dedupeTitle, _dedupeBigrams, _dedupeUrl, _dedupeTime, ...article }) => article));
}

async function deduplicateRecentArticles(force = false) {
  const allArticles = await dbGetAllArticles();
  if (allArticles.length < 2) return { groups: 0, autoRead: 0, skipped: true };

  const newestFetchedAt = allArticles.reduce((latest, article) => {
    const value = article.fetchedAt || '';
    return value > latest ? value : latest;
  }, '');
  const { dedupeMeta } = await getState();
  if (!force && dedupeMeta?.version === DEDUPE_VERSION && dedupeMeta?.lastFetchedAt === newestFetchedAt) {
    return { groups: 0, autoRead: 0, skipped: true };
  }

  const recentCutoff = Date.now() - DEDUPE_WINDOW_MS;
  const recent = allArticles.filter(article => new Date(article.publishedAt).getTime() >= recentCutoff);
  const clusters = findDuplicateClusters(recent);
  const clusteredIds = new Set();
  const updates = [];
  let autoRead = 0;

  for (const cluster of clusters) {
    cluster.forEach(article => clusteredIds.add(article.id));

    const representative = chooseClusterRepresentative(cluster);
    const existingRepresentatives = cluster.filter(article => article.duplicateRepresentative);
    const previousRepresentative = [...existingRepresentatives]
      .sort((a, b) => duplicateArticleTime(b) - duplicateArticleTime(a))[0] || null;

    const promotedNewerArticle = Boolean(
      previousRepresentative
      && previousRepresentative.id !== representative.id
      && duplicateArticleTime(representative) > duplicateArticleTime(previousRepresentative)
    );

    const groupUnread = promotedNewerArticle
      ? true
      : existingRepresentatives.length
        ? existingRepresentatives.some(article => !article.read)
        : cluster.some(article => !article.read && !article.duplicateAutoRead);

    const existingGroupId = cluster.find(article => article.duplicateGroupId)?.duplicateGroupId || '';
    const groupId = existingGroupId || `dup-${representative.id}`;

    for (const article of cluster) {
      const isRepresentative = article.id === representative.id;
      const nextRead = isRepresentative ? !groupUnread : true;
      const nextAutoRead = !isRepresentative && groupUnread && (!article.read || article.duplicateAutoRead);
      if (!isRepresentative && !article.read && nextRead) autoRead++;

      updates.push({
        id: article.id,
        patch: {
          duplicateGroupId: groupId,
          duplicateRepresentative: isRepresentative,
          duplicateAutoRead: nextAutoRead,
          read: nextRead
        }
      });
    }
  }

  for (const article of recent) {
    if (!article.duplicateGroupId || clusteredIds.has(article.id)) continue;
    updates.push({
      id: article.id,
      patch: {
        duplicateGroupId: '',
        duplicateRepresentative: false,
        read: article.duplicateAutoRead ? false : article.read,
        duplicateAutoRead: false
      }
    });
  }

  await dbPatchArticles(updates);
  await chrome.storage.local.set({
    dedupeMeta: { version: DEDUPE_VERSION, lastFetchedAt: newestFetchedAt }
  });
  return { groups: clusters.length, autoRead, skipped: false };
}

function buildStoryCards(filteredArticles, allArticles) {
  const groupMembers = new Map();
  for (const article of allArticles) {
    if (!article.duplicateGroupId) continue;
    if (!groupMembers.has(article.duplicateGroupId)) groupMembers.set(article.duplicateGroupId, []);
    groupMembers.get(article.duplicateGroupId).push(article);
  }

  const filteredGroups = new Map();
  for (const article of filteredArticles) {
    const key = article.duplicateGroupId || `single:${article.id}`;
    if (!filteredGroups.has(key)) filteredGroups.set(key, []);
    filteredGroups.get(key).push(article);
  }

  const stories = [];
  const emitted = new Set();
  for (const article of filteredArticles) {
    const key = article.duplicateGroupId || `single:${article.id}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const visibleMembers = filteredGroups.get(key) || [article];
    let representative = visibleMembers.find(item => item.duplicateRepresentative) || visibleMembers[0];
    if (!visibleMembers.some(item => item.id === representative.id)) representative = visibleMembers[0];
    const allMembers = article.duplicateGroupId
      ? (groupMembers.get(article.duplicateGroupId) || visibleMembers)
      : [representative];
    stories.push({ ...representative, _duplicateMembers: allMembers });
  }
  return stories;
}

async function setStoryReadState(id, read) {
  const allArticles = await dbGetAllArticles();
  const target = allArticles.find(article => article.id === id);
  if (!target) return;
  const members = target.duplicateGroupId
    ? allArticles.filter(article => article.duplicateGroupId === target.duplicateGroupId)
    : [target];

  if (read) {
    await dbPatchArticles(members.map(article => ({ id: article.id, patch: { read: true, duplicateAutoRead: false } })));
    return;
  }

  const groupId = target.duplicateGroupId || '';
  await dbPatchArticles(members.map(article => ({
    id: article.id,
    patch: {
      read: article.id === id ? false : true,
      ...(groupId ? {
        duplicateRepresentative: article.id === id,
        duplicateAutoRead: article.id !== id
      } : {})
    }
  })));
}


// v0.1.22: feed health tracking only (automatic repair disabled)
// ---------------------------------------------------------------
let feedRefreshRunning = false;

async function fetchFeedMeta(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml, */*' }
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { text: await response.text(), requestedUrl: url, finalUrl: response.url || url, redirected: Boolean(response.redirected) };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeFeedDocument(xmlText = '') {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return false;
    const root = (doc.documentElement?.localName || '').toLowerCase();
    if (['rss', 'feed', 'rdf'].includes(root)) return true;
    return Array.from(doc.getElementsByTagName('*')).some(node => ['item', 'entry'].includes((node.localName || '').toLowerCase()));
  } catch { return false; }
}

async function patchFeedSource(sourceId, patch) {
  const { sources } = await getState();
  let updated = null;
  const next = sources.map(source => {
    if (source.id !== sourceId) return source;
    updated = { ...source, ...patch };
    return updated;
  });
  if (updated) await saveSources(next);
  return updated;
}

function feedHealthErrorTitle(source) {
  if (!source || source.feedHealthStatus !== 'error') return '';
  const message = source.feedLastError || 'フィードを読み込めませんでした';
  const failedAt = source.feedLastFailureAt ? new Date(source.feedLastFailureAt).toLocaleString('ja-JP') : '';
  return failedAt ? `読込エラー：${message}（${failedAt}）` : `読込エラー：${message}`;
}

const V032_REFRESH_CONCURRENCY = 6;
let v032ProgressHideTimer = null;

function v032ProgressElements() {
  return {
    root: document.getElementById('refreshProgress'),
    label: document.getElementById('refreshProgressLabel'),
    percent: document.getElementById('refreshProgressPercent'),
    track: document.getElementById('refreshProgressTrack'),
    fill: document.getElementById('refreshProgressFill'),
    detail: document.getElementById('refreshProgressDetail')
  };
}

function v032FormatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 2) return '残りわずか';
  if (seconds < 60) return `残り約${Math.ceil(seconds)}秒`;
  return `残り約${Math.ceil(seconds / 60)}分`;
}

function v032ShowProgress() {
  const ui = v032ProgressElements();
  if (!ui.root) return;

  clearTimeout(v032ProgressHideTimer);
  ui.root.hidden = false;
  ui.root.classList.remove('complete', 'has-errors');
  ui.root.classList.add('running');
  if (ui.fill) ui.fill.style.width = '0%';
  if (ui.percent) ui.percent.textContent = '0%';
  if (ui.track) ui.track.setAttribute('aria-valuenow', '0');
  if (ui.label) ui.label.textContent = `高速更新中（最大${V032_REFRESH_CONCURRENCY}件並列）`;
  if (ui.detail) ui.detail.textContent = '取得を開始しています…';
}

function v032UpdateProgress({ completed, total, success, failed, active, startedAt, phase = 'fetch' }) {
  const ui = v032ProgressElements();
  if (!ui.root) return;

  const safeTotal = Math.max(1, total || 1);
  const pct = phase === 'fetch'
    ? Math.min(100, Math.round((completed / safeTotal) * 100))
    : 100;

  if (ui.fill) ui.fill.style.width = `${pct}%`;
  if (ui.percent) ui.percent.textContent = `${pct}%`;
  if (ui.track) ui.track.setAttribute('aria-valuenow', String(pct));

  ui.root.classList.toggle('has-errors', failed > 0);

  if (phase === 'save') {
    if (ui.label) ui.label.textContent = '記事をまとめて保存中…';
    if (ui.detail) ui.detail.textContent = `取得完了 ${completed}/${total} ・ 成功 ${success} ・ 失敗 ${failed}`;
    return;
  }

  if (phase === 'dedupe') {
    if (ui.label) ui.label.textContent = '重複記事・72時間キャッシュを整理中…';
    if (ui.detail) ui.detail.textContent = `取得完了 ${completed}/${total} ・ 成功 ${success} ・ 失敗 ${failed}`;
    return;
  }

  if (phase === 'complete') {
    ui.root.classList.remove('running');
    ui.root.classList.add('complete');
    if (ui.label) ui.label.textContent = failed ? '更新完了（一部エラーあり）' : '更新完了';
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    if (ui.detail) {
      ui.detail.textContent =
        `成功 ${success} ・ 失敗 ${failed} ・ ${elapsed.toFixed(elapsed >= 10 ? 0 : 1)}秒`;
    }
    return;
  }

  if (ui.label) ui.label.textContent = `高速更新中（最大${V032_REFRESH_CONCURRENCY}件並列）`;

  const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const etaSec = completed > 0
    ? (elapsedSec / completed) * Math.max(0, total - completed)
    : NaN;
  const eta = v032FormatEta(etaSec);

  if (ui.detail) {
    ui.detail.textContent =
      `${completed}/${total} 完了 ・ 成功 ${success} ・ 失敗 ${failed}`
      + (active ? ` ・ 処理中 ${active}` : '')
      + (eta ? ` ・ ${eta}` : '');
  }
}

function v032FinishProgress(metrics) {
  v032UpdateProgress({ ...metrics, phase: 'complete' });
  const ui = v032ProgressElements();
  clearTimeout(v032ProgressHideTimer);
  v032ProgressHideTimer = setTimeout(() => {
    if (ui.root && !feedRefreshRunning) ui.root.hidden = true;
  }, 2800);
}

async function v032FetchOneSource(source) {
  try {
    const url = sourceUrl(source);
    const meta = await fetchFeedMeta(url);

    if (!looksLikeFeedDocument(meta.text)) {
      throw new Error('RSS / Atom / RDFとして認識できませんでした');
    }

    const parsed = parseFeed(meta.text, source, meta.finalUrl || url);
    const normalized = await normalizeItems(parsed, source);

    return {
      ok: true,
      source,
      articles: normalized,
      sourcePatch: {
        feedFailCount: 0,
        feedHealthStatus: 'ok',
        feedLastError: '',
        feedLastFailureAt: '',
        registrationWarning: false,
        feedLastSuccessAt: new Date().toISOString()
      }
    };
  } catch (error) {
    console.warn('フィード取得エラー:', source.name, error);
    return {
      ok: false,
      source,
      articles: [],
      error,
      sourcePatch: {
        feedFailCount: Number(source.feedFailCount || 0) + 1,
        feedHealthStatus: 'error',
        feedLastError: error?.message || String(error),
        feedLastFailureAt: new Date().toISOString()
      }
    };
  }
}

async function v032RunPool(items, worker, concurrency, onSettled) {
  let nextIndex = 0;
  let active = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;

      active++;
      let result;
      try {
        result = await worker(items[index], index);
      } finally {
        active--;
      }

      await onSettled(result, index, active);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runner()));
}

async function refreshAll() {
  if (feedRefreshRunning) {
    showToast('フィード更新はすでに実行中です。');
    return;
  }

  const { sources } = await getState();
  if (!sources.length) {
    showToast('先にフィードを登録してください。');
    return;
  }

  feedRefreshRunning = true;
  elements.refreshBtn.disabled = true;
  elements.refreshBtn.textContent = '更新中…';

  const startedAt = Date.now();
  const metrics = {
    completed: 0,
    total: sources.length,
    success: 0,
    failed: 0,
    active: 0,
    startedAt
  };

  v032ShowProgress();
  elements.statusText.textContent =
    `${sources.length}フィードを最大${V032_REFRESH_CONCURRENCY}件ずつ並列取得しています…`;

  const allNewArticles = [];
  const sourcePatches = new Map();

  try {
    await v032RunPool(
      sources,
      v032FetchOneSource,
      V032_REFRESH_CONCURRENCY,
      async (result, _index, active) => {
        metrics.completed++;
        metrics.active = active;

        if (result?.ok) {
          metrics.success++;
          if (result.articles?.length) allNewArticles.push(...result.articles);
        } else {
          metrics.failed++;
        }

        if (result?.source?.id && result?.sourcePatch) {
          sourcePatches.set(result.source.id, result.sourcePatch);
        }

        v032UpdateProgress(metrics);
      }
    );

    // Save all feed-health changes in ONE chrome.storage.local write.
    if (sourcePatches.size) {
      const nextSources = sources.map(source => {
        const patch = sourcePatches.get(source.id);
        return patch ? { ...source, ...patch } : source;
      });
      await saveSources(nextSources);
    }

    // Save all fetched articles in ONE IndexedDB transaction.
    v032UpdateProgress({ ...metrics, phase: 'save' });
    elements.statusText.textContent =
      `${allNewArticles.length.toLocaleString()}件の記事をまとめて保存しています…`;
    if (allNewArticles.length) await dbPutArticles(allNewArticles);

    v032UpdateProgress({ ...metrics, phase: 'dedupe' });
    elements.statusText.textContent = '重複記事と72時間キャッシュを整理しています…';

    const cleanup = await cleanupExpiredArticles();
    const dedupe = await deduplicateRecentArticles(true);

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const dedupeText = dedupe.groups ? ` ・ 重複 ${dedupe.groups}話題` : '';
    const cleanupText = cleanup.deleted ? ` ・ 72時間超 ${cleanup.deleted}件削除` : '';

    elements.statusText.textContent =
      `最終更新 ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
      + ` ・ ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒`
      + ` ・ 成功 ${metrics.success} / 失敗 ${metrics.failed}`
      + dedupeText + cleanupText;

    await render();
    if (elements.sourcesDialog?.open) await renderSources();

    v032FinishProgress(metrics);

    if (metrics.failed) {
      showToast(
        `取得完了：${allNewArticles.length.toLocaleString()}件 / ${metrics.failed}件のフィードで読込エラー。`
        + ` ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒で完了しました。`,
        true
      );
    } else {
      showToast(
        `取得完了：${allNewArticles.length.toLocaleString()}件を確認。`
        + ` ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒で完了しました。`
      );
    }
  } finally {
    feedRefreshRunning = false;
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = '↻ 更新';
  }
}

function sortArticles(articles) {
  const mode = elements.sortSelect.value || 'newest';
  return articles.sort((a, b) => {
    const aTime = new Date(a.publishedAt).getTime();
    const bTime = new Date(b.publishedAt).getTime();
    if (mode === 'oldest') return aTime - bTime;
    return bTime - aTime;
  });
}

function getFilteredArticles(allArticles) {
  const term = elements.searchInput.value.trim().toLowerCase();
  const mode = elements.sortSelect.value || 'newest';

  const filtered = allArticles
    .filter(a => {
      if (currentFavoriteCategoryId !== null) {
        if (!a.favorite) return false;
        const source = currentRenderSources.find(item => item.id === a.sourceId);
        return source && categoryKey(source) === currentFavoriteCategoryId;
      }
      if (currentSourceId) return a.sourceId === currentSourceId;
      if (currentCategoryId !== null) {
        const source = currentRenderSources.find(item => item.id === a.sourceId);
        return source && categoryKey(source) === currentCategoryId;
      }
      if (currentFilter === 'favorite') return a.favorite;
      if (['rss', 'google', 'x'].includes(currentFilter)) return a.sourceType === currentFilter;
      return true;
    })
    .filter(a => currentFilter !== 'unread' || !a.read)
    .filter(a => mode !== 'unreadOnly' || !a.read)
    .filter(a => mode !== 'readOnly' || a.read)
    .filter(a => !term || `${a.title} ${a.description} ${a.sourceName}`.toLowerCase().includes(term));

  return sortArticles(filtered);
}

function formatRelativeDate(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'たった今';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}時間前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}日前`;
  return new Date(iso).toLocaleDateString('ja-JP');
}

function countUnread(articles) {
  return articles.reduce((count, article) => count + (article.read ? 0 : 1), 0);
}


function sourceFaviconUrl(source, allArticles = []) {
  if (!source) return '';
  if (source.type === 'google') return 'https://news.google.com/favicon.ico';
  if (source.type === 'x') return 'https://x.com/favicon.ico';
  // WEBはv0.1.15でサイトHTMLから直接見つけたアイコンだけを使う。
  return source.siteIconUrl || '';
}

function sourceIconHtml(source, allArticles = []) {
  const favicon = sourceFaviconUrl(source, allArticles);
  const fallback = typeIcon(source.type);
  if (!favicon) return `<span class="source-fallback-icon">${fallback}</span>`;
  return `<span class="source-icon-wrap">
    <img class="source-favicon" src="${escapeHtml(favicon)}" alt="" loading="lazy" decoding="async" />
    <span class="source-fallback-icon">${fallback}</span>
  </span>`;
}

function attachSourceFaviconFallbacks(root = document) {
  root.querySelectorAll('.source-favicon').forEach(image => {
    if (image.dataset.fallbackBound === 'true') return;
    image.dataset.fallbackBound = 'true';
    image.addEventListener('load', () => image.closest('.source-icon-wrap')?.classList.add('loaded'), { once: true });
    image.addEventListener('error', () => image.closest('.source-icon-wrap')?.classList.add('failed'), { once: true });
    if (image.complete) {
      if (image.naturalWidth > 0) image.closest('.source-icon-wrap')?.classList.add('loaded');
      else image.closest('.source-icon-wrap')?.classList.add('failed');
    }
  });
}


// v0.1.15: WEBサイトがHTMLで指定しているfaviconを直接取得する。
const SOURCE_ICON_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
let sourceIconDiscoveryRunning = false;
let sourceIconDiscoveryPending = false;

function extractFeedSiteUrl(xmlText, feedUrl = '') {
  try {
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) return '';
    const rssLink = xml.querySelector('channel > link')?.textContent?.trim();
    const resolvedRss = resolveHttpUrl(rssLink, feedUrl);
    if (resolvedRss) return resolvedRss;
    const atomLink = xml.querySelector('feed > link[rel="alternate"]') || xml.querySelector('feed > link[href]');
    const resolvedAtom = resolveHttpUrl(atomLink?.getAttribute('href') || '', feedUrl);
    if (resolvedAtom) return resolvedAtom;
  } catch { /* fallback below */ }
  return '';
}

function siteIconScore(node) {
  const rel = (node.getAttribute('rel') || '').toLowerCase();
  const sizes = (node.getAttribute('sizes') || '').toLowerCase();
  let score = 0;
  if (rel.split(/\s+/).includes('icon')) score += 100;
  if (rel.includes('apple-touch-icon')) score += 70;
  if (rel.includes('mask-icon')) score += 20;
  if (sizes === 'any') score += 40;
  const match = sizes.match(/(\d+)x(\d+)/);
  if (match) score += Math.min(60, Math.max(Number(match[1]), Number(match[2])) / 4);
  const type = (node.getAttribute('type') || '').toLowerCase();
  if (type.includes('svg')) score += 15;
  if (type.includes('png')) score += 10;
  return score;
}

function extractDeclaredSiteIcon(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = Array.from(doc.querySelectorAll(
    'link[rel~="icon"][href], link[rel*="apple-touch-icon"][href], link[rel="mask-icon"][href]'
  ));
  const candidates = nodes
    .map(node => ({ url: resolveHttpUrl(node.getAttribute('href') || '', baseUrl), score: siteIconScore(node) }))
    .filter(item => item.url)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.url || '';
}

function fallbackSitePageUrl(source, allArticles = []) {
  const article = allArticles
    .filter(item => item.sourceId === source.id && item.url)
    .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
    .find(item => {
      try {
        const host = new URL(item.url).hostname.toLowerCase();
        return host && !/(^|\.)(youtube\.com|youtu\.be|x\.com|twitter\.com|news\.google\.com)$/.test(host) && !host.includes('nitter.');
      } catch { return false; }
    });
  if (article?.url) return article.url;
  try { return new URL(source.value).origin + '/'; } catch { return ''; }
}

async function discoverDirectSiteIcon(source, allArticles = []) {
  if (!source || source.type !== 'rss') return null;
  let siteUrl = source.siteUrl || '';
  if (!siteUrl) {
    try {
      const feedUrl = sourceUrl(source);
      const xmlText = await fetchXml(feedUrl);
      siteUrl = extractFeedSiteUrl(xmlText, feedUrl);
    } catch (error) {
      console.debug('フィード元サイトURLの取得をスキップ:', source.name, error);
    }
  }
  if (!siteUrl) siteUrl = fallbackSitePageUrl(source, allArticles);
  if (!siteUrl) return { siteUrl: '', siteIconUrl: '', siteIconCheckedAt: new Date().toISOString() };

  let page = null;
  try { page = await fetchHtmlPage(siteUrl); }
  catch (error) { console.debug('サイトアイコン取得をスキップ:', source.name, error); }

  const finalUrl = page?.finalUrl || siteUrl;
  let siteIconUrl = page ? extractDeclaredSiteIcon(page.html, finalUrl) : '';
  if (!siteIconUrl) {
    try { siteIconUrl = `${new URL(finalUrl).origin}/favicon.ico`; } catch { siteIconUrl = ''; }
  }
  return { siteUrl: finalUrl, siteIconUrl, siteIconCheckedAt: new Date().toISOString() };
}

async function patchSourceIconMetadata(sourceId, patch) {
  const { sources } = await getState();
  const next = sources.map(source => source.id === sourceId ? { ...source, ...patch } : source);
  await saveSources(next);
  const updated = next.find(source => source.id === sourceId);
  if (!updated) return;
  document.querySelectorAll(`.source-item[data-source-id="${CSS.escape(sourceId)}"] .source-kind-icon`).forEach(holder => {
    holder.innerHTML = sourceIconHtml(updated, []);
    attachSourceFaviconFallbacks(holder);
  });
  document.querySelectorAll(`.source-row[data-id="${CSS.escape(sourceId)}"] .source-type`).forEach(holder => {
    holder.innerHTML = sourceIconHtml(updated, []);
    holder.classList.add('source-manager-icon');
    attachSourceFaviconFallbacks(holder);
  });
}

function shouldDiscoverSourceIcon(source) {
  if (!source || source.type !== 'rss') return false;
  if (source.siteIconUrl) return false;
  if (!source.siteIconCheckedAt) return true;
  const checked = new Date(source.siteIconCheckedAt).getTime();
  return !Number.isFinite(checked) || Date.now() - checked > SOURCE_ICON_RETRY_MS;
}

async function discoverMissingSourceIcons(sources, allArticles = []) {
  if (sourceIconDiscoveryRunning) { sourceIconDiscoveryPending = true; return; }
  const targets = sources.filter(shouldDiscoverSourceIcon);
  if (!targets.length) return;
  sourceIconDiscoveryRunning = true;
  try {
    for (const source of targets) {
      const patch = await discoverDirectSiteIcon(source, allArticles);
      if (patch) await patchSourceIconMetadata(source.id, patch);
    }
  } finally {
    sourceIconDiscoveryRunning = false;
    if (sourceIconDiscoveryPending) {
      sourceIconDiscoveryPending = false;
      const [state, articles] = await Promise.all([getState(), dbGetAllArticles()]);
      discoverMissingSourceIcons(state.sources, articles);
    }
  }
}

function renderSourceNavigation(sources, categories, allArticles, collapsedCategories = {}) {
  const categoryList = orderedCategories(categories);
  const groups = [
    ...categoryList.map(category => ({ id: category.id, name: category.name, custom: true })),
    { id: '', name: '未分類', custom: false }
  ];

  const favoriteArticles = allArticles.filter(article => article.favorite);
  const favoriteFolderHtml = currentFilter === 'favorite'
    ? (() => {
        const rows = groups.map(group => {
          const sourceIds = new Set(sources.filter(source => categoryKey(source) === group.id).map(source => source.id));
          const count = favoriteArticles.filter(article => sourceIds.has(article.sourceId)).length;
          if (!count) return '';
          const active = currentFavoriteCategoryId === group.id;
          return `
            <button class="favorite-folder-item ${active ? 'active' : ''}"
                    type="button" data-filter="favorite-category"
                    data-favorite-category-id="${escapeHtml(group.id)}"
                    title="${escapeHtml(group.name)}のお気に入り">
              <span class="favorite-folder-icon">📁</span>
              <span class="favorite-folder-name">${escapeHtml(group.name)}</span>
              <b>${count.toLocaleString()}</b>
            </button>`;
        }).join('');

        return `
          <section class="favorite-folder-panel">
            <div class="favorite-folder-head">
              <span>⭐</span>
              <strong>お気に入りフォルダ</strong>
              <span>${favoriteArticles.length.toLocaleString()}件</span>
            </div>
            <button class="favorite-folder-item ${currentFavoriteCategoryId === null ? 'active' : ''}"
                    type="button" data-filter="favorite-category" data-favorite-category-all="true">
              <span class="favorite-folder-icon">★</span>
              <span class="favorite-folder-name">すべてのお気に入り</span>
              <b>${favoriteArticles.length.toLocaleString()}</b>
            </button>
            ${rows || '<div class="favorite-folder-empty">お気に入り記事のあるカテゴリはまだありません。</div>'}
          </section>
          <div class="favorite-folder-divider"></div>`;
      })()
    : '';

  const normalFoldersHtml = groups.map(group => {
    const groupSources = orderedSources(sources.filter(source => categoryKey(source) === group.id));
    const sourceIds = new Set(groupSources.map(source => source.id));
    const groupUnread = countUnread(allArticles.filter(article => sourceIds.has(article.sourceId)));
    const categoryActive = !currentSourceId && currentFavoriteCategoryId === null && currentCategoryId === group.id;
    const categoryDrag = group.custom ? 'draggable="true" data-drag-kind="category"' : '';
    const isCollapsed = Boolean(collapsedCategories[group.id]);

    const sourceRows = groupSources.length
      ? groupSources.map(source => {
          const unread = countUnread(allArticles.filter(article => article.sourceId === source.id));
          const isActive = currentSourceId === source.id;
          const healthError = source.feedHealthStatus === 'error';
          const healthTitle = feedHealthErrorTitle(source);
          return `
            <button class="nav-item source-item draggable-source ${isActive ? 'active' : ''} ${healthError ? 'has-feed-error' : ''}"
                    draggable="true" data-drag-kind="source" data-source-id="${escapeHtml(source.id)}"
                    data-category-id="${escapeHtml(group.id)}" data-filter="source" title="${escapeHtml(healthError ? healthTitle : source.name)}">
              <span class="source-kind-icon">${sourceIconHtml(source, allArticles)}</span>
              <span class="source-name" title="ダブルクリックで表示名を変更">${escapeHtml(source.name)}</span>
              ${healthError ? `<span class="source-health-warning" title="${escapeHtml(healthTitle)}">!</span>` : ''}
              <b class="${unread === 0 ? 'zero' : ''}">${unread.toLocaleString()}</b>
            </button>`;
        }).join('')
      : '';

    return `
      <section class="custom-category ${isCollapsed ? 'collapsed' : ''}" data-category-id="${escapeHtml(group.id)}">
        <div class="category-header ${categoryActive ? 'active' : ''}" ${categoryDrag}>
          <button class="category-collapse-btn" type="button"
                  data-collapse-category="${escapeHtml(group.id)}"
                  aria-expanded="${String(!isCollapsed)}"
                  aria-label="${escapeHtml(group.name)}を${isCollapsed ? '開く' : '閉じる'}">
            <span class="category-chevron">${isCollapsed ? '▸' : '▾'}</span>
          </button>
          <button class="category-select-btn" type="button"
                  data-filter="category" data-category-id="${escapeHtml(group.id)}"
                  title="${escapeHtml(group.name)}の記事を表示">
            <span class="category-folder">${isCollapsed ? '📁' : '📂'}</span>
            <span class="category-name">${escapeHtml(group.name)}</span>
            <b class="${groupUnread === 0 ? 'zero' : ''}">${groupUnread.toLocaleString()}</b>
          </button>
          ${group.custom ? '<span class="category-drag-handle" draggable="true" title="ドラッグしてカテゴリを並び替え">⋮⋮</span>' : '<span class="category-drag-spacer"></span>'}
        </div>
        <div class="category-children" data-category-id="${escapeHtml(group.id)}" ${isCollapsed ? 'hidden' : ''}>${sourceRows}</div>
      </section>`;
  }).join('');

  elements.sourceNav.innerHTML = favoriteFolderHtml + normalFoldersHtml
    + '<div class="drag-hint">▾でフォルダを開閉。フィードはドラッグでフォルダ移動、フォルダ自体もドラッグで好きな順に並び替えできます。</div>';
  attachSourceFaviconFallbacks(elements.sourceNav);
  discoverMissingSourceIcons(sources, allArticles);

  const effectiveNavFilter = currentFilter === 'all' && elements.sortSelect.value === 'unreadOnly'
    ? 'unread'
    : currentFilter;
  $$('.nav-item[data-filter="all"], .nav-item[data-filter="unread"], .nav-item[data-filter="favorite"]').forEach(item => {
    const active = !currentSourceId && currentCategoryId === null && item.dataset.filter === effectiveNavFilter;
    item.classList.toggle('active', active);
  });
}

function renderCounts(allArticles, sources, categories, collapsedCategories = {}) {
  $('#countAll').textContent = allArticles.length.toLocaleString();
  $('#countUnread').textContent = countUnread(allArticles).toLocaleString();
  $('#countFavorite').textContent = allArticles.filter(a => a.favorite).length.toLocaleString();
  renderSourceNavigation(sources, categories, allArticles, collapsedCategories);
}

function currentViewTitle(sources, categories) {
  if (currentFavoriteCategoryId !== null) {
    const name = currentFavoriteCategoryId === ''
      ? '未分類'
      : (categories.find(category => category.id === currentFavoriteCategoryId)?.name || 'カテゴリ');
    return `お気に入り / ${name}`;
  }
  if (currentSourceId) {
    return sources.find(source => source.id === currentSourceId)?.name || 'フィード';
  }
  if (currentCategoryId !== null) {
    if (currentCategoryId === '') return '未分類';
    return categories.find(category => category.id === currentCategoryId)?.name || 'カテゴリ';
  }
  if (elements.sortSelect.value === 'unreadOnly') return '未読';
  if (elements.sortSelect.value === 'readOnly') return '既読';
  const titles = {
    all: 'すべての記事',
    unread: '未読',
    favorite: 'お気に入り',
    rss: 'WEB',
    google: 'キーワード',
    x: 'X / Nitter'
  };
  return titles[currentFilter] || '記事';
}

function updateEmptyState(allArticles, filtered) {
  const title = elements.emptyState.querySelector('h3');
  const text = elements.emptyState.querySelector('p');
  const addButton = elements.emptyState.querySelector('#emptyAddBtn');
  const unreadOnly = currentFilter === 'unread' || elements.sortSelect.value === 'unreadOnly';
  const readOnly = elements.sortSelect.value === 'readOnly';

  if (!allArticles.length) {
    title.textContent = 'まだ記事がありません';
    text.textContent = 'RSS、Google Newsのキーワード、Xアカウントを登録できます。';
    addButton.hidden = false;
    return;
  }

  title.textContent = unreadOnly && !currentSourceId ? '未読記事はありません 🎉'
    : readOnly && !currentSourceId ? '既読記事はありません'
    : '該当する記事はありません';
  text.textContent = unreadOnly && !currentSourceId
    ? 'すべて確認済みです。「すべて」または「新しい順」に切り替えると既読記事も表示できます。'
    : readOnly && !currentSourceId
      ? 'まだ既読にした記事がありません。'
      : '検索条件・フィード・表示方法を変えてみてください。';
  addButton.hidden = true;
}

async function render() {
  const [allArticles, state] = await Promise.all([dbGetAllArticles(), getState()]);
  const { sources, categories, settings, collapsedCategories } = state;
  currentRenderSources = sources;

  if (currentSourceId && !sources.some(source => source.id === currentSourceId)) {
    currentSourceId = '';
    currentFilter = 'all';
  }
  if (currentCategoryId !== null && currentCategoryId !== '' && !categories.some(category => category.id === currentCategoryId)) {
    currentCategoryId = null;
    currentFilter = 'all';
  }

  const sortMode = normalizeSortMode(settings.sortMode);
  if (elements.sortSelect.value !== sortMode) elements.sortSelect.value = sortMode;

  renderCounts(allArticles, sources, categories, collapsedCategories);
  const filtered = getFilteredArticles(allArticles);
  const stories = buildStoryCards(filtered, allArticles);
  elements.articleCount.textContent = stories.length === filtered.length
    ? `${filtered.length.toLocaleString()}件`
    : `${stories.length.toLocaleString()}話題 / ${filtered.length.toLocaleString()}記事`;

  const viewMode = settings.viewMode === 'compact' ? 'compact' : 'card';
  elements.feedList.classList.toggle('compact', viewMode === 'compact');
  elements.viewCardBtn.classList.toggle('active', viewMode === 'card');
  elements.viewCompactBtn.classList.toggle('active', viewMode === 'compact');
  elements.viewCardBtn.setAttribute('aria-pressed', String(viewMode === 'card'));
  elements.viewCompactBtn.setAttribute('aria-pressed', String(viewMode === 'compact'));
  elements.viewTitle.textContent = currentViewTitle(sources, categories);

  if (!filtered.length) {
    if (imageObserver) imageObserver.disconnect();
    elements.feedList.hidden = true;
    elements.loadMoreWrap.hidden = true;
    elements.emptyState.hidden = false;
    updateEmptyState(allArticles, filtered);
    return;
  }

  elements.emptyState.hidden = true;
  elements.feedList.hidden = false;
  const visible = stories.slice(0, renderedLimit);
  renderedArticleMap = new Map(visible.map(article => [article.id, article]));

  elements.feedList.innerHTML = visible.map(article => {
    const articleUrl = article.url ? escapeHtml(article.url) : '';
    const imageUrl = article.imageUrl ? escapeHtml(article.imageUrl) : '';
    const duplicateMembers = (article._duplicateMembers || []).filter(member => member.id !== article.id);
    const duplicateHtml = duplicateMembers.length ? `
      <div class="duplicate-block">
        <button class="duplicate-toggle" type="button" aria-expanded="false">
          <span class="duplicate-toggle-main">
            <span class="duplicate-icon">🔗</span>
            <span class="duplicate-summary">
              <strong>同じ話題が ${duplicateMembers.length + 1}件あります</strong>
              <small>未読記事1件だけを残し、同じ話題の重複記事は自動で既読にしています</small>
            </span>
          </span>
          <span class="duplicate-toggle-side">
            <span class="duplicate-count">${duplicateMembers.length + 1}</span>
            <span class="duplicate-chevron">▾</span>
          </span>
        </button>
        <div class="duplicate-list" hidden>
          <div class="duplicate-list-head">
            <strong>同じ話題の元記事</strong>
            <span>クリックすると各記事を開けます</span>
          </div>
          ${[article, ...duplicateMembers]
            .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
            .map(member => {
              const memberUrl = member.url ? escapeHtml(member.url) : '';
              const isRepresentative = member.id === article.id;
              return `<div class="duplicate-row ${isRepresentative ? 'representative' : ''}">
                <span class="duplicate-status ${isRepresentative ? 'representative' : 'duplicate'}">${isRepresentative ? '未読' : '既読'}</span>
                <span class="duplicate-source">${typeIcon(member.sourceType)} ${escapeHtml(member.sourceName)}</span>
                <span class="duplicate-title">${memberUrl ? `<a class="duplicate-link" data-article-id="${escapeHtml(member.id)}" href="${memberUrl}" target="_blank" rel="noreferrer">${escapeHtml(member.title)} <span aria-hidden="true">↗</span></a>` : escapeHtml(member.title)}</span>
                <span class="duplicate-time">${formatRelativeDate(member.publishedAt)}</span>
              </div>`;
            }).join('')}
        </div>
      </div>` : '';
    return `
      <article class="article-card ${article.read ? 'read' : ''} ${duplicateMembers.length ? 'has-duplicates' : ''}" data-id="${article.id}">
        <div class="unread-dot"></div>
        <div class="article-content ${imageUrl ? 'has-image' : ''}">
          ${imageUrl ? `
            <a class="article-thumb article-link" href="${articleUrl || imageUrl}" target="_blank" rel="noreferrer" tabindex="-1" aria-label="${escapeHtml(article.title)}">
              <img src="${imageUrl}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            </a>` : ''}
          <div class="article-main">
            <div class="article-meta">
              <span class="type-badge">${typeLabel(article.sourceType)}</span>
              <span>${escapeHtml(article.sourceName)}</span>
              <span>•</span>
              <span title="${new Date(article.publishedAt).toLocaleString('ja-JP')}">${formatRelativeDate(article.publishedAt)}</span>
              ${duplicateMembers.length ? `<span class="duplicate-badge">🔗 同じ話題 ${duplicateMembers.length + 1}件</span>` : ''}
            </div>
            <h3 class="article-title">
              ${articleUrl ? `<a class="article-link" href="${articleUrl}" target="_blank" rel="noreferrer">${escapeHtml(article.title)}</a>` : escapeHtml(article.title)}
            </h3>
            ${article.description ? `<p class="article-desc">${escapeHtml(article.description)}</p>` : ''}
            ${duplicateHtml}
          </div>
        </div>
        <div class="article-actions">
          <button class="icon-action favorite-btn ${article.favorite ? 'active' : ''}" title="お気に入り">⭐</button>
          <button class="icon-action read-btn" title="${article.read ? '未読に戻す' : '既読にする'}">${article.read ? '↩' : '✓'}</button>
        </div>
      </article>`;
  }).join('');

  elements.loadMoreWrap.hidden = visible.length >= stories.length;
  attachArticleEvents();
  setupLazyImageEnrichment(visible, viewMode);
}

function bindThumbError(image, articleId) {
  image.addEventListener('error', async () => {
    const thumb = image.closest('.article-thumb');
    const content = image.closest('.article-content');
    if (thumb) thumb.remove();
    if (content) content.classList.remove('has-image');
    await dbPatchArticle(articleId, { imageUrl: '', imageCheckedAt: new Date().toISOString() });
  }, { once: true });
}

function attachArticleEvents() {
  $$('.article-card').forEach(card => {
    const id = card.dataset.id;

    card.querySelector('.favorite-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      const article = renderedArticleMap.get(id);
      if (article) {
        const nextFavorite = !article.favorite;
        await dbPatchArticle(id, { favorite: nextFavorite });
        if (!nextFavorite) await cleanupExpiredArticles();
      }
      await render();
    });

    card.querySelector('.read-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      const article = renderedArticleMap.get(id);
      if (article) await setStoryReadState(id, !article.read);
      await render();
    });

    card.querySelectorAll('.article-link').forEach(link => {
      link.addEventListener('click', async () => {
        await setStoryReadState(id, true);
        setTimeout(render, 150);
      });
    });

    const duplicateToggle = card.querySelector('.duplicate-toggle');
    if (duplicateToggle) {
      duplicateToggle.addEventListener('click', event => {
        event.stopPropagation();
        const list = card.querySelector('.duplicate-list');
        const open = list?.hidden !== false;
        if (list) list.hidden = !open;
        duplicateToggle.setAttribute('aria-expanded', String(open));
        duplicateToggle.querySelector('.duplicate-chevron').textContent = open ? '▴' : '▾';
      });
    }

    card.querySelectorAll('.duplicate-link').forEach(link => {
      link.addEventListener('click', async () => {
        await setStoryReadState(link.dataset.articleId || id, true);
        setTimeout(render, 150);
      });
    });

    const image = card.querySelector('.article-thumb img');
    if (image) bindThumbError(image, id);
  });
}

function shouldEnrichImage(article) {
  if (!article || article.imageUrl || !article.url) return false;
  if (!resolveHttpUrl(article.url)) return false;
  if (!article.imageCheckedAt) return true;
  const checkedAt = new Date(article.imageCheckedAt).getTime();
  return Number.isNaN(checkedAt) || Date.now() - checkedAt > IMAGE_RETRY_MS;
}

async function fetchHtmlPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('html') && !type.includes('xhtml')) return null;
    return { html: await response.text(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function getImageAttr(image, baseUrl) {
  const candidates = [
    image.getAttribute('src'),
    image.getAttribute('data-src'),
    image.getAttribute('data-original'),
    image.getAttribute('data-lazy-src'),
    candidateFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '', baseUrl)
  ];
  for (const candidate of candidates) {
    const resolved = resolveHttpUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return '';
}

function looksLikeDecorativeImage(url, image) {
  const haystack = `${url} ${image.getAttribute('class') || ''} ${image.getAttribute('id') || ''} ${image.getAttribute('alt') || ''}`.toLowerCase();
  if (/logo|icon|avatar|sprite|emoji|tracking|pixel|spacer|badge|advert|(^|[-_])ad([-_]|$)/i.test(haystack)) return true;

  const width = Number.parseInt(image.getAttribute('width') || '0', 10);
  const height = Number.parseInt(image.getAttribute('height') || '0', 10);
  if (width && height && (width < 180 || height < 90)) return true;
  return false;
}

function extractImageFromPage(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const metaSelectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'link[rel="image_src"]'
  ];

  for (const selector of metaSelectors) {
    const node = doc.querySelector(selector);
    const raw = node?.getAttribute('content') || node?.getAttribute('href');
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (resolved) return { imageUrl: resolved, doc };
  }

  // Google Newsの中継ページではロゴ等を拾いやすいので、OG画像が無い場合のimg探索は行わない。
  let hostname = '';
  try { hostname = new URL(baseUrl).hostname; } catch { /* noop */ }
  if (hostname === 'news.google.com') return { imageUrl: '', doc };

  const imageCandidates = [
    ...Array.from(doc.querySelectorAll('article img')),
    ...Array.from(doc.querySelectorAll('main img')),
    ...Array.from(doc.querySelectorAll('img'))
  ];
  const seen = new Set();

  for (const image of imageCandidates) {
    if (seen.has(image)) continue;
    seen.add(image);
    const url = getImageAttr(image, baseUrl);
    if (!url || looksLikeDecorativeImage(url, image)) continue;
    return { imageUrl: url, doc };
  }

  return { imageUrl: '', doc };
}

function googleExternalArticleCandidate(doc, baseUrl) {
  let baseHost = '';
  try { baseHost = new URL(baseUrl).hostname; } catch { return ''; }
  if (baseHost !== 'news.google.com') return '';

  const rejectedHosts = ['google.com', 'www.google.com', 'news.google.com', 'accounts.google.com', 'support.google.com', 'policies.google.com', 'gstatic.com', 'googleusercontent.com'];
  const anchors = [
    ...Array.from(doc.querySelectorAll('article a[href]')),
    ...Array.from(doc.querySelectorAll('main a[href]'))
  ];

  for (const anchor of anchors) {
    const href = resolveHttpUrl(anchor.getAttribute('href'), baseUrl);
    if (!href) continue;
    try {
      const host = new URL(href).hostname;
      if (rejectedHosts.some(rejected => host === rejected || host.endsWith(`.${rejected}`))) continue;
      if ((anchor.textContent || '').trim().length < 4) continue;
      return href;
    } catch {
      // 次候補へ
    }
  }
  return '';
}

async function fetchPreviewImage(article) {
  const first = await fetchHtmlPage(article.url);
  if (!first) return '';

  const firstResult = extractImageFromPage(first.html, first.finalUrl);
  if (firstResult.imageUrl) return firstResult.imageUrl;

  if (article.sourceType === 'google' || (() => {
    try { return new URL(first.finalUrl).hostname === 'news.google.com'; } catch { return false; }
  })()) {
    const externalUrl = googleExternalArticleCandidate(firstResult.doc, first.finalUrl);
    if (externalUrl) {
      try {
        const second = await fetchHtmlPage(externalUrl);
        if (second) return extractImageFromPage(second.html, second.finalUrl).imageUrl;
      } catch (error) {
        console.debug('Google News image fallback failed', error);
      }
    }
  }

  return '';
}

function insertImageIntoCard(article, imageUrl) {
  const card = document.querySelector(`.article-card[data-id="${CSS.escape(article.id)}"]`);
  if (!card) return;
  const content = card.querySelector('.article-content');
  if (!content || content.querySelector('.article-thumb')) return;

  const thumb = document.createElement('a');
  thumb.className = 'article-thumb article-link';
  thumb.href = article.url || imageUrl;
  thumb.target = '_blank';
  thumb.rel = 'noreferrer';
  thumb.tabIndex = -1;
  thumb.setAttribute('aria-label', article.title || '記事画像');

  const image = document.createElement('img');
  image.src = imageUrl;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  bindThumbError(image, article.id);

  thumb.addEventListener('click', async () => {
    await dbPatchArticle(article.id, { read: true });
    setTimeout(render, 150);
  });

  thumb.appendChild(image);
  content.prepend(thumb);
  content.classList.add('has-image');
}

function enqueueImageEnrichment(article) {
  if (!shouldEnrichImage(article) || imageEnrichQueued.has(article.id)) return;
  imageEnrichQueued.add(article.id);
  imageEnrichQueue.push(article);
  pumpImageEnrichmentQueue();
}

function pumpImageEnrichmentQueue() {
  while (imageEnrichActive < IMAGE_ENRICH_CONCURRENCY && imageEnrichQueue.length) {
    const article = imageEnrichQueue.shift();
    imageEnrichActive++;

    (async () => {
      let imageUrl = '';
      try {
        imageUrl = await fetchPreviewImage(article);
      } catch (error) {
        console.debug('画像補完をスキップ:', article.title, error);
      }

      const checkedAt = new Date().toISOString();
      await dbPatchArticle(article.id, { imageUrl: imageUrl || '', imageCheckedAt: checkedAt });

      if (imageUrl) {
        const updated = { ...article, imageUrl, imageCheckedAt: checkedAt };
        renderedArticleMap.set(article.id, updated);
        insertImageIntoCard(updated, imageUrl);
      }
    })().finally(() => {
      imageEnrichActive--;
      imageEnrichQueued.delete(article.id);
      pumpImageEnrichmentQueue();
    });
  }
}

function setupLazyImageEnrichment(visible, viewMode) {
  if (imageObserver) imageObserver.disconnect();
  if (viewMode !== 'card') return;

  const candidates = visible.filter(shouldEnrichImage);
  if (!candidates.length) return;

  const articleById = new Map(candidates.map(article => [article.id, article]));

  if (!('IntersectionObserver' in window)) {
    candidates.slice(0, 12).forEach(enqueueImageEnrichment);
    return;
  }

  imageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      imageObserver.unobserve(entry.target);
      const article = articleById.get(entry.target.dataset.id);
      if (article) enqueueImageEnrichment(article);
    }
  }, { rootMargin: '500px 0px' });

  for (const article of candidates) {
    const card = document.querySelector(`.article-card[data-id="${CSS.escape(article.id)}"]`);
    if (card) imageObserver.observe(card);
  }
}

function renderCategoryOptions(categories, selected = '') {
  const options = ['<option value="">未分類</option>', ...orderedCategories(categories).map(category =>
    `<option value="${escapeHtml(category.id)}" ${category.id === selected ? 'selected' : ''}>${escapeHtml(category.name)}</option>`
  )];
  elements.sourceCategory.innerHTML = options.join('');
}

function normalizeSourceManagerSearch(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
}

function sourceMatchesManagerSearch(source, categoryName, query) {
  const normalizedQuery = normalizeSourceManagerSearch(query);
  if (!normalizedQuery) return true;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const handle = source.type === 'x' ? normalizeXHandle(source.value || '') : '';
  const haystack = normalizeSourceManagerSearch([
    source.name,
    source.value,
    source.type,
    typeLabel(source.type),
    categoryName,
    handle,
    handle ? `@${handle}` : ''
  ].filter(Boolean).join(' '));

  return tokens.every(token => haystack.includes(token));
}

async function renderSources() {
  const searchInput = document.getElementById('sourceManagerSearch');
  const clearButton = document.getElementById('sourceManagerSearchClear');
  const { sources, categories } = await getState();
  renderCategoryOptions(categories, elements.sourceCategory.value || '');

  const categoryMap = new Map(categories.map(category => [category.id, category.name]));
  const searchTerm = searchInput?.value || '';
  const filteredSources = orderedSources(sources).filter(source =>
    sourceMatchesManagerSearch(
      source,
      categoryMap.get(categoryKey(source)) || '未分類',
      searchTerm
    )
  );

  if (clearButton) clearButton.hidden = !normalizeSourceManagerSearch(searchTerm);
  elements.sourceCount.textContent = normalizeSourceManagerSearch(searchTerm)
    ? `${filteredSources.length} / ${sources.length}件`
    : `${sources.length}件`;

  if (!sources.length) {
    elements.sourceList.innerHTML = '<small>まだ登録されていません。</small>';
    return;
  }

  if (!filteredSources.length) {
    elements.sourceList.innerHTML = '<div class="source-manager-no-results">該当するフィードはありません。</div>';
    return;
  }

  elements.sourceList.innerHTML = filteredSources.map(source => {
    const healthError = source.feedHealthStatus === 'error';
    const healthTitle = feedHealthErrorTitle(source);
    return `<div class="source-row ${healthError ? 'has-feed-error' : ''}" data-id="${source.id}">
      <div class="source-type source-manager-icon">${sourceIconHtml(source, [])}</div>
      <div class="source-row-main"><strong>${escapeHtml(source.name)}<span class="source-category-label">${escapeHtml(categoryMap.get(categoryKey(source)) || '未分類')}</span></strong><small>${escapeHtml(source.value)}</small>${healthError ? `<div class="source-health-message" title="${escapeHtml(healthTitle)}"><span>!</span> 読込エラー</div>` : ''}</div>
      <button class="source-delete" type="button">削除</button></div>`;
  }).join('');

  attachSourceFaviconFallbacks(elements.sourceList);

  $$('.source-delete').forEach(button => button.addEventListener('click', async () => {
    const id = button.closest('.source-row').dataset.id;
    const { sources } = await getState();
    await saveSources(sources.filter(source => source.id !== id));
    if (currentSourceId === id) {
      currentSourceId = '';
      currentFilter = 'all';
    }
    await renderSources();
    await render();
    showToast('フィードを削除しました。');
  }));
}

function renderCategoryManager(categories) {
  const ordered = orderedCategories(categories);
  if (!ordered.length) {
    elements.categoryManagerList.innerHTML = '<div class="category-manager-empty">まだカテゴリがありません。左カラムでは「未分類」に表示されます。</div>';
    return;
  }
  elements.categoryManagerList.innerHTML = ordered.map(category => `
    <div class="category-manager-row" data-category-id="${escapeHtml(category.id)}">
      <span class="folder">📁</span>
      <strong>${escapeHtml(category.name)}</strong>
      <button type="button" class="category-rename">名前変更</button>
      <button type="button" class="category-delete">削除</button>
    </div>
  `).join('');
}

async function refreshCategoryManager() {
  const { categories } = await getState();
  renderCategoryManager(categories);
  renderCategoryOptions(categories, elements.sourceCategory.value || '');
}

async function addCategory(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  const { categories } = await getState();
  if (categories.some(category => category.name.toLowerCase() === trimmed.toLowerCase())) {
    showToast('同じ名前のカテゴリがあります。', true);
    return false;
  }
  const ordered = orderedCategories(categories);
  ordered.push({ id: uid(), name: trimmed, order: ordered.length });
  await saveCategories(ordered);
  await refreshCategoryManager();
  await render();
  showToast(`カテゴリ「${trimmed}」を追加しました。`);
  return true;
}

async function renameCategory(id) {
  const { categories } = await getState();
  const category = categories.find(item => item.id === id);
  if (!category) return;
  const next = prompt('カテゴリ名を入力してください。', category.name);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  if (categories.some(item => item.id !== id && item.name.toLowerCase() === trimmed.toLowerCase())) {
    showToast('同じ名前のカテゴリがあります。', true);
    return;
  }
  await saveCategories(categories.map(item => item.id === id ? { ...item, name: trimmed } : item));
  await refreshCategoryManager();
  await render();
}

async function deleteCategory(id) {
  const { categories, sources } = await getState();
  const category = categories.find(item => item.id === id);
  if (!category) return;
  if (!confirm(`カテゴリ「${category.name}」を削除しますか？\n中のフィードは「未分類」へ移動します。`)) return;
  const nextCategories = orderedCategories(categories.filter(item => item.id !== id)).map((item, index) => ({ ...item, order: index }));
  const nextSources = sources.map(source => categoryKey(source) === id ? { ...source, categoryId: '' } : source);
  await Promise.all([saveCategories(nextCategories), saveSources(nextSources)]);
  if (currentCategoryId === id) currentCategoryId = null;
  await refreshCategoryManager();
  await renderSources();
  await render();
}

async function moveSourceToCategory(sourceId, categoryId, beforeSourceId = '') {
  const { sources } = await getState();
  const moving = sources.find(source => source.id === sourceId);
  if (!moving) return;

  const targetSources = orderedSources(sources.filter(source => source.id !== sourceId && categoryKey(source) === categoryId));
  const insertAt = beforeSourceId ? Math.max(0, targetSources.findIndex(source => source.id === beforeSourceId)) : targetSources.length;
  targetSources.splice(insertAt < 0 ? targetSources.length : insertAt, 0, { ...moving, categoryId });

  const targetMap = new Map(targetSources.map((source, index) => [source.id, { ...source, order: index }]));
  const oldCategory = categoryKey(moving);
  const oldGroup = orderedSources(sources.filter(source => source.id !== sourceId && categoryKey(source) === oldCategory));
  const oldMap = new Map(oldGroup.map((source, index) => [source.id, { ...source, order: index }]));

  const nextSources = sources.map(source => {
    if (targetMap.has(source.id)) return targetMap.get(source.id);
    if (oldCategory !== categoryId && oldMap.has(source.id)) return oldMap.get(source.id);
    return source;
  });
  if (!nextSources.some(source => source.id === sourceId)) nextSources.push(targetMap.get(sourceId));
  await saveSources(nextSources);
  await renderSources();
  await render();
}

async function moveCategoryRelative(categoryId, targetCategoryId = '', position = 'before') {
  if (!categoryId) return;
  const { categories } = await getState();
  const ordered = orderedCategories(categories);
  const movingIndex = ordered.findIndex(category => category.id === categoryId);
  if (movingIndex < 0) return;
  const [moving] = ordered.splice(movingIndex, 1);

  if (!targetCategoryId) {
    ordered.push(moving);
  } else {
    let targetIndex = ordered.findIndex(category => category.id === targetCategoryId);
    if (targetIndex < 0) ordered.push(moving);
    else {
      if (position === 'after') targetIndex += 1;
      ordered.splice(targetIndex, 0, moving);
    }
  }

  await saveCategories(ordered.map((category, index) => ({ ...category, order: index })));
  await refreshCategoryManager();
  await render();
}


function safeFileTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

async function exportMyFeedData() {
  const [state, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);
  const favorites = allArticles.filter(article => article.favorite);
  const payload = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    sources: state.sources || [],
    categories: state.categories || [],
    collapsedCategories: state.collapsedCategories || {},
    settings: state.settings || {},
    favorites
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `myfeed-backup-${safeFileTimestamp()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`バックアップを書き出しました（フィード ${payload.sources.length}件 / お気に入り ${favorites.length}件）。`);
}

function validateBackupPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('JSON形式が正しくありません。');
  if (payload.format !== BACKUP_FORMAT) throw new Error('MyFeedのバックアップファイルではありません。');
  if (Number(payload.formatVersion) > BACKUP_VERSION) throw new Error('このMyFeedより新しい形式のバックアップです。');
  if (!Array.isArray(payload.sources) || !Array.isArray(payload.categories)) throw new Error('フィードまたはフォルダ情報が不足しています。');
  if (payload.favorites != null && !Array.isArray(payload.favorites)) throw new Error('お気に入り情報が正しくありません。');
  return payload;
}

async function importMyFeedData(file) {
  const text = await file.text();
  const payload = validateBackupPayload(JSON.parse(text));
  const favorites = (payload.favorites || []).filter(article => article && article.id).map(article => ({ ...article, favorite: true }));
  const message = [
    'このバックアップをインポートしますか？',
    '',
    `登録フィード：${payload.sources.length}件`,
    `フォルダ：${payload.categories.length}件`,
    `お気に入り：${favorites.length}件`,
    '',
    '現在の登録フィード・フォルダ・設定は置き換わり、通常の記事キャッシュはクリアされます。'
  ].join('\n');
  if (!confirm(message)) return;

  const defaults = { autoRefreshMinutes: 30, viewMode: 'card', sortMode: 'newest', themeMode: 'system' };
  const settings = { ...defaults, ...(payload.settings || {}) };
  await dbClearArticles();
  if (favorites.length) await dbPutArticles(favorites);
  await chrome.storage.local.set({
    sources: payload.sources,
    categories: payload.categories,
    collapsedCategories: payload.collapsedCategories || {},
    settings,
    categoryLayoutInitialized: true,
    dedupeMeta: { version: 0, lastFetchedAt: '' },
    demoSeeded: true
  });

  currentFilter = 'all';
  currentSourceId = '';
  currentCategoryId = null;
  currentFavoriteCategoryId = null;
  renderedLimit = PAGE_SIZE;
  applyTheme(settings.themeMode);
  initSidebarResizer(settings);
  renderCategoryOptions(payload.categories);
  await setupAutoRefresh();
  await renderSources();
  await render();
  showToast(`インポートしました（フィード ${payload.sources.length}件 / お気に入り ${favorites.length}件）。`);
}

async function setViewMode(mode) {
  const { settings } = await getState();
  await saveSettings({ ...settings, viewMode: mode === 'compact' ? 'compact' : 'card' });
  await render();
}

async function setSortMode(mode) {
  const normalized = normalizeSortMode(mode);
  if (currentFilter === 'unread' && normalized !== 'unreadOnly') currentFilter = 'all';
  const { settings } = await getState();
  await saveSettings({ ...settings, sortMode: normalized });
  renderedLimit = PAGE_SIZE;
  await render();
}

function updateSourceFormHelp() {
  elements.sourceValueLabel.textContent = 'URL / Xアカウント / キーワード';
  elements.sourceValue.placeholder = 'https://example.com / https://x.com/OpenAI / @OpenAI / 生成AI';
  elements.sourceHint.textContent = 'URLならWEB RSS、@またはXのURLならX、それ以外はGoogle Newsキーワードとして自動判定します。';
  updateAutoSourceDetectionHint();
}

async function openSourcesDialog() {
  await renderSources();
  elements.sourcesDialog.showModal();
}

async function openSettingsDialog(focusCategories = false) {
  const { settings, categories } = await getState();
  elements.autoRefreshMinutes.value = String(settings.autoRefreshMinutes ?? 30);
  elements.themeMode.value = normalizeThemeMode(settings.themeMode);
  renderCategoryManager(categories);
  elements.settingsDialog.showModal();
  if (focusCategories) setTimeout(() => elements.categoryNameInput.focus(), 30);
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 4500);
}

async function setupAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  const { settings } = await getState();
  const minutes = Number(settings.autoRefreshMinutes || 0);
  if (minutes > 0) autoRefreshTimer = setInterval(refreshAll, minutes * 60000);
}

async function setupCacheCleanup() {
  if (cacheCleanupTimer) clearInterval(cacheCleanupTimer);
  cacheCleanupTimer = setInterval(async () => {
    const result = await cleanupExpiredArticles();
    if (result.deleted) {
      await deduplicateRecentArticles(true);
      await render();
    }
  }, 60 * 60 * 1000);
}

async function normalizeStoredStructure() {
  const state = await getState();
  let { sources, categories } = state;

  // v0.1.4以前からの初回移行：今までの WEB / キーワード / X の見た目を保ったまま、
  // 3つを「編集できる通常カテゴリ」へ変換する。
  if (!state.categoryLayoutInitialized) {
    const defaults = [
      { id: 'category-web', name: 'WEB', order: 0 },
      { id: 'category-keywords', name: 'キーワード', order: 1 },
      { id: 'category-x', name: 'X', order: 2 }
    ];
    const typeToCategory = { rss: 'category-web', google: 'category-keywords', x: 'category-x' };
    const counters = new Map();
    sources = sources.map(source => {
      const categoryId = typeToCategory[source.type] || '';
      const order = counters.get(categoryId) || 0;
      counters.set(categoryId, order + 1);
      return { ...source, categoryId, order };
    });
    categories = defaults;
    await chrome.storage.local.set({
      sources,
      categories,
      categoryLayoutInitialized: true
    });
    return;
  }

  let sourceChanged = false;
  let categoryChanged = false;
  const validCategoryIds = new Set(categories.map(category => category.id));
  const nextCategories = categories.map((category, index) => {
    if (Number.isFinite(Number(category.order))) return category;
    categoryChanged = true;
    return { ...category, order: index };
  });

  const maxOrderByCategory = new Map();
  for (const source of sources) {
    const key = source.categoryId && validCategoryIds.has(source.categoryId) ? source.categoryId : '';
    if (Number.isFinite(Number(source.order))) {
      maxOrderByCategory.set(key, Math.max(maxOrderByCategory.get(key) ?? -1, Number(source.order)));
    }
  }

  const nextSources = sources.map(source => {
    let categoryId = source.categoryId || '';
    if (categoryId && !validCategoryIds.has(categoryId)) categoryId = '';
    let order = Number(source.order);
    const patch = {};
    if (source.categoryId !== categoryId) patch.categoryId = categoryId;
    if (!Number.isFinite(order)) {
      order = (maxOrderByCategory.get(categoryId) ?? -1) + 1;
      maxOrderByCategory.set(categoryId, order);
      patch.order = order;
    }
    if (Object.keys(patch).length) {
      sourceChanged = true;
      return { ...source, ...patch };
    }
    return source;
  });

  if (categoryChanged) await saveCategories(nextCategories);
  if (sourceChanged) await saveSources(nextSources);
}

async function bootstrapDemoIfEmpty() {
  const { sources, demoSeeded } = await getState();
  if (demoSeeded) return;
  if (!sources.length) {
    await saveSources([{ id: uid(), type: 'google', name: '生成AI', value: '生成AI', categoryId: '', order: 0 }]);
  }
  await chrome.storage.local.set({ demoSeeded: true });
}

elements.navList.addEventListener('click', async (event) => {
  const collapseButton = event.target.closest('[data-collapse-category]');
  if (collapseButton) {
    event.preventDefault();
    event.stopPropagation();
    await toggleCategoryCollapsed(collapseButton.dataset.collapseCategory ?? '');
    return;
  }

  const favoriteFolderButton = event.target.closest('[data-filter="favorite-category"]');
  if (favoriteFolderButton) {
    event.preventDefault();
    currentFilter = 'favorite';
    currentSourceId = '';
    currentCategoryId = null;
    currentFavoriteCategoryId = favoriteFolderButton.dataset.favoriteCategoryAll === 'true'
      ? null
      : (favoriteFolderButton.dataset.favoriteCategoryId ?? '');
    renderedLimit = PAGE_SIZE;
    await render();
    return;
  }

  const button = event.target.closest('[data-filter]');
  if (!button) return;

  currentFavoriteCategoryId = null;
  const filter = button.dataset.filter || 'all';
  currentSourceId = filter === 'source' ? (button.dataset.sourceId || '') : '';
  currentCategoryId = filter === 'category' ? (button.dataset.categoryId ?? '') : null;

  if (filter === 'unread') {
    currentFilter = 'unread';
    renderedLimit = PAGE_SIZE;
    await setSortMode('unreadOnly');
    return;
  }

  currentFilter = ['all', 'favorite', 'rss', 'google', 'x'].includes(filter) ? filter : 'all';
  if (filter === 'all' && ['unreadOnly', 'readOnly'].includes(elements.sortSelect.value)) {
    await setSortMode('all');
    return;
  }

  renderedLimit = PAGE_SIZE;
  await render();
});

let dragPayload = null;

function clearDragMarkers() {
  $$('.dragging, .drag-over, .drop-before, .drop-after, .category-moving').forEach(node => {
    node.classList.remove('dragging', 'drag-over', 'drop-before', 'drop-after', 'category-moving');
  });
}

function categoryDropPosition(header, clientY) {
  const rect = header.getBoundingClientRect();
  return clientY >= rect.top + rect.height / 2 ? 'after' : 'before';
}

elements.sourceNav.addEventListener('dragstart', event => {
  const source = event.target.closest('.draggable-source');
  const category = event.target.closest('.category-header[draggable="true"]');
  if (source) {
    dragPayload = { kind: 'source', id: source.dataset.sourceId };
    source.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `source:${source.dataset.sourceId}`);
    return;
  }
  if (category) {
    const categoryRow = category.closest('.custom-category');
    const categoryId = categoryRow?.dataset.categoryId || '';
    if (!categoryId) return;
    dragPayload = { kind: 'category', id: categoryId };
    category.classList.add('dragging');
    categoryRow?.classList.add('category-moving');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `category:${categoryId}`);
  }
});

elements.sourceNav.addEventListener('dragover', event => {
  if (!dragPayload) return;
  const sourceTarget = event.target.closest('.draggable-source');
  const categoryTarget = event.target.closest('.custom-category');
  if (dragPayload.kind === 'source' && (sourceTarget || categoryTarget)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    sourceTarget?.classList.add('drag-over');
    categoryTarget?.classList.add('drag-over');
    return;
  }

  if (dragPayload.kind === 'category') {
    const header = event.target.closest('.category-header[draggable="true"]');
    const targetRow = header?.closest('.custom-category');
    const targetCategoryId = targetRow?.dataset.categoryId || '';
    if (!header || !targetCategoryId || targetCategoryId === dragPayload.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    $$('.custom-category.drop-before, .custom-category.drop-after').forEach(node => node.classList.remove('drop-before', 'drop-after'));
    targetRow?.classList.add(categoryDropPosition(header, event.clientY) === 'after' ? 'drop-after' : 'drop-before');
  }
});

elements.sourceNav.addEventListener('dragleave', event => {
  const sourceTarget = event.target.closest('.draggable-source');
  const categoryTarget = event.target.closest('.custom-category');
  sourceTarget?.classList.remove('drag-over');
  if (categoryTarget && !categoryTarget.contains(event.relatedTarget)) {
    categoryTarget.classList.remove('drag-over', 'drop-before', 'drop-after');
  }
});

elements.sourceNav.addEventListener('drop', async event => {
  if (!dragPayload) return;
  event.preventDefault();
  const sourceTarget = event.target.closest('.draggable-source');
  const categoryTarget = event.target.closest('.custom-category');

  if (dragPayload.kind === 'source' && categoryTarget) {
    const categoryId = categoryTarget.dataset.categoryId || '';
    const beforeSourceId = sourceTarget?.dataset.sourceId || '';
    if (beforeSourceId !== dragPayload.id) await moveSourceToCategory(dragPayload.id, categoryId, beforeSourceId);
  } else if (dragPayload.kind === 'category') {
    const header = event.target.closest('.category-header[draggable="true"]');
    const targetRow = header?.closest('.custom-category');
    const targetCategoryId = targetRow?.dataset.categoryId || '';
    if (header && targetCategoryId && targetCategoryId !== dragPayload.id) {
      await moveCategoryRelative(dragPayload.id, targetCategoryId, categoryDropPosition(header, event.clientY));
    } else if (!header) {
      await moveCategoryRelative(dragPayload.id, '', 'after');
    }
  }
  clearDragMarkers();
});

elements.sourceNav.addEventListener('dragend', () => {
  dragPayload = null;
  clearDragMarkers();
});

elements.searchInput.addEventListener('input', () => { renderedLimit = PAGE_SIZE; render(); });
elements.sortSelect.addEventListener('change', () => setSortMode(elements.sortSelect.value));
elements.refreshBtn.addEventListener('click', refreshAll);
elements.loadMoreBtn.addEventListener('click', () => { renderedLimit += PAGE_SIZE; render(); });
elements.viewCardBtn.addEventListener('click', () => setViewMode('card'));
elements.viewCompactBtn.addEventListener('click', () => setViewMode('compact'));

$('#openSourcesBtn').addEventListener('click', openSourcesDialog);
$('#openCategoriesBtn').addEventListener('click', () => openSettingsDialog(true));
$('#emptyAddBtn').addEventListener('click', openSourcesDialog);
$('#openSettingsBtn').addEventListener('click', () => openSettingsDialog(false));

$('#closeSourcesBtn').addEventListener('click', () => elements.sourcesDialog.close());
$('#cancelSourcesBtn').addEventListener('click', () => elements.sourcesDialog.close());
$('#closeSettingsBtn').addEventListener('click', () => elements.settingsDialog.close());
$('#cancelSettingsBtn').addEventListener('click', () => elements.settingsDialog.close());

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (elements.sourcesDialog.open) {
    event.preventDefault();
    elements.sourcesDialog.close();
    return;
  }
  if (elements.settingsDialog.open) {
    event.preventDefault();
    elements.settingsDialog.close();
  }
});


// v0.1.17: one-input registration + RSS 1.0/RDF + legacy URL recovery
function detectSourceInput(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return { type: '', value: '' };
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(value) && value.startsWith('@')) {
    return { type: 'x', value: normalizeXHandle(value) };
  }
  if (/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(value)) {
    return { type: 'x', value: normalizeXHandle(value) };
  }
  if (/^https?:\/\//i.test(value)) return { type: 'rss', value };
  return { type: 'google', value };
}

function feedDocumentTitle(xmlText = '') {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return '';
    const channelTitle = doc.querySelector('channel > title')?.textContent?.trim();
    const feedTitle = Array.from(doc.documentElement?.children || [])
      .find(node => node.localName === 'title')?.textContent?.trim();
    return channelTitle || feedTitle || '';
  } catch {
    return '';
  }
}

function looksLikeFeedXml(xmlText = '') {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return false;
    const root = (doc.documentElement?.localName || '').toLowerCase();
    return ['rss', 'feed', 'rdf'].includes(root) || Boolean(doc.querySelector('channel > item, entry'));
  } catch {
    return false;
  }
}

function siteDisplayNameFromHtml(html = '', fallbackUrl = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const candidates = [
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
      doc.querySelector('meta[name="application-name"]')?.getAttribute('content'),
      doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'),
      doc.querySelector('title')?.textContent
    ];
    for (const candidate of candidates) {
      const clean = String(candidate || '').replace(/\s+/g, ' ').trim();
      if (clean) return clean.slice(0, 100);
    }
  } catch { /* noop */ }
  try { return new URL(fallbackUrl).hostname.replace(/^www\./, ''); } catch { return 'WEBフィード'; }
}

function discoverFeedUrlFromHtml(html = '', baseUrl = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = Array.from(doc.querySelectorAll('link[rel~="alternate"][href]'));
    const preferred = links.find(link => /(?:application|text)\/(?:rss|atom)\+?xml/i.test(link.getAttribute('type') || ''))
      || links.find(link => /rss|atom/i.test(`${link.getAttribute('type') || ''} ${link.getAttribute('title') || ''} ${link.getAttribute('href') || ''}`));
    return preferred ? resolveHttpUrl(preferred.getAttribute('href'), baseUrl) : '';
  } catch {
    return '';
  }
}

function looksLikeExplicitFeedUrl(value = '') {
  try {
    const url = new URL(value);
    return /(?:^|[\/._-])(rss|feed|atom)(?:[\/._-]|$)|\.(?:xml|rdf|rss|atom)(?:$|[?#])/i.test(url.pathname + url.search);
  } catch { return false; }
}
function unreadableRegisteredFeed(value, categoryId, error) {
  let name = 'WEBフィード';
  try { name = new URL(value).hostname.replace(/^www\./, ''); } catch { /* noop */ }
  return { id: uid(), type: 'rss', name, value, categoryId, feedFailCount: 1, feedHealthStatus: 'error', feedLastError: error?.message || String(error || 'フィードを読み込めませんでした'), feedLastFailureAt: new Date().toISOString(), registrationWarning: true };
}
async function prepareAutoSource(rawValue, categoryId = '') {
  const detected = detectSourceInput(rawValue);
  if (!detected.type) throw new Error('URL・Xアカウント・キーワードを入力してください。');
  if (detected.type === 'google') return { id: uid(), type: 'google', name: detected.value, value: detected.value, categoryId };
  if (detected.type === 'x') {
    if (!detected.value) throw new Error('Xアカウントを判定できませんでした。');
    let name = detected.value;
    try { const xml = await fetchXml(sourceUrl({ type: 'x', value: detected.value })); const title = feedDocumentTitle(xml); if (title) name = title.replace(/\s*\(@?[^)]+\)\s*$/, '').trim() || detected.value; } catch { /* fallback */ }
    return { id: uid(), type: 'x', name, value: detected.value, categoryId };
  }
  const url = detected.value;
  const explicit = looksLikeExplicitFeedUrl(url);
  let directError = null;
  try {
    const meta = await fetchFeedMeta(url);
    if (looksLikeFeedDocument(meta.text)) {
      let name = feedDocumentTitle(meta.text);
      if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { name = 'WEBフィード'; } }
      return { id: uid(), type: 'rss', name, value: url, categoryId, feedFailCount: 0, feedHealthStatus: 'ok', feedLastError: '', feedLastSuccessAt: new Date().toISOString() };
    }
    directError = new Error('RSS / Atom / RDFとして認識できませんでした');
    if (explicit) return unreadableRegisteredFeed(url, categoryId, directError);
  } catch (error) {
    directError = error;
    if (explicit) return unreadableRegisteredFeed(url, categoryId, error);
  }
  let page = null;
  try { page = await fetchHtmlPage(url); } catch (error) { throw directError || error; }
  if (!page) throw new Error('Webサイトを取得できませんでした。');
  const siteName = siteDisplayNameFromHtml(page.html, page.finalUrl || url);
  const discovered = discoverFeedUrlFromHtml(page.html, page.finalUrl || url);
  if (!discovered) throw new Error('このWebサイトからRSS / Atomを見つけられませんでした。');
  try {
    const meta = await fetchFeedMeta(discovered);
    if (!looksLikeFeedDocument(meta.text)) throw new Error('見つかったURLをRSS / Atom / RDFとして読み込めませんでした');
    return { id: uid(), type: 'rss', name: feedDocumentTitle(meta.text) || siteName || 'WEBフィード', value: discovered, categoryId, feedFailCount: 0, feedHealthStatus: 'ok', feedLastError: '', feedLastSuccessAt: new Date().toISOString() };
  } catch (error) {
    const source = unreadableRegisteredFeed(discovered, categoryId, error); source.name = siteName || source.name; return source;
  }
}

function updateAutoSourceDetectionHint() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint) return;
  const detected = detectSourceInput(elements.sourceValue.value);
  const labels = { rss: 'WEB RSS', x: 'X / Nitter', google: 'Google News キーワード' };
  hint.textContent = detected.type ? `自動判定：${labels[detected.type]}` : '自動判定：入力待ち';
}

async function renameSourceDisplayName(sourceId) {
  const { sources } = await getState();
  const source = sources.find(item => item.id === sourceId);
  if (!source) return;
  const next = prompt('フィードの表示名を変更', source.name || '');
  if (next === null) return;
  const name = next.trim();
  if (!name || name === source.name) return;
  await saveSources(sources.map(item => item.id === sourceId ? { ...item, name } : item));
  const articles = await dbGetAllArticles();
  const ids = articles.filter(article => article.sourceId === sourceId).map(article => article.id);
  await dbPatchMany(ids, { sourceName: name });
  await renderSources();
  await render();
  showToast(`表示名を「${name}」に変更しました。`);
}

// 左カラムのフィード名をダブルクリックして表示名を変更。
elements.sourceNav.addEventListener('dblclick', async event => {
  const row = event.target.closest('.source-item[data-source-id]');
  if (!row || !event.target.closest('.source-name')) return;
  event.preventDefault();
  event.stopPropagation();
  await renameSourceDisplayName(row.dataset.sourceId);
});

elements.sourceValue.addEventListener('input', updateAutoSourceDetectionHint);

elements.sourceType.addEventListener('change', updateSourceFormHelp);
elements.sourceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const rawValue = elements.sourceValue.value.trim();
  if (!rawValue) return;

  const saveButton = $('#saveSourceBtn');
  const originalLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = '確認中…';

  try {
    const source = await prepareAutoSource(rawValue, elements.sourceCategory.value || '');
    elements.sourceType.value = source.type;
    elements.sourceName.value = source.name;

    const { sources } = await getState();
    const duplicate = sources.some(item => item.type === source.type && String(item.value).trim().toLowerCase() === String(source.value).trim().toLowerCase());
    if (duplicate) throw new Error('同じフィードはすでに登録されています。');

    const sameCategory = sources.filter(item => categoryKey(item) === source.categoryId);
    source.order = sameCategory.length;
    await saveSources([...sources, source]);
    elements.sourceValue.value = '';
    elements.sourceName.value = '';
    updateAutoSourceDetectionHint();
    await renderSources();
    await render();
    if (source.feedHealthStatus === 'error') showToast(`${source.name} を登録しましたが、現在フィードを読み込めません。左カラムに「!」を表示しています。`, true);
    else showToast(`${source.name} を登録しました。`);
  } catch (error) {
    console.error(error);
    showToast(`登録できませんでした：${error.message}`, true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalLabel;
  }
});

elements.addCategoryBtn.addEventListener('click', async () => {
  if (await addCategory(elements.categoryNameInput.value)) elements.categoryNameInput.value = '';
});

elements.categoryNameInput.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (await addCategory(elements.categoryNameInput.value)) elements.categoryNameInput.value = '';
});

elements.categoryManagerList.addEventListener('click', async (event) => {
  const row = event.target.closest('.category-manager-row');
  if (!row) return;
  if (event.target.closest('.category-rename')) await renameCategory(row.dataset.categoryId);
  if (event.target.closest('.category-delete')) await deleteCategory(row.dataset.categoryId);
});

elements.exportDataBtn.addEventListener('click', exportMyFeedData);
elements.importDataBtn.addEventListener('click', () => {
  elements.importDataInput.value = '';
  elements.importDataInput.click();
});
elements.importDataInput.addEventListener('change', async () => {
  const file = elements.importDataInput.files?.[0];
  if (!file) return;
  try {
    await importMyFeedData(file);
    if (elements.settingsDialog.open) elements.settingsDialog.close();
  } catch (error) {
    console.error(error);
    showToast(`インポートできませんでした：${error.message}`, true);
  } finally {
    elements.importDataInput.value = '';
  }
});

elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { settings } = await getState();
  const themeMode = normalizeThemeMode(elements.themeMode.value);
  await saveSettings({
    ...settings,
    autoRefreshMinutes: Number(elements.autoRefreshMinutes.value),
    themeMode
  });
  applyTheme(themeMode);
  elements.settingsDialog.close();
  await setupAutoRefresh();
  showToast('設定を保存しました。');
});

elements.clearArticlesBtn.addEventListener('click', async () => {
  if (!confirm('保存済みの記事をすべて削除しますか？')) return;
  await dbClearArticles();
  await render();
  showToast('記事キャッシュを削除しました。');
});

elements.markAllReadBtn.addEventListener('click', async () => {
  const all = await dbGetAllArticles();
  const filtered = getFilteredArticles(all);
  await dbPatchMany(filtered.map(article => article.id), { read: true, duplicateAutoRead: false });
  await render();
  showToast(`${filtered.length}件を既読にしました。`);
  await v021MaybeAutoAdvance();
});


const SIDEBAR_WIDTH_DEFAULT = 290;
const SIDEBAR_WIDTH_MIN = 230;
const SIDEBAR_WIDTH_MAX = 460;
let sidebarResizeActive = false;

function clampSidebarWidth(value) {
  const width = Number(value) || SIDEBAR_WIDTH_DEFAULT;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, width));
}

function applySidebarWidth(value) {
  const width = clampSidebarWidth(value);
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  return width;
}

async function persistSidebarWidth(width) {
  const { settings } = await getState();
  await saveSettings({ ...settings, sidebarWidth: clampSidebarWidth(width) });
}

function initSidebarResizer(settings = {}) {
  const sidebar = document.querySelector('.sidebar');
  const resizer = document.getElementById('sidebarResizer');
  if (!sidebar || !resizer) return;

  let currentWidth = applySidebarWidth(settings.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT);
  if (resizer.dataset.resizeBound === 'true') return;
  resizer.dataset.resizeBound = 'true';
  let pointerId = null;

  const finish = async () => {
    if (!sidebarResizeActive) return;
    sidebarResizeActive = false;
    document.body.classList.remove('sidebar-resizing');
    try { if (pointerId !== null) resizer.releasePointerCapture(pointerId); } catch { /* noop */ }
    pointerId = null;
    await persistSidebarWidth(currentWidth);
  };

  resizer.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    sidebarResizeActive = true;
    document.body.classList.add('sidebar-resizing');
    resizer.setPointerCapture(pointerId);
  });

  resizer.addEventListener('pointermove', event => {
    if (!sidebarResizeActive || event.pointerId !== pointerId) return;
    currentWidth = applySidebarWidth(event.clientX);
  });

  resizer.addEventListener('pointerup', finish);
  resizer.addEventListener('pointercancel', finish);
  resizer.addEventListener('dblclick', async () => {
    currentWidth = applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    await persistSidebarWidth(currentWidth);
    showToast('左カラム幅を標準に戻しました。');
  });
}

(async function init() {
  updateSourceFormHelp();
  updateAutoSourceDetectionHint();
  await bootstrapDemoIfEmpty();
  await normalizeStoredStructure();
  const initialState = await getState();
  const { settings, sources, categories } = initialState;
  applyTheme(settings.themeMode);
  initSidebarResizer(settings);

  const normalizedSort = normalizeSortMode(settings.sortMode);
  if (normalizedSort !== settings.sortMode) {
    await saveSettings({ ...settings, sortMode: normalizedSort });
  }
  elements.sortSelect.value = normalizedSort;

  renderCategoryOptions(categories);
  await setupAutoRefresh();
  await setupCacheCleanup();
  const cleanup = await cleanupExpiredArticles();
  const dedupe = await deduplicateRecentArticles(false);
  await render();

  const dedupeText = dedupe.groups ? ` ・ ${dedupe.groups}話題を重複整理` : '';
  const cleanupText = cleanup.deleted ? ` ・ 72時間超 ${cleanup.deleted}件削除` : '';
  elements.statusText.textContent = `登録フィード ${sources.length}件 ・ カテゴリ ${categories.length}件${dedupeText}${cleanupText} ・ 「更新」で最新記事を取得`;
})();

// v0.1.23: stale feed-error reconciliation
// ----------------------------------------
function v023Timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function v023LatestArticleFetch(sourceId, allArticles = []) {
  let latest = 0;
  for (const article of allArticles) {
    if (article.sourceId !== sourceId) continue;
    latest = Math.max(latest, v023Timestamp(article.fetchedAt));
  }
  return latest;
}

function v023HasActiveFeedError(source, allArticles = []) {
  if (!source || source.feedHealthStatus !== 'error') return false;

  const failureAt = v023Timestamp(source.feedLastFailureAt);
  const successAt = Math.max(
    v023Timestamp(source.feedLastSuccessAt),
    v023LatestArticleFetch(source.id, allArticles)
  );

  // If a successful fetch happened at or after the stored failure,
  // the error state is stale and must not be displayed.
  if (successAt > 0 && (failureAt === 0 || successAt >= failureAt)) return false;
  return true;
}

async function v023ReconcileStoredFeedHealth() {
  try {
    const [{ sources }, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);
    let changed = false;
    const nextSources = sources.map(source => {
      if (!source || source.feedHealthStatus !== 'error') return source;
      if (v023HasActiveFeedError(source, allArticles)) return source;

      changed = true;
      const articleSuccessAt = v023LatestArticleFetch(source.id, allArticles);
      const knownSuccessAt = Math.max(v023Timestamp(source.feedLastSuccessAt), articleSuccessAt);
      return {
        ...source,
        feedFailCount: 0,
        feedHealthStatus: 'ok',
        feedLastError: '',
        feedLastFailureAt: '',
        registrationWarning: false,
        feedLastSuccessAt: knownSuccessAt ? new Date(knownSuccessAt).toISOString() : source.feedLastSuccessAt
      };
    });
    if (changed) await saveSources(nextSources);
  } catch (error) {
    console.debug('フィード状態の整合をスキップ:', error);
  }
}

const v023BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  v023BaseRenderSourceNavigation(sources, categories, allArticles, collapsedCategories);

  document.querySelectorAll('.source-item[data-source-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.sourceId);
    if (!source) return;
    const activeError = v023HasActiveFeedError(source, allArticles);
    if (activeError) return;

    row.classList.remove('has-feed-error');
    row.querySelector('.source-health-warning')?.remove();
    row.title = source.name || '';
  });
};

const v023BaseRenderSources = renderSources;
renderSources = async function(...args) {
  await v023BaseRenderSources(...args);
  const [{ sources }, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);

  document.querySelectorAll('.source-row[data-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.id);
    if (!source) return;
    const activeError = v023HasActiveFeedError(source, allArticles);
    if (activeError) return;

    row.classList.remove('has-feed-error');
    row.querySelector('.source-health-message')?.remove();
  });
};

v023ReconcileStoredFeedHealth().then(() => {
  render().catch(error => console.debug('フィード状態整合後の再描画をスキップ:', error));
});



// v0.1.24: YouTube channel URLs + dedicated category dialog
// ----------------------------------------------------------
function v024IsYouTubeChannelUrl(rawValue = '') {
  try {
    const url = new URL(String(rawValue || '').trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return false;
    const path = decodeURIComponent(url.pathname || '');
    return /^\/@[^/]+\/?$/i.test(path)
      || /^\/channel\/UC[A-Za-z0-9_-]{20,30}\/?$/i.test(path)
      || /^\/(?:user|c)\/[^/]+\/?$/i.test(path);
  } catch {
    return false;
  }
}

function v024DirectYouTubeChannelId(urlValue = '') {
  try {
    const path = new URL(urlValue).pathname;
    const match = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,30})(?:\/|$)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function v024ExtractYouTubeChannelId(html = '', pageUrl = '') {
  const direct = v024DirectYouTubeChannelId(pageUrl);
  if (direct) return direct;

  const patterns = [
    /feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{20,30})/i,
    /["']externalId["']\s*:\s*["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /content=["'](UC[A-Za-z0-9_-]{20,30})["'][^>]*itemprop=["']channelId["']/i,
    /itemprop=["']identifier["'][^>]*content=["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /["']channelId["']\s*:\s*["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /["']browseId["']\s*:\s*["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /\/channel\/(UC[A-Za-z0-9_-]{20,30})(?:[/?"'\\]|$)/i
  ];

  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function v024YouTubePageTitle(html = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const values = [
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      doc.querySelector('meta[name="title"]')?.getAttribute('content'),
      doc.querySelector('title')?.textContent
    ];
    for (const value of values) {
      const cleaned = String(value || '').replace(/\s+-\s+YouTube\s*$/i, '').trim();
      if (cleaned) return cleaned;
    }
  } catch { /* noop */ }
  return '';
}

async function v024PrepareYouTubeSource(rawValue, categoryId = '') {
  const channelUrl = String(rawValue || '').trim();
  let channelId = v024DirectYouTubeChannelId(channelUrl);
  let pageTitle = '';

  if (!channelId) {
    let page = null;
    try {
      page = await fetchHtmlPage(channelUrl);
    } catch (error) {
      throw new Error(`YouTubeチャンネルページを取得できませんでした：${error.message || error}`);
    }
    if (!page) throw new Error('YouTubeチャンネルページを取得できませんでした。');
    channelId = v024ExtractYouTubeChannelId(page.html, page.finalUrl || channelUrl);
    pageTitle = v024YouTubePageTitle(page.html);
  }

  if (!channelId) {
    throw new Error('YouTubeのチャンネルIDを取得できませんでした。チャンネルURLを確認してください。');
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  let meta = null;
  try {
    meta = await fetchFeedMeta(feedUrl);
  } catch (error) {
    throw new Error(`YouTubeフィードを取得できませんでした：${error.message || error}`);
  }
  if (!looksLikeFeedDocument(meta.text)) {
    throw new Error('YouTubeフィードをAtomとして認識できませんでした。');
  }

  return {
    id: uid(),
    type: 'rss',
    name: feedDocumentTitle(meta.text) || pageTitle || 'YouTube',
    value: feedUrl,
    categoryId,
    siteUrl: channelUrl,
    youtubeChannelId: channelId,
    youtubeChannelUrl: channelUrl,
    feedFailCount: 0,
    feedHealthStatus: 'ok',
    feedLastError: '',
    feedLastSuccessAt: new Date().toISOString()
  };
}

const v024BasePrepareAutoSource = prepareAutoSource;
prepareAutoSource = async function(rawValue, categoryId = '') {
  if (v024IsYouTubeChannelUrl(rawValue)) {
    return v024PrepareYouTubeSource(rawValue, categoryId);
  }
  return v024BasePrepareAutoSource(rawValue, categoryId);
};

function v024UpdateDetectionHint() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint || !v024IsYouTubeChannelUrl(elements.sourceValue.value)) return;
  hint.textContent = '自動判定：YouTube チャンネル';
}

elements.sourceValue.addEventListener('input', v024UpdateDetectionHint);
setTimeout(v024UpdateDetectionHint, 0);

const v024CategoriesDialog = document.getElementById('categoriesDialog');
const v024OpenCategoriesBtn = document.getElementById('openCategoriesBtn');
const v024CloseCategoriesBtn = document.getElementById('closeCategoriesBtn');
const v024DoneCategoriesBtn = document.getElementById('doneCategoriesBtn');

if (v024OpenCategoriesBtn && v024CategoriesDialog) {
  v024OpenCategoriesBtn.addEventListener('click', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const { categories } = await getState();
    renderCategoryManager(categories);
    v024CategoriesDialog.showModal();
    setTimeout(() => elements.categoryNameInput?.focus(), 30);
  }, true);
}

v024CloseCategoriesBtn?.addEventListener('click', () => v024CategoriesDialog?.close());
v024DoneCategoriesBtn?.addEventListener('click', () => v024CategoriesDialog?.close());

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !v024CategoriesDialog?.open) return;
  event.preventDefault();
  v024CategoriesDialog.close();
});



// Convert already-registered YouTube channel page URLs once as well.
async function v024MigrateExistingYouTubeSources() {
  try {
    const { sources } = await getState();
    let changed = false;
    const nextSources = [];

    for (const source of sources) {
      if (source.type !== 'rss' || !v024IsYouTubeChannelUrl(source.value)) {
        nextSources.push(source);
        continue;
      }

      try {
        const converted = await v024PrepareYouTubeSource(source.value, source.categoryId || '');
        nextSources.push({
          ...source,
          ...converted,
          id: source.id,
          name: source.name || converted.name,
          order: source.order,
          categoryId: source.categoryId || ''
        });
        changed = true;
      } catch (error) {
        console.debug('既存YouTubeフィードの変換をスキップ:', source.name, error);
        nextSources.push(source);
      }
    }

    if (changed) {
      await saveSources(nextSources);
      await render();
      if (elements.sourcesDialog?.open) await renderSources();
    }
  } catch (error) {
    console.debug('YouTubeフィード移行をスキップ:', error);
  }
}

window.addEventListener('load', () => {
  setTimeout(v024MigrateExistingYouTubeSources, 300);
}, { once: true });


// v0.1.25: pin "未分類" folder to top + refresh folder icons + remove helper text
// -----------------------------------------------------------------------------
function v025FolderSvg(open = false, small = false) {
  const stateClass = open ? 'open' : 'closed';
  const sizeClass = small ? 'small' : '';
  return `
    <span class="folder-glyph ${stateClass} ${sizeClass}" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" focusable="false">
        <path class="folder-tab" d="M3.8 7.85c0-1.35 1.1-2.45 2.45-2.45h4.35c.56 0 1.1.2 1.54.56l1.12.92c.24.2.55.31.86.31h3.55c1.26 0 2.28 1.02 2.28 2.28v.9H3.8v-2.52Z"/>
        <path class="folder-back" d="M3.55 10.05c0-.7.56-1.26 1.26-1.26h14.34c1.23 0 2.13 1.16 1.82 2.35l-1.43 5.48a2.28 2.28 0 0 1-2.2 1.7H6.66a2.28 2.28 0 0 1-2.2-1.7L3.63 12.3a2.77 2.77 0 0 1-.08-.68v-1.57Z"/>
        <path class="folder-front" d="M4.35 10.95h15.25c1.02 0 1.8.94 1.58 1.94l-1.08 5.02a1.95 1.95 0 0 1-1.9 1.54H5.8a1.95 1.95 0 0 1-1.9-1.54L2.82 12.9a1.62 1.62 0 0 1 1.53-1.95Z"/>
        <path class="folder-rim" d="M4.7 11.12h14.52"/>
        <path class="folder-shine" d="M6.85 13.25h4.65"/>
      </svg>
    </span>`;
}

function v025ApplyFolderChrome() {
  const nav = elements.sourceNav;
  if (!nav) return;

  nav.querySelector('.drag-hint')?.remove();

  const uncategorizedSection = nav.querySelector('.custom-category[data-category-id=""]');
  const firstCategory = nav.querySelector('.custom-category');
  if (uncategorizedSection && firstCategory && uncategorizedSection !== firstCategory) {
    nav.insertBefore(uncategorizedSection, firstCategory);
  }
  if (uncategorizedSection) {
    uncategorizedSection.classList.add('category-pinned-top');
    uncategorizedSection.querySelector('.category-header')?.classList.add('is-uncategorized');
    uncategorizedSection.querySelector('.category-drag-handle')?.remove();
    uncategorizedSection.querySelector('.category-drag-spacer')?.classList.add('hidden-spacer');
  }

  nav.querySelectorAll('.category-select-btn .category-folder').forEach(node => {
    const section = node.closest('.custom-category');
    const isOpen = !section?.classList.contains('collapsed');
    node.innerHTML = v025FolderSvg(isOpen);
  });

  nav.querySelectorAll('.favorite-folder-item .favorite-folder-icon').forEach(node => {
    if (node.textContent.includes('★')) return;
    node.innerHTML = v025FolderSvg(false, true);
  });
}

const v025BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(...args) {
  v025BaseRenderSourceNavigation(...args);
  v025ApplyFolderChrome();
};

const v025BaseRenderCategoryManager = renderCategoryManager;
renderCategoryManager = function(...args) {
  v025BaseRenderCategoryManager(...args);
  document.querySelectorAll('.category-manager-row .folder').forEach(node => {
    node.innerHTML = v025FolderSvg(false, true);
  });
};



// v0.1.27: restore the original high-visibility folder emoji icons
// ----------------------------------------------------------------
function v027RestoreOriginalFolderIcons() {
  if (!elements.sourceNav) return;

  elements.sourceNav.querySelectorAll('.custom-category').forEach(section => {
    const icon = section.querySelector('.category-select-btn .category-folder');
    if (!icon) return;
    icon.textContent = section.classList.contains('collapsed') ? '📁' : '📂';
  });

  elements.sourceNav.querySelectorAll('.favorite-folder-item .favorite-folder-icon').forEach(icon => {
    if (icon.textContent.includes('★')) return;
    icon.textContent = '📁';
  });

  elements.sourceNav.querySelector('.drag-hint')?.remove();
}

const v027BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(...args) {
  v027BaseRenderSourceNavigation(...args);
  v027RestoreOriginalFolderIcons();
};

const v027BaseRenderCategoryManager = renderCategoryManager;
renderCategoryManager = function(...args) {
  v027BaseRenderCategoryManager(...args);
  document.querySelectorAll('.category-manager-row .folder').forEach(icon => {
    icon.textContent = '📁';
  });
};



// v0.1.29: strict YouTube channel IDs + transient retry + old-source repair
// ----------------------------------------------------------------------
const V029_YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

function v029IsValidYouTubeChannelId(value = '') {
  return V029_YOUTUBE_CHANNEL_ID_RE.test(String(value || '').trim());
}

function v029YouTubeFeedChannelId(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return '';
    if (url.pathname !== '/feeds/videos.xml') return '';
    return url.searchParams.get('channel_id') || '';
  } catch {
    return '';
  }
}

function v029IsYouTubeFeedUrl(value = '') {
  return Boolean(v029YouTubeFeedChannelId(value));
}

function v029Sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry only transient YouTube fetch failures.
// Invalid IDs (404/400) are not retried.
const v029BaseFetchFeedMeta = fetchFeedMeta;
fetchFeedMeta = async function(url) {
  if (!v029IsYouTubeFeedUrl(url)) {
    return v029BaseFetchFeedMeta(url);
  }

  const waits = [0, 650, 1500];
  let lastError = null;

  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await v029Sleep(waits[attempt]);

    try {
      return await v029BaseFetchFeedMeta(url);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const transient =
        [429, 500, 502, 503, 504].includes(status)
        || error?.name === 'AbortError'
        || status === 0;

      if (!transient || attempt === waits.length - 1) throw error;
      console.debug(`YouTubeフィード再試行 ${attempt + 1}/${waits.length - 1}:`, url, error);
    }
  }

  throw lastError || new Error('YouTubeフィードを取得できませんでした');
};

// YouTube channel URLs must contain/resolve to an exact 24-character channel ID.
v024IsYouTubeChannelUrl = function(rawValue = '') {
  try {
    const url = new URL(String(rawValue || '').trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return false;
    const path = decodeURIComponent(url.pathname || '');
    return /^\/@[^/]+\/?$/i.test(path)
      || /^\/channel\/UC[A-Za-z0-9_-]{22}\/?$/i.test(path)
      || /^\/(?:user|c)\/[^/]+\/?$/i.test(path);
  } catch {
    return false;
  }
};

v024DirectYouTubeChannelId = function(urlValue = '') {
  try {
    const path = new URL(urlValue).pathname;
    const match = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
};

v024ExtractYouTubeChannelId = function(html = '', pageUrl = '') {
  const direct = v024DirectYouTubeChannelId(pageUrl);
  if (direct) return direct;

  const patterns = [
    /feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})(?:[^A-Za-z0-9_-]|$)/i,
    /["']externalId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{22})["']/i,
    /content=["'](UC[A-Za-z0-9_-]{22})["'][^>]*itemprop=["']channelId["']/i,
    /["']channelId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /["']browseId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?\"'\\]|$)/i
  ];

  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1] && v029IsValidYouTubeChannelId(match[1])) return match[1];
  }
  return '';
};

v024PrepareYouTubeSource = async function(rawValue, categoryId = '') {
  const channelUrl = String(rawValue || '').trim();
  let channelId = v024DirectYouTubeChannelId(channelUrl);
  let pageTitle = '';

  if (!channelId) {
    let page = null;
    try {
      page = await fetchHtmlPage(channelUrl);
    } catch (error) {
      throw new Error(`YouTubeチャンネルページを取得できませんでした：${error.message || error}`);
    }
    if (!page) throw new Error('YouTubeチャンネルページを取得できませんでした。');

    channelId = v024ExtractYouTubeChannelId(page.html, page.finalUrl || channelUrl);
    pageTitle = v024YouTubePageTitle(page.html);
  }

  if (!v029IsValidYouTubeChannelId(channelId)) {
    throw new Error(
      `YouTubeのチャンネルIDを正しく取得できませんでした`
      + (channelId ? `（${channelId.length}文字。24文字必要）` : '')
      + '。チャンネルURLを確認してください。'
    );
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

  let meta = null;
  try {
    meta = await fetchFeedMeta(feedUrl);
  } catch (error) {
    throw new Error(`YouTubeフィードを取得できませんでした：${error.message || error}`);
  }

  if (!looksLikeFeedDocument(meta.text)) {
    throw new Error('YouTubeフィードをAtomとして認識できませんでした。');
  }

  return {
    id: uid(),
    type: 'rss',
    name: feedDocumentTitle(meta.text) || pageTitle || 'YouTube',
    value: feedUrl,
    categoryId,
    siteUrl: channelUrl,
    youtubeChannelId: channelId,
    youtubeChannelUrl: channelUrl,
    feedFailCount: 0,
    feedHealthStatus: 'ok',
    feedLastError: '',
    feedLastFailureAt: '',
    registrationWarning: false,
    feedLastSuccessAt: new Date().toISOString()
  };
};

// Directly pasted YouTube Atom URLs also get strict ID validation.
const v029BasePrepareAutoSource = prepareAutoSource;
prepareAutoSource = async function(rawValue, categoryId = '') {
  const input = String(rawValue || '').trim();
  const youtubeFeedId = v029YouTubeFeedChannelId(input);

  if (youtubeFeedId && !v029IsValidYouTubeChannelId(youtubeFeedId)) {
    throw new Error(
      `YouTubeチャンネルIDが不正です（${youtubeFeedId.length}文字）。`
      + '24文字のチャンネルID、またはYouTubeのチャンネルURLを貼り付けてください。'
    );
  }

  return v029BasePrepareAutoSource(rawValue, categoryId);
};

// Fix bad YouTube IDs generated by earlier builds when the original channel URL is retained.
async function v029RepairStoredYouTubeIds() {
  try {
    const { sources } = await getState();
    let changed = false;
    const next = [];

    for (const source of sources) {
      const currentId = v029YouTubeFeedChannelId(source.value);

      if (!currentId || v029IsValidYouTubeChannelId(currentId)) {
        next.push(source);
        continue;
      }

      if (source.youtubeChannelUrl && v024IsYouTubeChannelUrl(source.youtubeChannelUrl)) {
        try {
          const repaired = await v024PrepareYouTubeSource(
            source.youtubeChannelUrl,
            source.categoryId || ''
          );
          next.push({
            ...source,
            ...repaired,
            id: source.id,
            name: source.name || repaired.name,
            order: source.order,
            categoryId: source.categoryId || ''
          });
          changed = true;
          continue;
        } catch (error) {
          console.debug('YouTube旧IDの再取得に失敗:', source.name, error);
        }
      }

      const message =
        `YouTubeチャンネルIDが不正です（${currentId.length}文字 / 24文字必要）。`
        + 'チャンネルURLから登録し直してください。';

      next.push({
        ...source,
        feedHealthStatus: 'error',
        feedLastError: message,
        feedLastFailureAt: new Date().toISOString()
      });
      changed = true;
    }

    if (changed) {
      await saveSources(next);
      await render();
      if (elements.sourcesDialog?.open) await renderSources();
    }
  } catch (error) {
    console.debug('YouTube ID整合処理をスキップ:', error);
  }
}

window.addEventListener('load', () => {
  setTimeout(v029RepairStoredYouTubeIds, 500);
}, { once: true });



// v0.1.30: unread-first auto sorting + strict current-view DOM scope
// -----------------------------------------------------------------

// 1) Articles: unread first, then read. Keep the selected time ordering inside each group.
const v030BaseSortArticles = sortArticles;
sortArticles = function(articles) {
  const mode = elements.sortSelect.value || 'newest';
  return [...articles].sort((a, b) => {
    // For unread-only/read-only both sides have the same state, so this is harmless.
    if (Boolean(a.read) !== Boolean(b.read)) return a.read ? 1 : -1;

    const aTime = new Date(a.publishedAt || a.fetchedAt || 0).getTime() || 0;
    const bTime = new Date(b.publishedAt || b.fetchedAt || 0).getTime() || 0;
    if (mode === 'oldest') return aTime - bTime;
    return bTime - aTime;
  });
};

function v030UnreadCountBySource(sources, allArticles) {
  const map = new Map(sources.map(source => [source.id, 0]));
  for (const article of allArticles) {
    if (!article.read && map.has(article.sourceId)) {
      map.set(article.sourceId, (map.get(article.sourceId) || 0) + 1);
    }
  }
  return map;
}

function v030DisplayOrderedSources(sources, allArticles) {
  const unreadBySource = v030UnreadCountBySource(sources, allArticles);
  return [...sources].sort((a, b) => {
    const aUnread = (unreadBySource.get(a.id) || 0) > 0;
    const bUnread = (unreadBySource.get(b.id) || 0) > 0;
    if (aUnread !== bUnread) return aUnread ? -1 : 1;

    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

function v030DisplayOrderedCategories(categories, sources, allArticles) {
  const unreadBySource = v030UnreadCountBySource(sources, allArticles);
  const sourceIdsByCategory = new Map();

  for (const source of sources) {
    const key = categoryKey(source);
    if (!sourceIdsByCategory.has(key)) sourceIdsByCategory.set(key, []);
    sourceIdsByCategory.get(key).push(source.id);
  }

  const hasUnread = categoryId =>
    (sourceIdsByCategory.get(categoryId) || []).some(sourceId => (unreadBySource.get(sourceId) || 0) > 0);

  return [...categories].sort((a, b) => {
    const aUnread = hasUnread(a.id);
    const bUnread = hasUnread(b.id);
    if (aUnread !== bUnread) return aUnread ? -1 : 1;

    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

// 2) Sidebar: unread folders and feeds float above fully-read ones.
// Persisted manual order is NOT changed; it remains the tie-breaker within each group.
const v030BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  const sortedCategories = v030DisplayOrderedCategories(categories, sources, allArticles)
    .map((category, index) => ({ ...category, order: index }));

  // Give each category its own display-only source order.
  const displaySources = [];
  const categoryIds = [...sortedCategories.map(category => category.id), ''];
  for (const categoryId of categoryIds) {
    const group = sources.filter(source => categoryKey(source) === categoryId);
    v030DisplayOrderedSources(group, allArticles).forEach((source, index) => {
      displaySources.push({ ...source, order: index });
    });
  }

  v030BaseRenderSourceNavigation(displaySources, sortedCategories, allArticles, collapsedCategories);
};

// 3) Story/duplicate DOM: never inject articles outside the CURRENT filtered page scope.
// Previously hidden duplicate rows came from all feeds, which page summarizers could read.
const v030BaseBuildStoryCards = buildStoryCards;
buildStoryCards = function(filteredArticles, allArticles) {
  return v030BaseBuildStoryCards(filteredArticles, filteredArticles);
};

function v030EnsurePageContextNode() {
  let node = document.getElementById('myfeedPageContext');
  if (node) return node;

  node = document.createElement('div');
  node.id = 'myfeedPageContext';
  node.className = 'sr-only myfeed-page-context';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  document.querySelector('main')?.prepend(node);
  return node;
}

async function v030UpdateSemanticPageContext() {
  try {
    const { sources, categories } = await getState();
    const viewTitle = currentViewTitle(sources, categories);
    document.title = `${viewTitle} | MyFeed`;

    const main = document.querySelector('main');
    main?.setAttribute('aria-label', `${viewTitle} - MyFeed`);
    elements.feedList?.setAttribute('aria-label', `${viewTitle}の記事一覧`);

    const context = v030EnsurePageContextNode();
    if (currentSourceId) {
      const source = sources.find(item => item.id === currentSourceId);
      context.textContent = source
        ? `現在表示中のフィードは「${source.name}」です。記事一覧はこのフィードの表示条件に限定されています。`
        : `現在表示中は「${viewTitle}」です。`;
    } else if (currentCategoryId !== null) {
      context.textContent = `現在表示中のフォルダは「${viewTitle}」です。記事一覧はこのフォルダの表示条件に限定されています。`;
    } else {
      context.textContent = `現在表示中は「${viewTitle}」です。`;
    }

    document.querySelectorAll('.source-item[data-source-id]').forEach(row => {
      if (row.dataset.sourceId === currentSourceId) row.setAttribute('aria-current', 'page');
      else row.removeAttribute('aria-current');
    });
    document.querySelectorAll('.category-select-btn[data-category-id]').forEach(row => {
      if (currentCategoryId !== null && row.dataset.categoryId === currentCategoryId) row.setAttribute('aria-current', 'page');
      else row.removeAttribute('aria-current');
    });
  } catch (error) {
    console.debug('ページ文脈更新をスキップ:', error);
  }
}

// Wrap the final render so document title/accessibility context always follows the selected feed.
const v030BaseRender = render;
render = async function(...args) {
  const result = await v030BaseRender(...args);
  await v030UpdateSemanticPageContext();
  return result;
};

window.addEventListener('load', () => {
  setTimeout(v030UpdateSemanticPageContext, 350);
}, { once: true });



// v0.1.31: make each feed/folder a real page navigation for Edge Copilot context
// ---------------------------------------------------------------------------
let v031PendingSourceNavigation = null;

function v031BuildViewUrl(kind, value = '') {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', kind);

  if (kind === 'source') url.searchParams.set('source', value);
  if (kind === 'category') {
    url.searchParams.set('category', value === '' ? '__uncategorized__' : value);
  }

  // Unique context token forces Edge to treat every switch as a new document URL.
  url.searchParams.set('ctx', String(Date.now()));
  return url.href;
}

function v031HardNavigate(kind, value = '') {
  const nextUrl = v031BuildViewUrl(kind, value);
  if (nextUrl === location.href) {
    location.reload();
    return;
  }
  location.replace(nextUrl);
}

// Capture source/category clicks BEFORE the old SPA click handler.
// Source navigation waits briefly so the existing double-click rename remains usable.
document.addEventListener('click', event => {
  if (event.defaultPrevented) return;
  if (event.target.closest('[data-collapse-category]')) return;

  const sourceButton = event.target.closest('[data-filter="source"][data-source-id]');
  if (sourceButton) {
    event.preventDefault();
    event.stopImmediatePropagation();

    clearTimeout(v031PendingSourceNavigation);
    const sourceId = sourceButton.dataset.sourceId || '';
    v031PendingSourceNavigation = setTimeout(() => {
      v031PendingSourceNavigation = null;
      v031HardNavigate('source', sourceId);
    }, 230);
    return;
  }

  const categoryButton = event.target.closest('[data-filter="category"][data-category-id]');
  if (categoryButton) {
    event.preventDefault();
    event.stopImmediatePropagation();
    clearTimeout(v031PendingSourceNavigation);
    v031PendingSourceNavigation = null;
    v031HardNavigate('category', categoryButton.dataset.categoryId ?? '');
  }
}, true);

// Cancel the delayed source navigation when the user is actually renaming by double-click.
document.addEventListener('dblclick', event => {
  if (!event.target.closest('.source-item[data-source-id] .source-name')) return;
  clearTimeout(v031PendingSourceNavigation);
  v031PendingSourceNavigation = null;
}, true);

function v031NormalizeDocumentIdentity() {
  try {
    const params = new URLSearchParams(location.search);
    const ctx = params.get('ctx') || '';
    if (ctx) document.documentElement.dataset.myfeedContext = ctx;
    document.documentElement.dataset.myfeedView = params.get('view') || 'all';
  } catch { /* noop */ }
}

v031NormalizeDocumentIdentity();




// ============================================================================
// Google News thumbnail enrichment from the search-results page
// ============================================================================
function googleNewsSearchPageUrl(source) {
  const query = String(source?.value || '').trim();
  if (!query) return '';
  return `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
}

function googleTitleVariants(value = '') {
  const raw = stripHtml(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const values = new Set([raw]);
  const lastDash = raw.lastIndexOf(' - ');
  if (lastDash > 12 && raw.length - lastDash < 45) values.add(raw.slice(0, lastDash).trim());
  const lastBar = Math.max(raw.lastIndexOf(' | '), raw.lastIndexOf('｜'));
  if (lastBar > 12 && raw.length - lastBar < 45) values.add(raw.slice(0, lastBar).trim());
  return Array.from(values).filter(Boolean);
}

function googleTitleKey(value = '') {
  return String(value || '')
    .normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？。、，,.・:：;；'"“”‘’「」『』【】（）()\[\]［］〈〉《》<>…‥―—–ー\-_|｜/\\]/g, '');
}

function googleCandidateImageUrl(image, baseUrl) {
  if (!image) return '';
  const rawCandidates = [
    candidateFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '', baseUrl),
    image.getAttribute('src'),
    image.getAttribute('data-src'),
    image.getAttribute('data-lazy-src'),
    image.getAttribute('data-original')
  ];
  for (const raw of rawCandidates) {
    const url = resolveHttpUrl(raw, baseUrl);
    if (!url) continue;
    const haystack = `${url} ${image.getAttribute('alt') || ''} ${image.getAttribute('class') || ''}`.toLowerCase();
    if (/logo|favicon|icon|avatar|sprite|emoji|tracking|pixel|spacer/.test(haystack)) continue;
    if (/google\s*news|googleニュース/.test(haystack)) continue;
    const width = Number.parseInt(image.getAttribute('width') || '0', 10);
    const height = Number.parseInt(image.getAttribute('height') || '0', 10);
    if (width && height && (width < 120 || height < 70)) continue;
    return url;
  }
  return '';
}

function googleResultTitleFromCard(card) {
  const selectors = ['a.JtKRv','h3 a[href]','h4 a[href]','a[href*="./articles/"]','a[href*="/articles/"]','a[href]'];
  for (const selector of selectors) {
    for (const anchor of Array.from(card.querySelectorAll(selector))) {
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length >= 12) return text;
    }
  }
  return '';
}

function googleResultImageFromCard(card, baseUrl) {
  for (const image of Array.from(card.querySelectorAll('img'))) {
    const url = googleCandidateImageUrl(image, baseUrl);
    if (url) return url;
  }
  return '';
}

function googleAddThumbnailCandidate(index, title, imageUrl) {
  if (!title || !imageUrl) return;
  for (const variant of googleTitleVariants(title)) {
    const key = googleTitleKey(variant);
    if (key.length < 10 || index.has(key)) continue;
    index.set(key, { title: variant, key, imageUrl });
  }
}

function googleNewsSearchThumbnailIndex(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const index = new Map();
  for (const card of Array.from(doc.querySelectorAll('article'))) {
    googleAddThumbnailCandidate(index, googleResultTitleFromCard(card), googleResultImageFromCard(card, baseUrl));
  }
  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
    if (title.length < 12) continue;
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const imageUrl = googleResultImageFromCard(node, baseUrl);
      if (!imageUrl) continue;
      googleAddThumbnailCandidate(index, title, imageUrl);
      break;
    }
  }
  return index;
}

function googleTitleMatchScore(articleKey, candidateKey) {
  if (!articleKey || !candidateKey) return 0;
  if (articleKey === candidateKey) return 1;
  const shorter = articleKey.length <= candidateKey.length ? articleKey : candidateKey;
  const longer = articleKey.length > candidateKey.length ? articleKey : candidateKey;
  if (shorter.length >= 14 && longer.includes(shorter)) return shorter.length / longer.length;
  if (articleKey.length < 12 || candidateKey.length < 12) return 0;
  const a = new Map();
  for (let i = 0; i < articleKey.length - 1; i++) {
    const gram = articleKey.slice(i, i + 2);
    a.set(gram, (a.get(gram) || 0) + 1);
  }
  let overlap = 0;
  let bCount = 0;
  for (let i = 0; i < candidateKey.length - 1; i++) {
    const gram = candidateKey.slice(i, i + 2);
    bCount++;
    const remaining = a.get(gram) || 0;
    if (remaining > 0) {
      overlap++;
      a.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / Math.max(1, (articleKey.length - 1) + bCount);
}

function googleThumbnailForItem(item, index) {
  const variants = googleTitleVariants(item?.title || '');
  for (const variant of variants) {
    const exact = index.get(googleTitleKey(variant));
    if (exact) return exact.imageUrl;
  }
  let best = null;
  for (const variant of variants) {
    const articleKey = googleTitleKey(variant);
    for (const candidate of index.values()) {
      const score = googleTitleMatchScore(articleKey, candidate.key);
      if (!best || score > best.score) best = { score, imageUrl: candidate.imageUrl };
    }
  }
  return best && best.score >= 0.86 ? best.imageUrl : '';
}

async function enrichGoogleNewsItemsFromSearch(items, source) {
  for (const item of items) item.imageUrl = '';
  const searchUrl = googleNewsSearchPageUrl(source);
  if (!searchUrl || !items.length) return items;
  try {
    const page = await fetchHtmlPage(searchUrl);
    if (!page?.html) return items;
    const index = googleNewsSearchThumbnailIndex(page.html, page.finalUrl || searchUrl);
    if (!index.size) return items;
    for (const item of items) {
      const imageUrl = googleThumbnailForItem(item, index);
      if (imageUrl) item.imageUrl = imageUrl;
    }
  } catch (error) {
    console.debug('Google News search thumbnail enrichment failed', source?.name || source?.value || '', error);
  }
  return items;
}

async function v032FetchOneSource(source) {
  try {
    const url = sourceUrl(source);
    const meta = await fetchFeedMeta(url);
    if (!looksLikeFeedDocument(meta.text)) throw new Error('RSS / Atom / RDFとして認識できませんでした');
    const parsed = parseFeed(meta.text, source, meta.finalUrl || url);
    if (source.type === 'google') await enrichGoogleNewsItemsFromSearch(parsed, source);
    const normalized = await normalizeItems(parsed, source);
    return {
      ok: true, source, articles: normalized,
      sourcePatch: {
        feedFailCount: 0, feedHealthStatus: 'ok', feedLastError: '',
        feedLastFailureAt: '', registrationWarning: false,
        feedLastSuccessAt: new Date().toISOString()
      }
    };
  } catch (error) {
    console.warn('フィード取得エラー:', source.name, error);
    return {
      ok: false, source, articles: [], error,
      sourcePatch: {
        feedFailCount: Number(source.feedFailCount || 0) + 1,
        feedHealthStatus: 'error',
        feedLastError: error?.message || String(error),
        feedLastFailureAt: new Date().toISOString()
      }
    };
  }
}

async function normalizeItems(items, source) {
  const result = [];
  for (const item of items) {
    const title = stripHtml(item.title || '(無題)');
    const url = item.url || '';
    const basis = item.guid || url || `${source.id}|${title}|${item.publishedAt}`;
    result.push({
      id: await hashText(basis),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title,
      description: stripHtml(item.description || '').slice(0, 500),
      imageUrl: resolveHttpUrl(item.imageUrl || '', url || sourceUrl(source)),
      imageCheckedAt: source.type === 'google' ? new Date().toISOString() : '',
      url,
      publishedAt: normalizeDate(item.publishedAt),
      fetchedAt: new Date().toISOString(),
      read: false,
      favorite: false
    });
  }
  return result;
}

const googleNewsOriginalShouldEnrichImage = shouldEnrichImage;
shouldEnrichImage = function(article) {
  if (article?.sourceType === 'google') return false;
  return googleNewsOriginalShouldEnrichImage(article);
};

// ============================================================================
// v0.2.1: content-aware dedupe + automatic next-feed flow
// ============================================================================

const V021_CONTENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const V021_BODY_WINDOW_MS = 18 * 60 * 60 * 1000;
const V021_BODY_RETRY_MS = 24 * 60 * 60 * 1000;
const V021_CONTENT_MAX_ARTICLES = 700;
const V021_BODY_MAX_PAIRS = 18;
const V021_BODY_MAX_ARTICLES = 10;
const V021_BODY_CONCURRENCY = 3;
const V021_BODY_CANDIDATE_BUFFER = 72;

function v021NormalizeContentText(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？“”"'‘’「」『』【】\[\]［］()（）・、,，.。:：;；|｜/／\\—–ー~〜…]/g, '')
    .trim();
}

function v021PrepareContentArticle(article) {
  const descriptionText = v021NormalizeContentText(article.description || '').slice(0, 1800);
  return {
    ...article,
    _v021Time: new Date(article.publishedAt || article.fetchedAt || 0).getTime() || 0,
    _v021Url: canonicalArticleUrl(article.url || ''),
    _v021TitleBigrams: makeBigrams(article.title || ''),
    _v021DescriptionText: descriptionText,
    _v021DescriptionBigrams: descriptionText.length >= 35 ? rawBigrams(descriptionText) : null
  };
}

function v021DescriptionSimilarity(a, b) {
  if (!a._v021DescriptionBigrams || !b._v021DescriptionBigrams) return 0;
  return diceSimilarity(a._v021DescriptionBigrams, b._v021DescriptionBigrams);
}

function v021TitleSimilarity(a, b) {
  return diceSimilarity(a._v021TitleBigrams, b._v021TitleBigrams);
}

function v021StrongContentDuplicate(a, b, titleScore, descriptionScore) {
  const sameSource = a.sourceId && a.sourceId === b.sourceId;
  if (sameSource) return titleScore >= 0.70 && descriptionScore >= 0.58;
  if (titleScore >= 0.62 && descriptionScore >= 0.42) return true;
  if (titleScore >= 0.48 && descriptionScore >= 0.62) return true;
  if (titleScore >= 0.32 && descriptionScore >= 0.76) return true;
  return false;
}

function v021BodyCandidate(a, b, titleScore, descriptionScore, timeDiff) {
  if (!a.url || !b.url) return false;
  if (a.sourceId && a.sourceId === b.sourceId) return false;
  if (timeDiff > V021_BODY_WINDOW_MS) return false;
  if (titleScore < 0.36 && descriptionScore < 0.28) return false;
  return true;
}

function v021ExtractMainText(html = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('article, main, [role="main"]') || doc.body;
  if (!root) return '';

  const clone = root.cloneNode(true);
  clone.querySelectorAll(
    'script,style,noscript,nav,header,footer,aside,form,svg,canvas,iframe,' +
    '.advertisement,.ads,.ad,.share,.social,.breadcrumb'
  ).forEach(node => node.remove());

  return String(clone.textContent || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

function v021Fnv1a64(value = '') {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash;
}

function v021BodySimHash(text = '') {
  const normalized = String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, 6500);

  if (normalized.length < 300) return '';

  const vector = new Int32Array(64);
  const gramSize = 3;
  const step = normalized.length > 4000 ? 2 : 1;

  for (let i = 0; i <= normalized.length - gramSize; i += step) {
    const gram = normalized.slice(i, i + gramSize);
    const hash = v021Fnv1a64(gram);
    for (let bit = 0n; bit < 64n; bit++) {
      vector[Number(bit)] += ((hash >> bit) & 1n) === 1n ? 1 : -1;
    }
  }

  let signature = 0n;
  for (let i = 0; i < 64; i++) {
    if (vector[i] >= 0) signature |= (1n << BigInt(i));
  }
  return signature.toString(16).padStart(16, '0');
}

function v021BodySignatureSimilarity(a = '', b = '') {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 0;
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return 1 - (distance / 64);
}

async function v021FetchBodyPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('html') && !type.includes('xhtml')) return null;
    return { html: await response.text(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function v021ResolveArticleBodyPage(article) {
  const first = await v021FetchBodyPage(article.url);
  if (!first) return null;

  try {
    const firstUrl = new URL(first.finalUrl || article.url);
    if (firstUrl.hostname === 'news.google.com' && typeof googleExternalArticleCandidate === 'function') {
      const doc = new DOMParser().parseFromString(first.html, 'text/html');
      const external = googleExternalArticleCandidate(doc, first.finalUrl || article.url);
      if (external) {
        try {
          const second = await v021FetchBodyPage(external);
          if (second) return second;
        } catch (error) {
          console.debug('重複判定用Google News本文の取得をスキップ:', error);
        }
      }
    }
  } catch { /* first pageを利用 */ }

  return first;
}

async function v021GetBodySignature(article) {
  const checkedAt = new Date(article.dedupeBodyCheckedAt || 0).getTime();
  const isFresh = Number.isFinite(checkedAt)
    && checkedAt > 0
    && Date.now() - checkedAt < V021_BODY_RETRY_MS;

  if (isFresh) return article.dedupeBodySignature || '';
  if (!article.url || !resolveHttpUrl(article.url)) return '';

  const now = new Date().toISOString();
  try {
    const page = await v021ResolveArticleBodyPage(article);
    const text = page ? v021ExtractMainText(page.html) : '';
    const signature = v021BodySimHash(text);

    await dbPatchArticle(article.id, {
      dedupeBodySignature: signature,
      dedupeBodyCheckedAt: now,
      dedupeBodyLength: text.length
    });

    article.dedupeBodySignature = signature;
    article.dedupeBodyCheckedAt = now;
    article.dedupeBodyLength = text.length;
    return signature;
  } catch (error) {
    console.debug('重複判定用本文の取得をスキップ:', article.title, error);
    await dbPatchArticle(article.id, {
      dedupeBodySignature: '',
      dedupeBodyCheckedAt: now,
      dedupeBodyLength: 0
    });
    article.dedupeBodySignature = '';
    article.dedupeBodyCheckedAt = now;
    article.dedupeBodyLength = 0;
    return '';
  }
}

async function v021RunLimited(items, concurrency, worker) {
  let next = 0;
  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: count }, () => runner()));
}

function v021PairPriority(pair) {
  return pair.titleScore * 0.62 + pair.descriptionScore * 0.38;
}

function v021PushBodyCandidate(buffer, pair) {
  buffer.push(pair);
  if (buffer.length <= V021_BODY_CANDIDATE_BUFFER * 2) return;
  buffer.sort((a, b) => v021PairPriority(b) - v021PairPriority(a));
  buffer.length = V021_BODY_CANDIDATE_BUFFER;
}

async function v021EnhanceDuplicateGroups() {
  const allArticles = await dbGetAllArticles();
  const cutoff = Date.now() - V021_CONTENT_WINDOW_MS;

  const recent = allArticles
    .filter(article => new Date(article.publishedAt || article.fetchedAt || 0).getTime() >= cutoff)
    .sort((a, b) =>
      new Date(b.publishedAt || b.fetchedAt || 0).getTime()
      - new Date(a.publishedAt || a.fetchedAt || 0).getTime()
    )
    .slice(0, V021_CONTENT_MAX_ARTICLES)
    .map(v021PrepareContentArticle);

  if (recent.length < 2) return { groups: 0, autoRead: 0, bodyPairs: 0 };

  const parent = recent.map((_, index) => index);
  const rank = recent.map(() => 0);

  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };

  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return false;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
    return true;
  };

  // Keep existing first-pass groups connected.
  const existingOwner = new Map();
  recent.forEach((article, index) => {
    if (!article.duplicateGroupId) return;
    if (existingOwner.has(article.duplicateGroupId)) union(index, existingOwner.get(article.duplicateGroupId));
    else existingOwner.set(article.duplicateGroupId, index);
  });

  const bodyCandidates = [];

  for (let i = 0; i < recent.length; i++) {
    const a = recent[i];
    for (let j = i + 1; j < recent.length; j++) {
      const b = recent[j];
      const timeDiff = Math.abs(a._v021Time - b._v021Time);
      if (timeDiff > V021_CONTENT_WINDOW_MS) continue;

      if (a._v021Url && b._v021Url && a._v021Url === b._v021Url) {
        union(i, j);
        continue;
      }

      const titleScore = v021TitleSimilarity(a, b);
      const descriptionScore = v021DescriptionSimilarity(a, b);

      if (v021StrongContentDuplicate(a, b, titleScore, descriptionScore)) {
        union(i, j);
        continue;
      }

      if (v021BodyCandidate(a, b, titleScore, descriptionScore, timeDiff)) {
        v021PushBodyCandidate(bodyCandidates, {
          aIndex: i,
          bIndex: j,
          titleScore,
          descriptionScore
        });
      }
    }
  }

  bodyCandidates.sort((a, b) => v021PairPriority(b) - v021PairPriority(a));
  const selectedPairs = bodyCandidates.slice(0, V021_BODY_MAX_PAIRS);

  const bodyArticleIndexes = [];
  const seenIndexes = new Set();
  for (const pair of selectedPairs) {
    for (const index of [pair.aIndex, pair.bIndex]) {
      if (seenIndexes.has(index)) continue;
      seenIndexes.add(index);
      bodyArticleIndexes.push(index);
      if (bodyArticleIndexes.length >= V021_BODY_MAX_ARTICLES) break;
    }
    if (bodyArticleIndexes.length >= V021_BODY_MAX_ARTICLES) break;
  }

  await v021RunLimited(bodyArticleIndexes, V021_BODY_CONCURRENCY, async index => {
    await v021GetBodySignature(recent[index]);
  });

  let bodyPairs = 0;
  for (const pair of selectedPairs) {
    const a = recent[pair.aIndex];
    const b = recent[pair.bIndex];
    if (!a.dedupeBodySignature || !b.dedupeBodySignature) continue;

    const bodyScore = v021BodySignatureSimilarity(a.dedupeBodySignature, b.dedupeBodySignature);
    const titleScore = pair.titleScore;
    const descriptionScore = pair.descriptionScore;

    const bodyDuplicate =
      bodyScore >= 0.89
      || (bodyScore >= 0.84 && titleScore >= 0.46)
      || (bodyScore >= 0.82 && descriptionScore >= 0.48);

    if (bodyDuplicate && union(pair.aIndex, pair.bIndex)) bodyPairs++;
  }

  const recentGroups = new Map();
  recent.forEach((article, index) => {
    const root = find(index);
    if (!recentGroups.has(root)) recentGroups.set(root, []);
    recentGroups.get(root).push(article);
  });

  const updates = [];
  let groups = 0;
  let autoRead = 0;

  for (const group of recentGroups.values()) {
    if (group.length < 2) continue;

    // Expand merged first-pass groups to all their members, including those just outside 24h.
    const oldGroupIds = new Set(group.map(a => a.duplicateGroupId).filter(Boolean));
    const expanded = [...group];
    const expandedIds = new Set(group.map(a => a.id));

    if (oldGroupIds.size) {
      for (const article of allArticles) {
        if (!article.duplicateGroupId || !oldGroupIds.has(article.duplicateGroupId)) continue;
        if (expandedIds.has(article.id)) continue;
        expandedIds.add(article.id);
        expanded.push(article);
      }
    }

    if (expanded.length < 2) continue;
    groups++;

    const representative = chooseClusterRepresentative(expanded);
    const existingRepresentatives = expanded.filter(article => article.duplicateRepresentative);
    const groupUnread = existingRepresentatives.length
      ? existingRepresentatives.some(article => !article.read)
      : expanded.some(article => !article.read && !article.duplicateAutoRead);

    const groupId = representative.duplicateGroupId || `dup-${representative.id}`;

    for (const article of expanded) {
      const isRepresentative = article.id === representative.id;
      const nextRead = isRepresentative ? !groupUnread : true;
      const nextAutoRead = !isRepresentative && groupUnread;

      if (!isRepresentative && !article.read && nextRead) autoRead++;

      updates.push({
        id: article.id,
        patch: {
          duplicateGroupId: groupId,
          duplicateRepresentative: isRepresentative,
          duplicateAutoRead: nextAutoRead,
          read: nextRead
        }
      });
    }
  }

  if (updates.length) await dbPatchArticles(updates);
  return { groups, autoRead, bodyPairs };
}

const v021BaseDeduplicateRecentArticles = deduplicateRecentArticles;
deduplicateRecentArticles = async function(force = false) {
  const base = await v021BaseDeduplicateRecentArticles(force);
  try {
    const enhanced = await v021EnhanceDuplicateGroups();
    return {
      ...base,
      groups: Math.max(Number(base.groups || 0), Number(enhanced.groups || 0)),
      autoRead: Number(base.autoRead || 0) + Number(enhanced.autoRead || 0),
      bodyPairs: Number(enhanced.bodyPairs || 0)
    };
  } catch (error) {
    console.warn('本文対応の重複判定をスキップ:', error);
    return base;
  }
};


// ---------------------------------------------------------------------------
// Automatic reading flow
// ---------------------------------------------------------------------------

let v021AutoAdvanceTimer = null;
let v021AutoAdvanceRunning = false;

function v021UnreadCountForSource(sourceId, allArticles) {
  return allArticles.reduce(
    (count, article) => count + (article.sourceId === sourceId && !article.read ? 1 : 0),
    0
  );
}

function v021CategoryHasUnread(categoryId, sources, allArticles) {
  const sourceIds = new Set(
    sources.filter(source => categoryKey(source) === categoryId).map(source => source.id)
  );
  return allArticles.some(article => !article.read && sourceIds.has(article.sourceId));
}

function v021OrderedCategoryKeys(categories = []) {
  return ['', ...orderedCategories(categories).map(category => category.id)];
}

function v021NextUnreadCategory(currentCategoryId, categories, sources, allArticles) {
  const keys = v021OrderedCategoryKeys(categories);
  if (!keys.length) return null;

  const currentIndex = Math.max(0, keys.indexOf(currentCategoryId));
  const searchOrder = [...keys.slice(currentIndex + 1), ...keys.slice(0, currentIndex)];

  for (const key of searchOrder) {
    if (v021CategoryHasUnread(key, sources, allArticles)) return key;
  }
  return null;
}

function v021NextUnreadSourceInCategory(currentSource, sources, allArticles) {
  const categoryId = categoryKey(currentSource);
  const group = orderedSources(sources.filter(source => categoryKey(source) === categoryId));
  const index = group.findIndex(source => source.id === currentSource.id);

  const candidates = index >= 0
    ? [...group.slice(index + 1), ...group.slice(0, index)]
    : group;

  return candidates.find(source => v021UnreadCountForSource(source.id, allArticles) > 0) || null;
}

async function v021MaybeAutoAdvance() {
  if (v021AutoAdvanceRunning) return;
  if (!currentSourceId && currentCategoryId === null) return;

  v021AutoAdvanceRunning = true;
  try {
    const [allArticles, state] = await Promise.all([dbGetAllArticles(), getState()]);
    const { sources, categories } = state;

    if (currentSourceId) {
      const currentSource = sources.find(source => source.id === currentSourceId);
      if (!currentSource) return;

      if (v021UnreadCountForSource(currentSource.id, allArticles) > 0) return;

      const nextSource = v021NextUnreadSourceInCategory(currentSource, sources, allArticles);
      if (nextSource) {
        v031HardNavigate('source', nextSource.id);
        return;
      }

      const currentCategoryId = categoryKey(currentSource);
      const nextCategory = v021NextUnreadCategory(currentCategoryId, categories, sources, allArticles);
      if (nextCategory !== null) {
        v031HardNavigate('category', nextCategory);
        return;
      }

      showToast('🎉 すべての未読フィードを確認しました！');
      return;
    }

    if (currentCategoryId !== null) {
      if (v021CategoryHasUnread(currentCategoryId, sources, allArticles)) return;

      const nextCategory = v021NextUnreadCategory(currentCategoryId, categories, sources, allArticles);
      if (nextCategory !== null) {
        v031HardNavigate('category', nextCategory);
        return;
      }

      showToast('🎉 すべての未読フィードを確認しました！');
    }
  } finally {
    v021AutoAdvanceRunning = false;
  }
}

function v021ScheduleAutoAdvance(delay = 180) {
  clearTimeout(v021AutoAdvanceTimer);
  v021AutoAdvanceTimer = setTimeout(() => {
    v021AutoAdvanceTimer = null;
    v021MaybeAutoAdvance();
  }, delay);
}

// Wait until the DB write from existing article handlers has completed.
const v021BaseSetStoryReadState = setStoryReadState;
setStoryReadState = async function(id, read) {
  const result = await v021BaseSetStoryReadState(id, read);
  if (read) v021ScheduleAutoAdvance(80);
  return result;
};

// Covers image links inserted later by lazy image enrichment.
document.addEventListener('click', event => {
  if (event.target.closest('.article-link')) v021ScheduleAutoAdvance(420);
}, true);


// v0.2.2: registered-feed search controls
(() => {
  const search = document.getElementById('sourceManagerSearch');
  const clearButton = document.getElementById('sourceManagerSearchClear');
  if (!search) return;

  search.addEventListener('input', () => renderSources());
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') event.preventDefault();
  });

  clearButton?.addEventListener('click', () => {
    search.value = '';
    search.focus();
    renderSources();
  });

  elements.sourcesDialog?.addEventListener('close', () => {
    search.value = '';
    if (clearButton) clearButton.hidden = true;
  });
})();

// ============================================================================
// v0.2.3: Google News site fallback for ordinary website URLs
// ============================================================================
function googleNewsSiteQuery(value = '') {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, '').trim().toLowerCase();
    return hostname ? `site:${hostname}` : '';
  } catch {
    return '';
  }
}

function googleNewsFallbackName(siteName = '', originalUrl = '') {
  const clean = String(siteName || '').replace(/\s+/g, ' ').trim();
  if (clean) return clean.slice(0, 100);
  try { return new URL(originalUrl).hostname.replace(/^www\./i, ''); } catch { return 'WEBニュース'; }
}

async function prepareGoogleNewsSiteFallback(originalUrl, siteName, categoryId = '', cause = null) {
  const query = googleNewsSiteQuery(originalUrl);
  if (!query) throw cause || new Error('Google News検索用のドメインを判定できませんでした。');

  try {
    const meta = await fetchFeedMeta(sourceUrl({ type: 'google', value: query }));
    if (!looksLikeFeedDocument(meta.text)) throw new Error('Google Newsの検索結果をRSSとして読み込めませんでした');
    return {
      id: uid(),
      type: 'google',
      name: googleNewsFallbackName(siteName, originalUrl),
      value: query,
      categoryId,
      feedFailCount: 0,
      feedHealthStatus: 'ok',
      feedLastError: '',
      feedLastSuccessAt: new Date().toISOString(),
      discoveryMode: 'google-site-fallback',
      originalUrl
    };
  } catch (error) {
    const reason = error?.message || cause?.message || '取得できませんでした';
    throw new Error(`RSS / Atomを見つけられず、Google News経由でも登録できませんでした：${reason}`);
  }
}

const v023BasePrepareAutoSource = prepareAutoSource;
prepareAutoSource = async function(rawValue, categoryId = '') {
  const detected = detectSourceInput(rawValue);
  if (detected.type !== 'rss') return v023BasePrepareAutoSource(rawValue, categoryId);

  const explicit = looksLikeExplicitFeedUrl(detected.value);
  if (explicit) return v023BasePrepareAutoSource(rawValue, categoryId);

  try {
    const result = await v023BasePrepareAutoSource(rawValue, categoryId);
    if (!(result?.type === 'rss' && result.feedHealthStatus === 'error')) return result;
  } catch (baseError) {
    let page = null;
    try { page = await fetchHtmlPage(detected.value); } catch { /* fallback below */ }
    const finalUrl = page?.finalUrl || detected.value;
    const siteName = page?.html ? siteDisplayNameFromHtml(page.html, finalUrl) : '';
    return prepareGoogleNewsSiteFallback(finalUrl, siteName, categoryId, baseError);
  }

  let page = null;
  try { page = await fetchHtmlPage(detected.value); } catch { /* fallback below */ }
  const finalUrl = page?.finalUrl || detected.value;
  const siteName = page?.html ? siteDisplayNameFromHtml(page.html, finalUrl) : '';
  return prepareGoogleNewsSiteFallback(finalUrl, siteName, categoryId);
};

// ============================================================================
// v0.2.6: Google News alphabetic keywords = Japan + US English
// ============================================================================
function v026ContainsJapaneseKeyword(value = '') {
  return /[ぁ-んァ-ヶ一-龯々〆ヵヶ]/u.test(String(value || ''));
}

function v026GoogleNewsModeForKeyword(value = '') {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text) return 'jp';
  if (v026ContainsJapaneseKeyword(text)) return 'jp';
  return /[A-Za-z]/.test(text) ? 'dual' : 'jp';
}

function v026GoogleNewsModeForSource(source = {}) {
  if (source.newsEdition === 'jp' || source.newsEdition === 'us') return source.newsEdition;
  if (source.discoveryMode === 'google-site-fallback') return 'jp';
  if (/^\s*site:/i.test(String(source.value || ''))) return 'jp';
  return v026GoogleNewsModeForKeyword(source.value || '');
}

function v026GoogleNewsModeLabel(mode) {
  return mode === 'dual' ? '🇯🇵 国内 + 🌍 海外・英語' : '🇯🇵 国内';
}

function v026GoogleNewsRssUrl(query, locale = 'jp') {
  const q = encodeURIComponent(String(query || '').trim());
  if (locale === 'us') {
    return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }
  return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

function v026GoogleNewsSearchUrl(query, locale = 'jp') {
  const q = encodeURIComponent(String(query || '').trim());
  if (locale === 'us') {
    return `https://news.google.com/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }
  return `https://news.google.com/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

const v026BaseSourceUrl = sourceUrl;
sourceUrl = function(source) {
  if (!source || source.type !== 'google') return v026BaseSourceUrl(source);
  const mode = v026GoogleNewsModeForSource(source);
  return v026GoogleNewsRssUrl(source.value, mode === 'us' ? 'us' : 'jp');
};

// Keep thumbnail lookup on the same Google News edition as the RSS being fetched.
googleNewsSearchPageUrl = function(source) {
  const query = String(source?.value || '').trim();
  if (!query) return '';
  const mode = v026GoogleNewsModeForSource(source);
  return v026GoogleNewsSearchUrl(query, mode === 'us' ? 'us' : 'jp');
};

const v026BasePrepareAutoSource = prepareAutoSource;
prepareAutoSource = async function(rawValue, categoryId = '') {
  const detected = detectSourceInput(rawValue);
  const source = await v026BasePrepareAutoSource(rawValue, categoryId);

  if (source?.type === 'google') {
    if (source.discoveryMode === 'google-site-fallback' || /^\s*site:/i.test(String(source.value || ''))) {
      source.newsLocale = 'jp';
    } else if (detected.type === 'google') {
      source.newsLocale = v026GoogleNewsModeForKeyword(detected.value);
    }
  }

  return source;
};

const v026BaseUpdateAutoSourceDetectionHint = updateAutoSourceDetectionHint;
updateAutoSourceDetectionHint = function() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint) return;

  const detected = detectSourceInput(elements.sourceValue.value);
  if (detected.type !== 'google') {
    v026BaseUpdateAutoSourceDetectionHint();
    return;
  }

  const mode = v026GoogleNewsModeForKeyword(detected.value);
  hint.textContent = `自動判定：Google News キーワード（${v026GoogleNewsModeLabel(mode)}）`;
};

function v026MergeNormalizedArticles(articleLists = []) {
  const merged = new Map();

  for (const articles of articleLists) {
    for (const article of articles || []) {
      const existing = merged.get(article.id);
      if (!existing) {
        merged.set(article.id, article);
        continue;
      }

      const existingDesc = String(existing.description || '');
      const nextDesc = String(article.description || '');
      merged.set(article.id, {
        ...existing,
        ...article,
        imageUrl: existing.imageUrl || article.imageUrl || '',
        description: existingDesc.length >= nextDesc.length ? existingDesc : nextDesc
      });
    }
  }

  return Array.from(merged.values());
}

async function v026FetchGoogleEdition(source, locale) {
  const editionSource = { ...source, newsEdition: locale };
  const url = v026GoogleNewsRssUrl(source.value, locale);
  const meta = await fetchFeedMeta(url);

  if (!looksLikeFeedDocument(meta.text)) {
    throw new Error(`${locale === 'us' ? '海外' : '国内'}版をRSSとして認識できませんでした`);
  }

  const parsed = parseFeed(meta.text, editionSource, meta.finalUrl || url);
  await enrichGoogleNewsItemsFromSearch(parsed, editionSource);
  return normalizeItems(parsed, editionSource);
}

const v026BaseFetchOneSource = v032FetchOneSource;
v032FetchOneSource = async function(source) {
  if (!source || source.type !== 'google' || v026GoogleNewsModeForSource(source) !== 'dual') {
    return v026BaseFetchOneSource(source);
  }

  const settled = await Promise.allSettled([
    v026FetchGoogleEdition(source, 'jp'),
    v026FetchGoogleEdition(source, 'us')
  ]);

  const successfulLists = settled
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);
  const failures = settled.filter(result => result.status === 'rejected');

  if (!successfulLists.length) {
    const messages = failures
      .map(result => result.reason?.message || String(result.reason || ''))
      .filter(Boolean);
    const error = new Error(messages.join(' / ') || '国内版・海外版とも取得できませんでした');

    return {
      ok: false,
      source,
      articles: [],
      error,
      sourcePatch: {
        feedFailCount: Number(source.feedFailCount || 0) + 1,
        feedHealthStatus: 'error',
        feedLastError: error.message,
        feedLastFailureAt: new Date().toISOString()
      }
    };
  }

  if (failures.length) {
    console.warn('Google News 国内+海外取得: 一部エディションをスキップ', source.name, failures[0].reason);
  }

  return {
    ok: true,
    source,
    articles: v026MergeNormalizedArticles(successfulLists),
    sourcePatch: {
      feedFailCount: 0,
      feedHealthStatus: 'ok',
      feedLastError: failures.length ? '国内版 / 海外版のどちらか一方のみ取得しました' : '',
      feedLastFailureAt: '',
      registrationWarning: false,
      feedLastSuccessAt: new Date().toISOString(),
      newsLocale: 'dual'
    }
  };
};
// ============================================================================
// v0.2.7: oldest-first duplicate reading policy + show all remaining articles
// ============================================================================
(() => {
  const v027RawDbPatchArticles = dbPatchArticles;
  const v027RawDbPatchArticle = dbPatchArticle;

  function v027ArticleTime(article) {
    const published = new Date(article?.publishedAt || '').getTime();
    if (Number.isFinite(published) && published > 0) return published;
    const fetched = new Date(article?.fetchedAt || '').getTime();
    return Number.isFinite(fetched) ? fetched : 0;
  }

  function v027OldestArticle(members = []) {
    return [...members].sort((a, b) => {
      const timeDiff = v027ArticleTime(a) - v027ArticleTime(b);
      if (timeDiff) return timeDiff;

      const fetchedA = new Date(a?.fetchedAt || 0).getTime();
      const fetchedB = new Date(b?.fetchedAt || 0).getTime();
      const fetchedDiff = (Number.isFinite(fetchedA) ? fetchedA : 0) - (Number.isFinite(fetchedB) ? fetchedB : 0);
      if (fetchedDiff) return fetchedDiff;

      return String(a?.id || '').localeCompare(String(b?.id || ''));
    })[0] || null;
  }

  function v027TopicAlreadyRead(members = []) {
    if (members.some(article => article.duplicateTopicRead === true)) return true;

    // Legacy migration:
    // all read + no duplicateAutoRead means the group was likely genuinely read.
    // If auto-read markers remain, restore one oldest unread item to avoid a miss.
    const allRead = members.length > 0 && members.every(article => article.read === true);
    const hasAutoRead = members.some(article => article.duplicateAutoRead === true);
    return allRead && !hasAutoRead;
  }

  async function v027MarkTopicsReadForIds(ids = []) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (!uniqueIds.length) return;

    const allArticles = await dbGetAllArticles();
    const targetIds = new Set(uniqueIds);
    const groupIds = new Set(
      allArticles
        .filter(article => targetIds.has(article.id) && article.duplicateGroupId)
        .map(article => article.duplicateGroupId)
    );
    if (!groupIds.size) return;

    const updates = allArticles
      .filter(article => groupIds.has(article.duplicateGroupId))
      .map(article => ({
        id: article.id,
        patch: {
          read: true,
          duplicateAutoRead: false,
          duplicateTopicRead: true
        }
      }));

    if (updates.length) await v027RawDbPatchArticles(updates);
  }

  async function v027NormalizeDuplicateGroups() {
    const allArticles = await dbGetAllArticles();
    const groups = new Map();

    for (const article of allArticles) {
      if (!article.duplicateGroupId) continue;
      if (!groups.has(article.duplicateGroupId)) groups.set(article.duplicateGroupId, []);
      groups.get(article.duplicateGroupId).push(article);
    }

    const updates = [];
    let unreadTopics = 0;
    let readTopics = 0;

    for (const [groupId, members] of groups) {
      if (members.length < 2) continue;
      const representative = v027OldestArticle(members);
      if (!representative) continue;

      const topicRead = v027TopicAlreadyRead(members);
      if (topicRead) readTopics++;
      else unreadTopics++;

      for (const article of members) {
        const isRepresentative = article.id === representative.id;
        updates.push({
          id: article.id,
          patch: topicRead
            ? {
                duplicateGroupId: groupId,
                duplicateRepresentative: isRepresentative,
                duplicateAutoRead: false,
                duplicateTopicRead: true,
                read: true
              }
            : {
                duplicateGroupId: groupId,
                duplicateRepresentative: isRepresentative,
                duplicateAutoRead: !isRepresentative,
                duplicateTopicRead: false,
                read: !isRepresentative
              }
        });
      }
    }

    if (updates.length) await v027RawDbPatchArticles(updates);
    return { groups: groups.size, unreadTopics, readTopics, patched: updates.length };
  }

  // Always choose the oldest published item as duplicate representative.
  if (typeof chooseClusterRepresentative === 'function') {
    chooseClusterRepresentative = function(cluster) {
      return v027OldestArticle(cluster);
    };
  }

  // A direct read write should also lock the whole duplicate topic as read.
  dbPatchArticle = async function(id, patch) {
    await v027RawDbPatchArticle(id, patch);

    const looksLikeManualRead = patch?.read === true
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateGroupId')
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateRepresentative')
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateTopicRead');

    if (looksLikeManualRead) await v027MarkTopicsReadForIds([id]);
  };

  // Bulk-read writes such as "表示中を既読" also lock duplicate topics as read.
  dbPatchArticles = async function(updates) {
    await v027RawDbPatchArticles(updates);

    const manualReadIds = (updates || [])
      .filter(update => {
        const p = update?.patch || {};
        return p.read === true
          && !Object.prototype.hasOwnProperty.call(p, 'duplicateGroupId')
          && !Object.prototype.hasOwnProperty.call(p, 'duplicateRepresentative')
          && !Object.prototype.hasOwnProperty.call(p, 'duplicateTopicRead');
      })
      .map(update => update.id);

    if (manualReadIds.length) await v027MarkTopicsReadForIds(manualReadIds);
  };

  // Reading a duplicate topic locks the whole topic.
  // Returning to unread explicitly clears the lock and restores only the oldest.
  const v027BaseSetStoryReadState = setStoryReadState;
  setStoryReadState = async function(id, read) {
    const allArticles = await dbGetAllArticles();
    const target = allArticles.find(article => article.id === id);

    if (!target?.duplicateGroupId) return v027BaseSetStoryReadState(id, read);

    const members = allArticles.filter(article => article.duplicateGroupId === target.duplicateGroupId);
    if (members.length < 2) return v027BaseSetStoryReadState(id, read);

    if (read) {
      await v027RawDbPatchArticles(members.map(article => ({
        id: article.id,
        patch: {
          read: true,
          duplicateAutoRead: false,
          duplicateTopicRead: true
        }
      })));
      if (typeof v021ScheduleAutoAdvance === 'function') v021ScheduleAutoAdvance(80);
      return;
    }

    const representative = v027OldestArticle(members);
    await v027RawDbPatchArticles(members.map(article => ({
      id: article.id,
      patch: {
        read: article.id !== representative.id,
        duplicateRepresentative: article.id === representative.id,
        duplicateAutoRead: article.id !== representative.id,
        duplicateTopicRead: false
      }
    })));
  };

  // Final safety net after all duplicate-detection passes.
  const v027BaseDeduplicateRecentArticles = deduplicateRecentArticles;
  deduplicateRecentArticles = async function(force = false) {
    const result = await v027BaseDeduplicateRecentArticles(force);
    const policy = await v027NormalizeDuplicateGroups();
    return {
      ...result,
      oldestRepresentativePolicy: true,
      topicReadGroups: policy.readTopics,
      topicUnreadGroups: policy.unreadTopics,
      topicPolicyPatched: policy.patched
    };
  };

  function v027DecorateUi() {
    if (elements?.loadMoreBtn) {
      elements.loadMoreBtn.textContent = '残りをすべて表示';
      elements.loadMoreBtn.setAttribute('aria-label', '残っている記事をすべて表示');
    }

    document.querySelectorAll('.article-card.has-duplicates').forEach(card => {
      const representativeStatus = card.querySelector('.duplicate-status.representative');
      if (representativeStatus) {
        representativeStatus.textContent = card.classList.contains('read') ? '既読' : '未読';
      }

      const summary = card.querySelector('.duplicate-summary small');
      if (summary) {
        summary.textContent = card.classList.contains('read')
          ? 'この話題は確認済みです。後から追加された重複記事も既読にします'
          : '最初の記事を未読代表にし、後から追加された重複記事は自動で既読にしています';
      }
    });
  }

  const v027BaseRender = render;
  render = async function() {
    const result = await v027BaseRender();
    v027DecorateUi();
    return result;
  };

  // Replace +50 with "show every remaining story".
  if (elements?.loadMoreBtn) {
    elements.loadMoreBtn.addEventListener('click', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      renderedLimit = Number.MAX_SAFE_INTEGER;
      await render();
    }, true);
  }

  // One-time migration/repair:
  // groups that may have been fully auto-read by older builds get the oldest
  // representative restored to unread, unless the group appears genuinely read.
  setTimeout(async () => {
    try {
      await v027NormalizeDuplicateGroups();
      await render();
    } catch (error) {
      console.warn('v0.2.7 重複既読ポリシーの初期化をスキップ:', error);
      v027DecorateUi();
    }
  }, 0);
})();
// ============================================================================
// v0.2.8: bulk-read duplicate-topic lock fix
// ============================================================================
// "表示中を既読" uses dbPatchMany(). v0.2.7 only handled dbPatchArticle/
// dbPatchArticles, so a duplicate group's old auto-read markers could survive.
// The next normalization then mistook the group as unread and restored the
// oldest representative. Lock every affected duplicate group as topic-read.
(() => {
  const v028RawDbPatchMany = dbPatchMany;
  const v028RawDbPatchArticles = dbPatchArticles;

  async function v028LockDuplicateTopics(ids = []) {
    const uniqueIds = [...new Set((ids || []).filter(Boolean))];
    if (!uniqueIds.length) return;

    const allArticles = await dbGetAllArticles();
    const targetIds = new Set(uniqueIds);
    const groupIds = new Set(
      allArticles
        .filter(article => targetIds.has(article.id) && article.duplicateGroupId)
        .map(article => article.duplicateGroupId)
    );

    if (!groupIds.size) return;

    const updates = allArticles
      .filter(article => groupIds.has(article.duplicateGroupId))
      .map(article => ({
        id: article.id,
        patch: {
          read: true,
          duplicateAutoRead: false,
          duplicateTopicRead: true
        }
      }));

    if (updates.length) await v028RawDbPatchArticles(updates);
  }

  dbPatchMany = async function(ids, patch) {
    await v028RawDbPatchMany(ids, patch);

    const looksLikeBulkRead = patch?.read === true
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateGroupId')
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateRepresentative')
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateTopicRead');

    if (looksLikeBulkRead) await v028LockDuplicateTopics(ids);
  };
})();
