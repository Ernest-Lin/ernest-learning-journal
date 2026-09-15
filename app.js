(() => {
  'use strict';
  const PAGE_SIZE = 25;
  const menuButton = document.querySelector('.menu-toggle');
  const nav = document.getElementById('site-nav');
  if (menuButton && nav) {
    const closeMenu = () => { menuButton.setAttribute('aria-expanded', 'false'); nav.classList.remove('is-open'); };
    menuButton.addEventListener('click', () => {
      const open = menuButton.getAttribute('aria-expanded') !== 'true';
      menuButton.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
    });
    nav.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') { closeMenu(); menuButton.focus(); } });
    document.addEventListener('click', event => { if (!event.target.closest('.site-header')) closeMenu(); });
  }

  const formatSize = value => {
    const size = Number(value);
    if (!Number.isFinite(size) || size < 0) return '大小待补充';
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${Math.round(size / 1024)} KB`;
    if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
    return `${(size / 1024 ** 3).toFixed(1)} GB`;
  };
  const safeUrl = value => {
    const url = String(value || '').trim();
    if (!url || /[\u0000-\u001f\u007f\\]/.test(url)) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')) return '';
    return url;
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const downloadIcon = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 18 18'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('fill', 'none'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries({ d: 'M8 3v10m-4-4 4 4 4-4M3 16h10', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(key, value);
    svg.append(path); return svg;
  };
  const resourceRow = resource => {
    const row = element('article', 'resource-row');
    const extension = String(resource.extension || '').replace(/^\./, '').toUpperCase() || 'FILE';
    const filename = String(resource.filename || resource.title || 'download');
    const title = resource.title || filename;
    const icon = element('div', 'file-icon'); icon.setAttribute('aria-hidden', 'true'); icon.append(element('span', '', extension.slice(0, 6)));
    const info = element('div', 'resource-info'); info.append(element('h3', '', title));
    const meta = element('p', 'resource-meta');
    [resource.course || '未分类', resource.semester, extension, formatSize(resource.sizeBytes)].filter(Boolean).forEach(value => meta.append(element('span', '', value)));
    info.append(meta);
    const href = safeUrl(resource.downloadUrl);
    let action;
    if (href) {
      action = element('a', 'download-link'); action.href = href; action.download = filename; action.setAttribute('aria-label', `下载 ${title}`);
      action.append(element('span', '', '下载'), downloadIcon());
    } else {
      info.append(element('p', 'file-status', '准备上传，暂不可下载'));
      action = element('span', 'download-link is-disabled', '待上传'); action.setAttribute('aria-disabled', 'true');
    }
    row.append(icon, info, action); return row;
  };

  async function initLibrary() {
    const toolbar = document.querySelector('[data-library]');
    if (!toolbar) return;
    const input = toolbar.querySelector('[data-resource-search]');
    const courseSelect = toolbar.querySelector('[data-course-filter]');
    const sortSelect = toolbar.querySelector('[data-sort-filter]');
    const kindButtons = [...toolbar.querySelectorAll('[data-kind]')];
    const list = document.querySelector('[data-resource-list]');
    const results = document.querySelector('[data-results-count]');
    const note = document.querySelector('[data-filter-note]');
    const pagination = document.querySelector('[data-pagination]');
    const error = document.querySelector('[data-library-error]');
    const kinds = { document: '课程文档', archive: '压缩包', project: '工程文件', all: '文件' };
    const initialParams = new URLSearchParams(location.search);
    const state = { query: initialParams.get('q') || '', course: initialParams.get('course') || '', kind: initialParams.get('kind') || 'document', sort: initialParams.get('sort') || 'name', page: Math.max(1, Number(initialParams.get('page')) || 1) };
    if (!Object.hasOwn(kinds, state.kind)) state.kind = 'document';
    if (!['name', 'size-desc', 'size-asc', 'course'].includes(state.sort)) state.sort = 'name';
    let resources;
    try {
      const base = document.body.dataset.basePath || '';
      const response = await fetch(`${base}/resources.json`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Resource index ${response.status}`);
      const payload = await response.json();
      resources = Array.isArray(payload) ? payload : payload.resources;
      if (!Array.isArray(resources)) throw new Error('Invalid resource index');
      resources = resources.filter(item => item && typeof item === 'object');
    } catch {
      error.textContent = '资料索引暂时无法读取，搜索和分页尚不可用。已显示的文件仍可访问，请稍后刷新重试。';
      error.hidden = false;
      toolbar.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
      pagination.querySelectorAll('button').forEach(control => { control.disabled = true; });
      return;
    }
    const indexed = resources.map(resource => ({ resource, search: [resource.title, resource.filename, resource.course, resource.semester, resource.extension].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase() }));
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    const name = resource => String(resource.title || resource.filename || '');
    const updateUrl = () => {
      const params = new URLSearchParams();
      if (state.query) params.set('q', state.query);
      if (state.course) params.set('course', state.course);
      if (state.kind !== 'document') params.set('kind', state.kind);
      if (state.sort !== 'name') params.set('sort', state.sort);
      if (state.page > 1) params.set('page', state.page);
      const query = params.toString();
      history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    };
    const pageButton = (label, page, { current = false, disabled = false, ariaLabel = '' } = {}) => {
      const button = element('button', '', label); button.type = 'button'; button.dataset.page = String(page); button.disabled = disabled;
      if (current) button.setAttribute('aria-current', 'page');
      if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
      return button;
    };
    const render = ({ syncUrl = true } = {}) => {
      const terms = state.query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      let filtered = indexed.filter(({ resource, search }) => (state.kind === 'all' || resource.kind === state.kind) && (!state.course || String(resource.course || '未分类') === state.course) && terms.every(term => search.includes(term))).map(item => item.resource);
      filtered.sort((a, b) => {
        if (state.sort === 'size-desc') return (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0) || collator.compare(name(a), name(b));
        if (state.sort === 'size-asc') return (Number(a.sizeBytes) || 0) - (Number(b.sizeBytes) || 0) || collator.compare(name(a), name(b));
        if (state.sort === 'course') return collator.compare(String(a.course || '未分类'), String(b.course || '未分类')) || collator.compare(name(a), name(b));
        return collator.compare(name(a), name(b));
      });
      const total = filtered.length, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      state.page = Math.min(pages, Math.max(1, Math.floor(state.page)));
      const start = (state.page - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);
      kindButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === state.kind)));
      const fragment = document.createDocumentFragment();
      if (total) filtered.slice(start, end).forEach(resource => fragment.append(resourceRow(resource)));
      else {
        const empty = element('div', 'empty-state');
        empty.append(element('h3', '', '没有找到符合条件的资料'), element('p', '', '试试更短的关键词，或清除课程与类型筛选。'));
        const reset = element('button', 'button button-primary', '清除筛选'); reset.type = 'button'; reset.style.marginTop = '18px';
        reset.addEventListener('click', () => { state.query = ''; state.course = ''; state.kind = 'all'; state.page = 1; input.value = ''; courseSelect.value = ''; render(); input.focus(); });
        empty.append(reset); fragment.append(empty);
      }
      list.replaceChildren(fragment);
      results.textContent = `共 ${total.toLocaleString('zh-CN')} ${state.kind === 'document' ? '份' : '个'}${kinds[state.kind]}${total ? `，显示 ${start + 1}–${end}` : ''}`;
      note.textContent = state.kind === 'document' ? '默认展示文档，工程文件可按需查看。' : state.kind === 'project' ? '工程文件请下载后使用对应课程软件打开。' : state.kind === 'archive' ? '压缩包请下载后解压查看。' : '包含文档、压缩包与课程工程文件。';
      pagination.replaceChildren();
      if (pages > 1) {
        pagination.append(pageButton('← 上一页', state.page - 1, { disabled: state.page === 1 }));
        const visible = [...new Set([1, state.page - 1, state.page, state.page + 1, pages].filter(p => p >= 1 && p <= pages))].sort((a, b) => a - b);
        visible.forEach((p, index) => {
          if (index && p - visible[index - 1] > 1) pagination.append(element('span', '', '…'));
          pagination.append(pageButton(p, p, { current: p === state.page, ariaLabel: `第 ${p} 页` }));
        });
        pagination.append(pageButton('下一页 →', state.page + 1, { disabled: state.page === pages }));
      }
      if (syncUrl) updateUrl();
    };
    if (![...courseSelect.options].some(option => option.value === state.course)) {
      if (state.course) courseSelect.append(new Option(state.course, state.course));
    }
    input.value = state.query; courseSelect.value = state.course; sortSelect.value = state.sort;
    input.addEventListener('input', () => { state.query = input.value; state.page = 1; render(); });
    courseSelect.addEventListener('change', () => { state.course = courseSelect.value; state.page = 1; render(); });
    sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; state.page = 1; render(); });
    kindButtons.forEach(button => button.addEventListener('click', () => { state.kind = button.dataset.kind; state.page = 1; render(); }));
    pagination.addEventListener('click', event => {
      const button = event.target.closest('button[data-page]');
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.page); render();
      list.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      results.tabIndex = -1; results.focus({ preventScroll: true });
    });
    render();
  }
  initLibrary();

})();
