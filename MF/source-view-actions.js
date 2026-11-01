// v0.2.9: individual feed actions
// --------------------------------
// Show folder selection / refresh / delete controls only while a single feed is open.

(() => {
  const ROOT_ID = 'sourceViewActions';
  const CATEGORY_SELECT_ID = 'sourceViewCategorySelect';
  const REFRESH_BUTTON_ID = 'refreshCurrentSourceBtn';
  const DELETE_BUTTON_ID = 'deleteCurrentSourceBtn';
  const NAME_ID = 'sourceViewActionName';
  const META_ID = 'sourceViewActionMeta';

  function v029EnsureSourceViewActionsUi() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    const toolbar = document.querySelector('.sticky-main-header .toolbar');
    if (!toolbar) return null;

    root = document.createElement('section');
    root.id = ROOT_ID;
    root.className = 'source-view-actions';
    root.hidden = true;
    root.innerHTML = `
      <div class="source-view-actions-info">
        <span class="source-view-actions-kicker">フィード操作</span>
        <strong id="${NAME_ID}"></strong>
        <small id="${META_ID}"></small>
      </div>
      <div class="source-view-actions-controls">
        <label class="source-view-folder-select">
          <span>フォルダ</span>
          <select id="${CATEGORY_SELECT_ID}" aria-label="このフィードのフォルダ"></select>
        </label>
        <button id="${REFRESH_BUTTON_ID}" type="button" class="secondary-btn">↻ このフィードを更新</button>
        <button id="${DELETE_BUTTON_ID}" type="button" class="danger-btn">削除</button>
      </div>`;

    toolbar.insertAdjacentElement('afterend', root);

    root.querySelector(`#${CATEGORY_SELECT_ID}`)?.addEventListener('change', v029MoveCurrentSource);
    root.querySelector(`#${REFRESH_BUTTON_ID}`)?.addEventListener('click', v029RefreshCurrentSource);
    root.querySelector(`#${DELETE_BUTTON_ID}`)?.addEventListener('click', v029DeleteCurrentSource);
    return root;
  }

  function v029CategoryName(categories, categoryId) {
    if (!categoryId) return '未分類';
    return categories.find(category => category.id === categoryId)?.name || '未分類';
  }

  async function v029RenderSourceViewActions() {
    const root = v029EnsureSourceViewActionsUi();
    if (!root) return;

    if (!currentSourceId) {
      root.hidden = true;
      return;
    }

    const { sources, categories } = await getState();
    const source = sources.find(item => item.id === currentSourceId);
    if (!source) {
      root.hidden = true;
      return;
    }

    const select = root.querySelector(`#${CATEGORY_SELECT_ID}`);
    const refreshButton = root.querySelector(`#${REFRESH_BUTTON_ID}`);
    const deleteButton = root.querySelector(`#${DELETE_BUTTON_ID}`);
    const name = root.querySelector(`#${NAME_ID}`);
    const meta = root.querySelector(`#${META_ID}`);

    name.textContent = source.name || 'フィード';
    meta.textContent = `${typeLabel(source.type)} ・ ${v029CategoryName(categories, categoryKey(source))}`;

    const options = [new Option('未分類', '')];
    for (const category of orderedCategories(categories)) {
      options.push(new Option(category.name, category.id));
    }
    select.replaceChildren(...options);
    select.value = categoryKey(source);

    const busy = Boolean(feedRefreshRunning);
    select.disabled = busy;
    refreshButton.disabled = busy;
    deleteButton.disabled = busy;
    root.hidden = false;
  }

  async function v029MoveCurrentSource(event) {
    const sourceId = currentSourceId;
    if (!sourceId || feedRefreshRunning) return;

    const select = event.currentTarget;
    const nextCategoryId = select.value || '';
    const { sources, categories } = await getState();
    const source = sources.find(item => item.id === sourceId);
    if (!source) return;
    if (categoryKey(source) === nextCategoryId) return;

    select.disabled = true;
    try {
      await moveSourceToCategory(sourceId, nextCategoryId);
      showToast(`「${source.name}」を「${v029CategoryName(categories, nextCategoryId)}」へ移動しました。`);
    } catch (error) {
      console.error(error);
      showToast(`フォルダを変更できませんでした：${error.message || error}`, true);
      await v029RenderSourceViewActions();
    }
  }

  async function v029DeleteCurrentSource() {
    const sourceId = currentSourceId;
    if (!sourceId || feedRefreshRunning) return;

    const { sources } = await getState();
    const source = sources.find(item => item.id === sourceId);
    if (!source) return;

    if (!confirm(`フィード「${source.name}」を削除しますか？\n登録を解除し、今後の更新対象から外します。`)) return;

    await saveSources(sources.filter(item => item.id !== sourceId));
    currentSourceId = '';
    currentCategoryId = null;
    currentFavoriteCategoryId = null;
    currentFilter = 'all';
    renderedLimit = PAGE_SIZE;

    await renderSources();
    await render();
    showToast(`「${source.name}」を削除しました。`);
  }

  function v029SetIndividualRefreshBusy(sourceName, busy) {
    const root = document.getElementById(ROOT_ID);
    const refreshButton = document.getElementById(REFRESH_BUTTON_ID);
    const deleteButton = document.getElementById(DELETE_BUTTON_ID);
    const select = document.getElementById(CATEGORY_SELECT_ID);

    if (elements.refreshBtn) elements.refreshBtn.disabled = busy;
    if (refreshButton) {
      refreshButton.disabled = busy;
      refreshButton.textContent = busy ? '更新中…' : '↻ このフィードを更新';
    }
    if (deleteButton) deleteButton.disabled = busy;
    if (select) select.disabled = busy;
    if (root) root.classList.toggle('is-refreshing', busy);

    if (busy && sourceName) {
      elements.statusText.textContent = `「${sourceName}」だけを更新しています…`;
    }
  }

  async function v029RefreshCurrentSource() {
    const sourceId = currentSourceId;
    if (!sourceId) return;
    if (feedRefreshRunning) {
      showToast('フィード更新はすでに実行中です。');
      return;
    }

    const { sources } = await getState();
    const source = sources.find(item => item.id === sourceId);
    if (!source) {
      showToast('更新するフィードが見つかりません。', true);
      return;
    }

    feedRefreshRunning = true;
    v029SetIndividualRefreshBusy(source.name, true);

    const startedAt = Date.now();
    const metrics = {
      completed: 0,
      total: 1,
      success: 0,
      failed: 0,
      active: 1,
      startedAt
    };

    try {
      if (typeof v032ShowProgress === 'function') v032ShowProgress();
      if (typeof v032UpdateProgress === 'function') v032UpdateProgress(metrics);

      const result = await v032FetchOneSource(source);
      metrics.completed = 1;
      metrics.active = 0;
      metrics.success = result?.ok ? 1 : 0;
      metrics.failed = result?.ok ? 0 : 1;

      if (result?.sourcePatch) {
        const latest = await getState();
        await saveSources(latest.sources.map(item =>
          item.id === sourceId ? { ...item, ...result.sourcePatch } : item
        ));
      }

      if (result?.ok) {
        if (typeof v032UpdateProgress === 'function') {
          v032UpdateProgress({ ...metrics, phase: 'save' });
        }
        if (result.articles?.length) await dbPutArticles(result.articles);

        if (typeof v032UpdateProgress === 'function') {
          v032UpdateProgress({ ...metrics, phase: 'dedupe' });
        }
        const cleanup = await cleanupExpiredArticles();
        const dedupe = await deduplicateRecentArticles(true);
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const dedupeText = dedupe.groups ? ` ・ 重複 ${dedupe.groups}話題` : '';
        const cleanupText = cleanup.deleted ? ` ・ 72時間超 ${cleanup.deleted}件削除` : '';

        elements.statusText.textContent =
          `「${source.name}」更新 ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
          + ` ・ ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒`
          + ` ・ ${Number(result.articles?.length || 0).toLocaleString()}件確認`
          + dedupeText + cleanupText;

        await render();
        if (elements.sourcesDialog?.open) await renderSources();
        if (typeof v032FinishProgress === 'function') v032FinishProgress(metrics);
        showToast(`「${source.name}」を更新しました：${Number(result.articles?.length || 0).toLocaleString()}件を確認。`);
      } else {
        const message = result?.error?.message || 'フィードを読み込めませんでした';
        elements.statusText.textContent = `「${source.name}」の更新に失敗しました：${message}`;
        await render();
        if (elements.sourcesDialog?.open) await renderSources();
        if (typeof v032FinishProgress === 'function') v032FinishProgress(metrics);
        showToast(`「${source.name}」を更新できませんでした：${message}`, true);
      }
    } catch (error) {
      console.error(error);
      metrics.completed = 1;
      metrics.active = 0;
      metrics.failed = 1;
      elements.statusText.textContent = `「${source.name}」の更新に失敗しました。`;
      if (typeof v032FinishProgress === 'function') v032FinishProgress(metrics);
      showToast(`個別更新に失敗しました：${error.message || error}`, true);
    } finally {
      feedRefreshRunning = false;
      v029SetIndividualRefreshBusy('', false);
      await v029RenderSourceViewActions();
    }
  }

  const v029BaseRender = render;
  render = async function(...args) {
    const result = await v029BaseRender.apply(this, args);
    await v029RenderSourceViewActions();
    return result;
  };

  v029RenderSourceViewActions();
})();
