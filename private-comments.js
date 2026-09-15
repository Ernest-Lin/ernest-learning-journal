// Supabase's browser SDK is bundled locally; only authenticated requests can
// reach the private tables. Database RLS remains the source of authorization.
const container = document.querySelector('[data-private-comments]');
const callbackUrl = new URL(location.href);
const authCode = callbackUrl.searchParams.get('code');
const authFailed = callbackUrl.searchParams.has('error') || /(?:^|[&#])error=/.test(callbackUrl.hash);
const sensitiveParameters = ['code', 'state', 'error', 'error_code', 'error_description', 'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'token_type', 'expires_in', 'expires_at', 'giscus'];
let changedUrl = false;
for (const key of sensitiveParameters) {
  if (callbackUrl.searchParams.has(key)) { callbackUrl.searchParams.delete(key); changedUrl = true; }
}
if (/(?:^|[&#])(?:access_token|refresh_token|provider_token|provider_refresh_token|error|giscus)=/.test(callbackUrl.hash)) {
  callbackUrl.hash = ''; changedUrl = true;
}
if (changedUrl) history.replaceState(null, '', callbackUrl.pathname + callbackUrl.search + callbackUrl.hash);
// Remove the former public comment widget's saved session on this origin.
try { localStorage.removeItem('giscus-session'); } catch { /* Storage can be blocked. */ }

if (container?.dataset.enabled === 'true') {
  initialize().catch(() => {
    container.querySelector('[data-private-content]').replaceChildren();
    container.querySelector('[data-private-auth]').replaceChildren();
    const notice = container.querySelector('[data-private-notice]');
    notice.textContent = '私密留言暂时无法连接，请稍后刷新重试。';
    notice.dataset.tone = 'error';
  });
}

async function initialize() {
  const { createClient } = await import('./vendor/supabase.js');
  const { url, publishableKey, pagePath, returnPath } = container.dataset;
  const authArea = container.querySelector('[data-private-auth]');
  const content = container.querySelector('[data-private-content]');
  const notice = container.querySelector('[data-private-notice]');
  const client = createClient(url, publishableKey, {
    auth: {
      flowType: 'pkce', detectSessionInUrl: false, persistSession: true,
      autoRefreshToken: true, storageKey: 'ernest-private-comments-auth',
    },
    global: { headers: { 'X-Client-Info': 'ernest-private-comments/1' } },
  });
  let session = null;
  let identity = null;
  let generation = 0;
  let authEventSequence = 0;
  let listRequest = 0;
  let signingOut = false;
  let callbackProblem = authFailed;
  let hasInitializedSession = false;
  let scope = 'page';
  let pageNumber = 0;
  let listArea;
  let requests = new AbortController();
  const PAGE_SIZE = 20;
  const MESSAGE_PAGE_SIZE = 50;
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function button(text, onClick, primary = false) {
    const node = element('button', primary ? 'button button-primary' : 'private-button', text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }
  function announce(text, tone = '') {
    notice.textContent = text;
    notice.dataset.tone = tone;
  }
  function current(token) { return generation === token && Boolean(session) && !signingOut; }
  function authenticated(query) {
    if (!session?.access_token) throw Error('A verified session is required');
    // Pin the request to this account even if Supabase's shared session changes
    // while fetch is waiting for the auth lock. Account changes abort requests.
    return query.setHeader('Authorization', `Bearer ${session.access_token}`).abortSignal(requests.signal);
  }
  function timestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
  }
  function clearPrivateState() {
    generation += 1;
    listRequest += 1;
    requests.abort();
    requests = new AbortController();
    identity = null;
    listArea = null;
    content.replaceChildren();
    authArea.replaceChildren();
  }
  function safePageLink(path) {
    if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\\?#\u0000-\u0020]/.test(path)) return null;
    if (!returnPath.endsWith(pagePath)) return null;
    const base = returnPath.slice(0, -pagePath.length);
    const result = new URL(base + path, location.origin);
    return result.origin === location.origin && result.pathname.startsWith(base + '/') ? result : null;
  }
  function pageLabel(path) { return path === '/about/' ? '关于 / 留言' : path; }
  function form({ label, submitText, onSubmit }) {
    const formNode = element('form', 'private-form');
    const labelNode = element('label', 'private-label', label);
    const textarea = element('textarea', 'private-textarea');
    textarea.rows = 4; textarea.maxLength = 10000; textarea.required = true;
    textarea.autocomplete = 'off'; textarea.placeholder = '写下想说的话…';
    labelNode.append(textarea);
    const footer = element('div', 'private-form-footer');
    const hint = element('p', 'private-form-hint', '仅你和博主可见 · 最多 10,000 字');
    const submit = button(submitText, null, true); submit.type = 'submit';
    const feedback = element('p', 'private-form-feedback');
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    footer.append(hint, submit);
    formNode.append(labelNode, footer, feedback);
    formNode.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled || !identity || !session) return;
      const body = textarea.value.trim();
      if (!body) { feedback.textContent = '请先写下留言内容。'; textarea.focus(); return; }
      const token = generation;
      submit.disabled = true; textarea.disabled = true;
      feedback.textContent = '正在发送…';
      try {
        await onSubmit(body, token);
        if (!current(token)) return;
        textarea.value = '';
        feedback.textContent = '已发送，只有你和博主能看到。';
      } catch (error) {
        if (!current(token)) return;
        feedback.textContent = error?.code === '42501' ? '当前账号不能发送这条留言，请重新登录后重试。' : '发送未完成，请检查连接后重试。';
      } finally {
        if (current(token)) { submit.disabled = false; textarea.disabled = false; }
      }
    });
    return formNode;
  }
  async function login() {
    const loginButton = authArea.querySelector('button');
    if (loginButton) loginButton.disabled = true;
    announce('正在前往 GitHub 登录…');
    try {
      // Construct the return URL from the generated page path, never a query
      // string or a user-supplied redirect parameter.
      const redirect = safePageLink(pagePath);
      if (!redirect) throw Error('Invalid return path');
      const { error } = await client.auth.signInWithOAuth({
        provider: 'github', options: { redirectTo: redirect.href },
      });
      if (error) throw error;
    } catch {
      announce('无法开始登录，请稍后重试。', 'error');
      if (loginButton) loginButton.disabled = false;
    }
  }
  function showLoggedOut(message = '登录后，可查看自己的旧留言并继续交流。') {
    authArea.replaceChildren(button('使用 GitHub 登录', login, true));
    announce(message);
  }
  async function logout() {
    // Clear content and invalidate every pending request before asking the
    // network to sign out. A delayed response must never restore old messages.
    signingOut = true;
    session = null;
    clearPrivateState();
    announce('正在退出登录…');
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      signingOut = false;
      showLoggedOut('已退出登录，留言已从当前页面清除。');
    } catch {
      // Keep private content hidden on a failed logout. Retrying is explicit;
      // no background session event is allowed to repopulate this page.
      authArea.replaceChildren(button('重试退出登录', logout));
      announce('页面中的留言已清除；退出登录尚未完成，请重试。', 'error');
    }
  }
  function showAccount() {
    const account = element('div', 'private-account');
    account.append(element('span', 'private-account-name', `已登录 @${identity.login}`));
    if (identity.is_owner) account.append(element('span', 'private-badge', '博主'));
    account.append(button('退出登录', logout));
    authArea.replaceChildren(account);
  }
  function renderMessage(message, thread) {
    const article = element('article', 'private-message');
    const header = element('div', 'private-message-meta');
    header.append(element('strong', '', `@${message.author_login || '原留言者'}`));
    if (message.author_github_id !== thread.visitor_github_id) header.append(element('span', 'private-badge', '博主'));
    if (message.source_comment_id) header.append(element('span', 'private-imported', '原有留言'));
    const time = element('time', '', timestamp(message.created_at));
    time.dateTime = message.created_at;
    header.append(time);
    // Old and new bodies are always rendered as text, including Markdown/HTML.
    article.append(header, element('p', 'private-message-body', message.body));
    return article;
  }
  function renderThread(thread, token, open = false) {
    const details = element('details', 'private-thread');
    const summary = element('summary', 'private-thread-summary');
    const heading = element('div', 'private-thread-heading');
    heading.append(element('strong', '', identity.is_owner ? `与 @${thread.visitor_login || '原留言者'} 的对话` : '我和博主的对话'));
    heading.append(element('span', 'private-thread-date', `最近更新 ${timestamp(thread.updated_at)}`));
    summary.append(heading, element('span', 'private-thread-chevron', '⌄'));
    const inner = element('div', 'private-thread-content');
    const pageLine = element('p', 'private-thread-page');
    const link = safePageLink(thread.page_path);
    if (link) { const anchor = element('a', '', pageLabel(thread.page_path)); anchor.href = link.href + '#comments'; pageLine.append('留言页面：', anchor); }
    else pageLine.textContent = `留言页面：${thread.page_path}`;
    const messageArea = element('div', 'private-messages');
    const messageNotice = element('p', 'private-thread-notice'); messageNotice.setAttribute('role', 'status');
    const earlier = button('查看更早留言', () => loadMessages(true)); earlier.hidden = true;
    const replyForm = form({ label: identity.is_owner ? '回复这位朋友' : '继续这段对话', submitText: '发送回复', onSubmit: async (body, requestToken) => {
      const { error } = await authenticated(client.rpc('comment_reply', { p_thread_id: thread.id, p_body: body }));
      if (error) throw error;
      if (current(requestToken)) await loadMessages(false);
    } });
    inner.append(pageLine, earlier, messageArea, messageNotice, replyForm);
    details.append(summary, inner);
    let loaded = false;
    let messageOffset = 0;
    let messageRequest = 0;
    let loading = false;
    async function loadMessages(older = false) {
      if (!current(token) || !details.isConnected) return;
      if (older && loading) return;
      const request = ++messageRequest;
      loading = true;
      const offset = older ? messageOffset : 0;
      earlier.disabled = true;
      messageNotice.textContent = '正在读取对话…';
      try {
        const { data, error } = await authenticated(client.from('comment_messages')
          .select('id,thread_id,author_github_id,author_login,body,created_at,source_comment_id,parent_id')
          .eq('thread_id', thread.id).order('created_at', { ascending: false }).order('id', { ascending: false })
          .range(offset, offset + MESSAGE_PAGE_SIZE - 1));
        if (!current(token) || request !== messageRequest || !details.isConnected) return;
        if (error) throw error;
        const messages = data || [];
        const fragment = document.createDocumentFragment();
        [...messages].reverse().forEach(message => fragment.append(renderMessage(message, thread)));
        if (older) messageArea.prepend(fragment); else messageArea.replaceChildren(fragment);
        messageOffset = offset + messages.length;
        earlier.hidden = messages.length < MESSAGE_PAGE_SIZE;
        messageNotice.textContent = messages.length || older ? '' : '这段对话还没有内容。';
        loaded = true;
      } catch {
        if (current(token) && request === messageRequest && details.isConnected) {
          messageNotice.replaceChildren(element('span', '', '暂时无法读取对话。 '), button('重试', () => loadMessages(older)));
        }
      } finally {
        if (current(token) && request === messageRequest) { loading = false; earlier.disabled = false; }
      }
    }
    details.addEventListener('toggle', () => { if (details.open && !loaded && !loading) loadMessages(); });
    details.open = open;
    return details;
  }
  async function loadThreads() {
    if (!identity || !session || !listArea) return;
    const token = generation, request = ++listRequest, target = listArea;
    target.replaceChildren(element('p', 'private-empty', '正在读取留言…'));
    target.setAttribute('aria-busy', 'true');
    try {
      let query = client.from('comment_threads').select('id,page_path,visitor_github_id,visitor_login,created_at,updated_at', { count: 'exact' })
        .order('updated_at', { ascending: false }).order('id', { ascending: false });
      if (!(identity.is_owner && scope === 'all')) query = query.eq('page_path', pagePath);
      const { data, count, error } = await authenticated(query.range(pageNumber * PAGE_SIZE, (pageNumber + 1) * PAGE_SIZE - 1));
      if (!current(token) || request !== listRequest || !target.isConnected) return;
      if (error) throw error;
      const threads = data || [];
      target.replaceChildren();
      if (!threads.length) target.append(element('p', 'private-empty', identity.is_owner ? '这里还没有收到留言。' : '你在这一页还没有留言。写下第一句话吧。'));
      threads.forEach((thread, index) => target.append(renderThread(thread, token, index === 0)));
      if (pageNumber > 0 || threads.length === PAGE_SIZE) {
        const navigation = element('nav', 'private-pagination'); navigation.setAttribute('aria-label', '私密留言分页');
        const previous = button('上一页', () => { pageNumber -= 1; loadThreads(); }); previous.disabled = pageNumber === 0;
        const next = button('下一页', () => { pageNumber += 1; loadThreads(); }); next.disabled = Number.isFinite(count) ? (pageNumber + 1) * PAGE_SIZE >= count : threads.length < PAGE_SIZE;
        navigation.append(previous, element('span', '', `第 ${pageNumber + 1} 页`), next); target.append(navigation);
      }
    } catch {
      if (current(token) && request === listRequest && target.isConnected) target.replaceChildren(element('p', 'private-empty', '留言暂时无法读取，请检查连接后重试。'), button('重新读取', loadThreads));
    } finally {
      if (current(token) && request === listRequest) target.removeAttribute('aria-busy');
    }
  }
  function showConversations() {
    content.replaceChildren();
    if (!identity.is_owner) content.append(form({ label: '给博主的新留言', submitText: '发送私密留言', onSubmit: async (body, token) => {
      const { error } = await authenticated(client.rpc('comment_create_thread', { p_page_path: pagePath, p_body: body }));
      if (error) throw error;
      if (current(token)) { pageNumber = 0; await loadThreads(); }
    } }));
    const toolbar = element('div', 'private-toolbar');
    toolbar.append(element('h3', '', identity.is_owner ? '收到的私密留言' : '我的私密对话'));
    if (identity.is_owner) {
      const label = element('label', 'private-scope-label', '查看范围');
      const select = element('select', 'private-scope');
      for (const [value, text] of [['page', '当前页面'], ['all', '全部页面']]) { const option = element('option', '', text); option.value = value; select.append(option); }
      scope = pagePath === '/about/' ? 'all' : 'page'; select.value = scope;
      select.addEventListener('change', () => { scope = select.value; pageNumber = 0; loadThreads(); });
      label.append(select); toolbar.append(label);
    }
    toolbar.append(button('刷新', loadThreads));
    listArea = element('div', 'private-thread-list');
    content.append(toolbar, listArea);
    loadThreads();
  }
  async function acceptSession(nextSession) {
    if (signingOut) return;
    if (hasInitializedSession && session?.user?.id === nextSession?.user?.id && (identity || !nextSession)) { session = nextSession; return; }
    hasInitializedSession = true;
    clearPrivateState();
    session = nextSession;
    if (!session) { showLoggedOut(callbackProblem ? '登录未完成，请使用 GitHub 重新登录。' : undefined); return; }
    const token = generation;
    announce('正在验证 GitHub 账号…');
    try {
      const { data, error } = await authenticated(client.rpc('comment_identity'));
      if (!current(token)) return;
      if (error) throw error;
      const verified = Array.isArray(data) ? data[0] : data;
      if (!verified?.github_id || !verified?.login) {
        authArea.replaceChildren(button('退出并使用 GitHub 登录', logout));
        announce('此账号未关联 GitHub，请使用原 GitHub 账号登录。', 'error');
        return;
      }
      identity = verified;
      pageNumber = 0;
      showAccount();
      announce(identity.is_owner ? '你可以查看所有人的留言，并分别私密回复。' : '这里只会显示你的留言，以及博主给你的回复。');
      showConversations();
    } catch {
      if (!current(token)) return;
      authArea.replaceChildren(button('重新验证', () => acceptSession(session)), button('退出登录', logout));
      announce('账号暂时无法验证，留言仍保持关闭。请重试。', 'error');
    }
  }
  // Invalidate immediately on an account change; queue network work after the
  // auth callback to avoid Supabase's session lock reentrancy.
  client.auth.onAuthStateChange((_event, nextSession) => {
    const eventSequence = ++authEventSequence;
    if (signingOut) return;
    if (!nextSession || session?.user?.id !== nextSession?.user?.id) { clearPrivateState(); session = null; hasInitializedSession = false; }
    const token = generation;
    setTimeout(() => { if (eventSequence === authEventSequence && generation === token && !signingOut) acceptSession(nextSession); }, 0);
  });
  if (authCode) {
    const { error } = await client.auth.exchangeCodeForSession(authCode);
    if (error) { callbackProblem = true; announce('登录已过期或未完成，请重新登录。', 'error'); }
  }
  const sessionReadGeneration = generation;
  const sessionReadEvent = authEventSequence;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (generation === sessionReadGeneration && authEventSequence === sessionReadEvent) await acceptSession(data.session);
  // Back/forward cache can contain a rendered private conversation. Hide it
  // before caching and verify the account afresh when that page is restored.
  window.addEventListener('pagehide', () => { clearPrivateState(); session = null; hasInitializedSession = false; });
  window.addEventListener('pageshow', async event => {
    if (!event.persisted || signingOut) return;
    const token = generation;
    const eventSequence = authEventSequence;
    const { data, error } = await client.auth.getSession();
    if (!error && generation === token && authEventSequence === eventSequence) await acceptSession(data.session);
  });
}
