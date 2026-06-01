/* Excel AI — Client-side tracker
 *
 * Singleton. Exposes:
 *   window.ExcelAI.track(name, props)   — manual event
 *   window.ExcelAI.identify(userId)     — attach user after login
 *   window.ExcelAI.reset()              — clear session (logout)
 *   window.ExcelAI.flush()              — force send
 *
 * Auto-tracks:
 *   - page_view (on load)
 *   - scroll_depth (25/50/75/100)
 *   - time_on_page (on unload via sendBeacon)
 *   - cta_click (any element with [data-track])
 *   - js_error (uncaught exceptions)
 *   - web_vitals (LCP, FID, CLS — best effort)
 *
 * Batches events, flushes every 5s + on visibility change + on unload.
 * Graceful degradation: if /api/events fails, retries on next batch.
 */
(function(){
  if(window.ExcelAI && window.ExcelAI.__ready) return;
  const T = {
    queue: [],
    sessionId: null,
    userId: null,
    flushTimer: null,
    startedAt: Date.now(),
    scrollMarks: new Set(),
    pageTracked: false,
    __ready: true
  };
  window.ExcelAI = T;

  // ── Session ID (persisted for the tab) ──
  try {
    let sid = sessionStorage.getItem('eai_sid');
    if(!sid){
      sid = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('eai_sid', sid);
    }
    T.sessionId = sid;
  } catch(_) { T.sessionId = 's_' + Math.random().toString(36).slice(2, 12); }

  // ── Core send ──
  function send(batch){
    if(!batch.length) return Promise.resolve();
    const payload = JSON.stringify({
      events: batch.map(e => ({
        event: e.name,
        properties: e.props || {},
        session_id: T.sessionId,
        user_id: T.userId,
        ts: e.ts
      }))
    });
    // sendBeacon is best for unload; fetch is fine for normal events
    if(batch.length === 1 && batch[0]._beacon && navigator.sendBeacon){
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/events', blob);
      return Promise.resolve();
    }
    return fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(() => {
      // Re-queue on failure
      batch.forEach(e => T.queue.unshift(e));
    });
  }

  function flush(){
    if(!T.queue.length) return;
    const batch = T.queue.splice(0, 50);
    send(batch);
  }

  // Auto-flush every 5s
  T.flushTimer = setInterval(flush, 5000);

  // Flush on tab hide / unload
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', () => flush());

  // ── Track API ──
  T.track = function(name, props){
    if(typeof name !== 'string' || !name) return;
    T.queue.push({
      name: name.slice(0, 100),
      props: props || {},
      ts: new Date().toISOString()
    });
    if(T.queue.length >= 20) flush();
  };

  T.identify = function(userId){
    T.userId = userId || null;
  };
  T.reset = function(){
    T.userId = null;
    try {
      sessionStorage.removeItem('eai_sid');
      T.sessionId = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('eai_sid', T.sessionId);
    } catch(_){}
  };
  T.flush = flush;

  // ── Auto: page view ──
  function trackPageView(){
    if(T.pageTracked) return;
    T.pageTracked = true;
    T.track('page_view', {
      path: location.pathname,
      search: location.search.slice(0, 200),
      referer: document.referrer.slice(0, 200),
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      ua: navigator.userAgent.slice(0, 150)
    });
  }
  if(document.readyState === 'complete') trackPageView();
  else window.addEventListener('load', trackPageView);

  // ── Auto: scroll depth ──
  let scrollTimeout;
  function onScroll(){
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const docH = document.documentElement.scrollHeight - window.innerHeight;
      if(docH <= 0) return;
      const pct = Math.round((window.scrollY / docH) * 100);
      [25, 50, 75, 100].forEach(mark => {
        if(pct >= mark && !T.scrollMarks.has(mark)){
          T.scrollMarks.add(mark);
          T.track('scroll_depth', { depth: mark, path: location.pathname });
        }
      });
    }, 150);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  // ── Auto: time on page (on unload) ──
  window.addEventListener('pagehide', () => {
    T.queue.push({
      name: 'time_on_page',
      props: {
        duration_ms: Date.now() - T.startedAt,
        path: location.pathname,
        max_scroll: T.scrollMarks.size ? Math.max(...T.scrollMarks) : 0
      },
      ts: new Date().toISOString(),
      _beacon: true
    });
    flush();
  });

  // ── Auto: CTA clicks (data-track attribute) ──
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-track]');
    if(el){
      T.track('cta_click', {
        label: el.dataset.track,
        text: (el.textContent || '').trim().slice(0, 80),
        href: el.getAttribute('href') || null,
        path: location.pathname
      });
    }
    const link = e.target.closest('a[href^="http"]');
    if(link && new URL(link.href).host !== location.host){
      T.track('outbound_click', { url: link.href.slice(0, 200), text: (link.textContent || '').trim().slice(0, 80) });
    }
  });

  // ── Auto: JS errors ──
  window.addEventListener('error', e => {
    T.track('js_error', {
      message: String(e.message || '').slice(0, 300),
      filename: String(e.filename || '').slice(0, 200),
      lineno: e.lineno || 0,
      colno: e.colno || 0
    });
  });
  window.addEventListener('unhandledrejection', e => {
    T.track('js_error', {
      message: 'unhandledrejection: ' + String(e.reason?.message || e.reason || '').slice(0, 300)
    });
  });

  // ── Auto: web vitals (best-effort) ──
  if('PerformanceObserver' in window){
    try {
      // LCP
      new PerformanceObserver(list => {
        const last = list.getEntries().at(-1);
        if(last) T.track('web_vitals', { metric: 'lcp', value: Math.round(last.startTime) });
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch(_){}
    try {
      // CLS
      let cls = 0;
      new PerformanceObserver(list => {
        for(const e of list.getEntries()){
          if(!e.hadRecentInput) cls += e.value;
        }
        T.track('web_vitals', { metric: 'cls', value: Math.round(cls * 1000) / 1000 });
      }).observe({ type: 'layout-shift', buffered: true });
    } catch(_){}
  }
})();
