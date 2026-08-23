// v0.3.0: high-speed bulk refresh
// --------------------------------
// - Normal RSS / WEB / X: up to 12 sources in parallel.
// - Google News: up to 6 sources in parallel (dual JP/US editions stay parallel per source).
// - Bulk refresh fetch timeout: 12 seconds per request.
// - Google News thumbnails no longer block article availability; they are enriched later
//   in a low-concurrency background job and patched into IndexedDB without touching read/favorite state.

(() => {
  const V030_NORMAL_CONCURRENCY = 12;
  const V030_GOOGLE_CONCURRENCY = 6;
  const V030_THUMBNAIL_CONCURRENCY = 2;
  const V030_FETCH_TIMEOUT_MS = 12000;

  let v030ThumbnailJobToken = 0;
  let v030ProgressHideTimer = null;

  function v030ProgressElements() {
    return {
      root: document.getElementById('refreshProgress'),
      label: document.getElementById('refreshProgressLabel'),
      percent: document.getElementById('refreshProgressPercent'),
      track: document.getElementById('refreshProgressTrack'),
      fill: document.getElementById('refreshProgressFill'),
      detail: document.getElementById('refreshProgressDetail')
    };
  }

  function v030FormatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 2) return '残りわずか';
    if (seconds < 60) return `残り約${Math.ceil(seconds)}秒`;
    return `残り約${Math.ceil(seconds / 60)}分`;
  }

  function v030ShowProgress() {
    const ui = v030ProgressElements();
    if (!ui.root) return;
    clearTimeout(v030ProgressHideTimer);
    ui.root.hidden = false;
    ui.root.classList.remove('complete', 'has-errors');
    ui.root.classList.add('running');
    if (ui.fill) ui.fill.style.width = '0%';
    if (ui.percent) ui.percent.textContent = '0%';
    if (ui.track) ui.track.setAttribute('aria-valuenow', '0');
    if (ui.label) ui.label.textContent = `高速更新中（WEB/RSS ${V030_NORMAL_CONCURRENCY}・News ${V030_GOOGLE_CONCURRENCY}並列）`;
    if (ui.detail) ui.detail.textContent = '取得を開始しています…';
  }

  function v030UpdateProgress({ completed, total, success, failed, active, startedAt, phase = 'fetch' }) {
    const ui = v030ProgressElements();
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
      if (ui.label) ui.label.textContent = '記事は表示済み・重複と72時間キャッシュを整理中…';
      if (ui.detail) ui.detail.textContent = `取得完了 ${completed}/${total} ・ 成功 ${success} ・ 失敗 ${failed}`;
      return;
    }

    if (phase === 'complete') {
      ui.root.classList.remove('running');
      ui.root.classList.add('complete');
      if (ui.label) ui.label.textContent = failed ? '更新完了（一部エラーあり）' : '更新完了';
      const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
      if (ui.detail) {
        ui.detail.textContent = `成功 ${success} ・ 失敗 ${failed} ・ ${elapsed.toFixed(elapsed >= 10 ? 0 : 1)}秒`;
      }
      return;
    }

    if (ui.label) ui.label.textContent = `高速更新中（WEB/RSS ${V030_NORMAL_CONCURRENCY}・News ${V030_GOOGLE_CONCURRENCY}並列）`;
    const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const etaSec = completed > 0
      ? (elapsedSec / completed) * Math.max(0, total - completed)
      : NaN;
    const eta = v030FormatEta(etaSec);

    if (ui.detail) {
      ui.detail.textContent = `${completed}/${total} 完了 ・ 成功 ${success} ・ 失敗 ${failed}`
        + (active ? ` ・ 処理中 ${active}` : '')
        + (eta ? ` ・ ${eta}` : '');
    }
  }

  function v030FinishProgress(metrics) {
    v030UpdateProgress({ ...metrics, phase: 'complete' });
    const ui = v030ProgressElements();
    clearTimeout(v030ProgressHideTimer);
    v030ProgressHideTimer = setTimeout(() => {
      if (ui.root && !feedRefreshRunning) ui.root.hidden = true;
    }, 2800);
  }

  async function v030FetchFeedMeta(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), V030_FETCH_TIMEOUT_MS);
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
      return {
        text: await response.text(),
        requestedUrl: url,
        finalUrl: response.url || url,
        redirected: Boolean(response.redirected)
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`取得タイムアウト（${Math.round(V030_FETCH_TIMEOUT_MS / 1000)}秒）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function v030SuccessPatch(extra = {}) {
    return {
      feedFailCount: 0,
      feedHealthStatus: 'ok',
      feedLastError: '',
      feedLastFailureAt: '',
      registrationWarning: false,
      feedLastSuccessAt: new Date().toISOString(),
      ...extra
    };
  }

  function v030FailureResult(source, error) {
    console.warn('高速フィード取得エラー:', source?.name || source?.value || '', error);
    return {
      ok: false,
      source,
      articles: [],
      error,
      sourcePatch: {
        feedFailCount: Number(source?.feedFailCount || 0) + 1,
        feedHealthStatus: 'error',
        feedLastError: error?.message || String(error),
        feedLastFailureAt: new Date().toISOString()
      }
    };
  }

  async function v030FetchStandardSource(source) {
    try {
      const url = sourceUrl(source);
      const meta = await v030FetchFeedMeta(url);
      if (!looksLikeFeedDocument(meta.text)) {
        throw new Error('RSS / Atom / RDFとして認識できませんでした');
      }
      const parsed = parseFeed(meta.text, source, meta.finalUrl || url);
      const normalized = await normalizeItems(parsed, source);
      return {
        ok: true,
        source,
        articles: normalized,
        sourcePatch: v030SuccessPatch()
      };
    } catch (error) {
      return v030FailureResult(source, error);
    }
  }

  function v030GoogleMode(source) {
    if (typeof v026GoogleNewsModeForSource === 'function') {
      return v026GoogleNewsModeForSource(source);
    }
    return source?.newsLocale === 'dual' ? 'dual' : 'jp';
  }

  function v030GoogleRssUrl(source, locale) {
    if (typeof v026GoogleNewsRssUrl === 'function') {
      return v026GoogleNewsRssUrl(source.value, locale);
    }
    const q = encodeURIComponent(String(source?.value || '').trim());
    if (locale === 'us') return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
  }

  async function v030FetchGoogleEdition(source, locale) {
    const editionSource = { ...source, newsEdition: locale };
    const url = v030GoogleRssUrl(source, locale);
    const meta = await v030FetchFeedMeta(url);
    if (!looksLikeFeedDocument(meta.text)) {
      throw new Error(`${locale === 'us' ? '海外' : '国内'}版をRSSとして認識できませんでした`);
    }
    const parsed = parseFeed(meta.text, editionSource, meta.finalUrl || url);

    // Google News RSS often carries a generic/branding image. Article text is saved first;
    // proper thumbnails are looked up later in the background.
    for (const item of parsed) item.imageUrl = '';

    return normalizeItems(parsed, editionSource);
  }

  function v030MergeGoogleArticles(articleLists = []) {
    if (typeof v026MergeNormalizedArticles === 'function') {
      return v026MergeNormalizedArticles(articleLists);
    }
    const merged = new Map();
    for (const articles of articleLists) {
      for (const article of articles || []) {
        const existing = merged.get(article.id);
        if (!existing) merged.set(article.id, article);
        else merged.set(article.id, {
          ...existing,
          ...article,
          imageUrl: existing.imageUrl || article.imageUrl || '',
          description: existing.description?.length >= article.description?.length
            ? existing.description
            : article.description
        });
      }
    }
    return Array.from(merged.values());
  }

  async function v030FetchGoogleSource(source) {
    const mode = v030GoogleMode(source);
    const locales = mode === 'dual' ? ['jp', 'us'] : [mode === 'us' ? 'us' : 'jp'];
    const settled = await Promise.allSettled(locales.map(locale => v030FetchGoogleEdition(source, locale)));
    const successfulLists = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
    const failures = settled.filter(result => result.status === 'rejected');

    if (!successfulLists.length) {
      const messages = failures
        .map(result => result.reason?.message || String(result.reason || ''))
        .filter(Boolean);
      return v030FailureResult(source, new Error(messages.join(' / ') || 'Google Newsを取得できませんでした'));
    }

    return {
      ok: true,
      source,
      articles: v030MergeGoogleArticles(successfulLists),
      sourcePatch: v030SuccessPatch({
        feedLastError: failures.length ? '国内版 / 海外版のどちらか一方のみ取得しました' : '',
        newsLocale: mode
      })
    };
  }

  async function v030FetchSource(source) {
    return source?.type === 'google'
      ? v030FetchGoogleSource(source)
      : v030FetchStandardSource(source);
  }

  async function v030EnrichGoogleResult(result, jobToken) {
    if (!result?.ok || !result.articles?.length) return 0;
    if (jobToken !== v030ThumbnailJobToken) return 0;
    if (typeof enrichGoogleNewsItemsFromSearch !== 'function') return 0;

    const source = result.source;
    const mode = v030GoogleMode(source);
    const locales = mode === 'dual' ? ['jp', 'us'] : [mode === 'us' ? 'us' : 'jp'];
    const images = new Map();

    for (const locale of locales) {
      if (jobToken !== v030ThumbnailJobToken) return 0;
      const clones = result.articles.map(article => ({ ...article, imageUrl: '' }));
      try {
        await enrichGoogleNewsItemsFromSearch(clones, { ...source, newsEdition: locale });
      } catch (error) {
        console.debug('Google News 背景サムネイル取得をスキップ:', source?.name || source?.value || '', error);
      }
      for (const article of clones) {
        if (article.imageUrl && !images.has(article.id)) images.set(article.id, article.imageUrl);
      }
    }

    if (jobToken !== v030ThumbnailJobToken || !images.size) return 0;
    const checkedAt = new Date().toISOString();
    const updates = Array.from(images, ([id, imageUrl]) => ({
      id,
      patch: { imageUrl, imageCheckedAt: checkedAt }
    }));
    await dbPatchArticles(updates);
    return updates.length;
  }

  async function v030RunThumbnailJobs(results, jobToken) {
    if (!results.length || jobToken !== v030ThumbnailJobToken) return;
    let patched = 0;
    try {
      await v032RunPool(
        results,
        result => v030EnrichGoogleResult(result, jobToken),
        V030_THUMBNAIL_CONCURRENCY,
        async count => { patched += Number(count || 0); }
      );
      if (jobToken === v030ThumbnailJobToken && patched > 0 && !feedRefreshRunning) {
        await render();
      }
      console.debug(`Google News 背景サムネイル補完: ${patched}件`);
    } catch (error) {
      console.debug('Google News 背景サムネイル補完でエラー:', error);
    }
  }

  async function v030RefreshAll() {
    if (feedRefreshRunning) {
      showToast('フィード更新はすでに実行中です。');
      return;
    }

    const { sources } = await getState();
    if (!sources.length) {
      showToast('先にフィードを登録してください。');
      return;
    }

    // A new bulk refresh invalidates any old background thumbnail job immediately.
    const thumbnailJobToken = ++v030ThumbnailJobToken;
    const normalSources = sources.filter(source => source.type !== 'google');
    const googleSources = sources.filter(source => source.type === 'google');

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
      activeNormal: 0,
      activeGoogle: 0,
      startedAt
    };

    const allNewArticles = [];
    const sourcePatches = new Map();
    const googleResults = [];
    let backgroundResults = [];

    const settle = kind => async (result, _index, active) => {
      metrics.completed++;
      if (kind === 'google') metrics.activeGoogle = active;
      else metrics.activeNormal = active;
      metrics.active = metrics.activeGoogle + metrics.activeNormal;

      if (result?.ok) {
        metrics.success++;
        if (result.articles?.length) allNewArticles.push(...result.articles);
        if (kind === 'google') googleResults.push(result);
      } else {
        metrics.failed++;
      }

      if (result?.source?.id && result?.sourcePatch) {
        sourcePatches.set(result.source.id, result.sourcePatch);
      }
      v030UpdateProgress(metrics);
    };

    v030ShowProgress();
    elements.statusText.textContent = `${sources.length}フィードを高速取得中… WEB/RSS最大${V030_NORMAL_CONCURRENCY}・News最大${V030_GOOGLE_CONCURRENCY}並列`;

    try {
      await Promise.all([
        v032RunPool(normalSources, v030FetchSource, V030_NORMAL_CONCURRENCY, settle('normal')),
        v032RunPool(googleSources, v030FetchSource, V030_GOOGLE_CONCURRENCY, settle('google'))
      ]);

      if (sourcePatches.size) {
        const nextSources = sources.map(source => {
          const patch = sourcePatches.get(source.id);
          return patch ? { ...source, ...patch } : source;
        });
        await saveSources(nextSources);
      }

      v030UpdateProgress({ ...metrics, phase: 'save' });
      elements.statusText.textContent = `${allNewArticles.length.toLocaleString()}件の記事をまとめて保存しています…`;
      if (allNewArticles.length) await dbPutArticles(allNewArticles);

      // Make newly fetched text usable immediately. Cleanup/dedupe continues afterwards.
      await render();

      v030UpdateProgress({ ...metrics, phase: 'dedupe' });
      elements.statusText.textContent = '記事は表示済みです。重複記事と72時間キャッシュを整理しています…';
      const cleanup = await cleanupExpiredArticles();
      const dedupe = await deduplicateRecentArticles(true);

      const elapsedSec = (Date.now() - startedAt) / 1000;
      const dedupeText = dedupe.groups ? ` ・ 重複 ${dedupe.groups}話題` : '';
      const cleanupText = cleanup.deleted ? ` ・ 72時間超 ${cleanup.deleted}件削除` : '';
      const thumbnailText = googleResults.length ? ' ・ News画像は後追い補完' : '';

      elements.statusText.textContent = `最終更新 ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
        + ` ・ ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒`
        + ` ・ 成功 ${metrics.success} / 失敗 ${metrics.failed}`
        + dedupeText + cleanupText + thumbnailText;

      await render();
      if (elements.sourcesDialog?.open) await renderSources();
      v030FinishProgress(metrics);
      backgroundResults = googleResults.slice();

      if (metrics.failed) {
        showToast(`取得完了：${allNewArticles.length.toLocaleString()}件 / ${metrics.failed}件のフィードで読込エラー。 ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒で完了しました。`, true);
      } else {
        showToast(`取得完了：${allNewArticles.length.toLocaleString()}件を確認。 ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒で完了しました。${googleResults.length ? ' News画像は後から補完します。' : ''}`);
      }
    } finally {
      feedRefreshRunning = false;
      elements.refreshBtn.disabled = false;
      elements.refreshBtn.textContent = '↻ 更新';
      if (backgroundResults.length) {
        setTimeout(() => v030RunThumbnailJobs(backgroundResults, thumbnailJobToken), 0);
      }
    }
  }

  // Replace the global refresh entry point for auto-refresh and future callers.
  refreshAll = v030RefreshAll;

  // app-events.js bound the old function directly. A capture listener runs first and
  // prevents that legacy listener from firing, so a click triggers only v0.3.0 refresh.
  if (elements.refreshBtn && elements.refreshBtn.dataset.v030RefreshBound !== 'true') {
    elements.refreshBtn.dataset.v030RefreshBound = 'true';
    elements.refreshBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      v030RefreshAll();
    }, true);
  }

  // Replace/reset auto-refresh too, including a timer that may have been created during startup.
  setupAutoRefresh = async function() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    const { settings } = await getState();
    const minutes = Number(settings.autoRefreshMinutes || 0);
    if (minutes > 0) autoRefreshTimer = setInterval(v030RefreshAll, minutes * 60000);
  };
  setupAutoRefresh().catch(error => console.debug('高速自動更新の初期化に失敗:', error));
})();
