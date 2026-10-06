/* injected.js — runs in the MAIN world of the Twitch page.
 *
 * This file has exactly one job: to let the extension talk to Twitch's internal
 * GraphQL the same way the page itself does.
 *
 * The extension has no token of its own and must not have one (see §2 of the
 * spec): no client secret and no OAuth. Headers are taken from the page's real
 * requests, so the cookie with the streamer's session goes along automatically,
 * and client-integrity is taken from the page rather than forged.
 *
 * There are no actions on claims here — reading only.
 */
(function () {
  'use strict';

  // Version tag: Chrome caches the injected script under an unchanging URL, so
  // after edits it is easy to get a mix of an old injected.js and a new content.js.
  // Check in the console: __TPR_VERSION
  const TPR_VERSION = '2026-10-07.10';
  window.__TPR_VERSION = TPR_VERSION;

  const GQL_URL = 'https://gql.twitch.tv/gql';
  const TAG = '[points-return] ' + TPR_VERSION;

  /* ------------------------------------------------------------------ */
  /* 1. Capturing headers from the page's live requests                    */
  /* ------------------------------------------------------------------ */

  let headers = null;          // the last set of headers captured successfully
  let headersTakenAt = 0;
  let lastHeaderOrder = [];    // header order as the browser sent it
  const seenOps = new Set();   // which operations the page has already requested
  const pageData = [];         // responses the page received on its own
  const pageBodies = [];       // request bodies the page sent on its own
  /* Log of intercepted responses: which operation it is, and whether the response
   * contains claims. Needed to tell "the interceptor does not see the page's
   * responses" from "it does see them, but the panel could not parse them". */
  const captureLog = [];
  /* A separate log of the interceptor's own HTTP exchange with gql: needed to see
   * whether paging responses reach the page at all. */
  const fetchLog = [];

  function looksLikeGql(url) {
    return typeof url === 'string' && url.indexOf('gql.twitch.tv') !== -1;
  }

  function normalizeHeaders(h) {
    const out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
    } else if (Array.isArray(h)) {
      h.forEach((pair) => {
        if (pair && pair.length === 2) out[String(pair[0]).toLowerCase()] = pair[1];
      });
    } else {
      Object.keys(h).forEach((k) => { out[String(k).toLowerCase()] = h[k]; });
    }
    return out;
  }

  function headerOrderOf(h) {
    if (!h) return [];
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      const names = [];
      h.forEach((v, k) => names.push(String(k).toLowerCase()));
      return names;
    }
    if (Array.isArray(h)) return h.filter((p) => p && p.length === 2).map((p) => String(p[0]).toLowerCase());
    return Object.keys(h).map((k) => String(k).toLowerCase());
  }

  function rememberHeaders(h) {
    const n = normalizeHeaders(h);
    // We need an authorized request specifically: without client-integrity the
    // repeat is pointless, and without the cookie the request goes out anonymously.
    if (!n['client-integrity']) return false;
    headers = n;
    headersTakenAt = Date.now();
    lastHeaderOrder = headerOrderOf(h);
    return true;
  }

  function headersAge() {
    return headers ? Date.now() - headersTakenAt : -1;
  }

  function parseOps(body) {
    try {
      const j = typeof body === 'string' ? JSON.parse(body) : body;
      const items = Array.isArray(j) ? j : [j];
      return items.map((it) => it && it.operationName).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // We remember the exact body of the page's request: it can be repeated
  // verbatim and the result compared with what the page itself gets.
  function rememberBody(body) {
    if (typeof body !== 'string' || !body) return;
    if (body.indexOf('operationName') === -1) return;
    pageBodies.push(body);
    if (pageBodies.length > 20) pageBodies.shift();
  }

  function rememberPayload(body) {
    // We store what the page has already received on its own: that is free
    // data, no need to request it again.
    try {
      const j = typeof body === 'string' ? JSON.parse(body) : body;
      const items = Array.isArray(j) ? j : [j];
      items.forEach((it) => {
        if (!it || !it.data) return;
        pageData.push(it.data);
        if (pageData.length > 60) pageData.shift();

        const queue = it.data.user && it.data.user.channel && it.data.user.channel.communityPointsRedemptionQueue;
        captureLog.push({
          at: new Date().toISOString(),
          edges: queue && queue.edges ? queue.edges.length : 0,
          hasNext: queue ? !!(queue.pageInfo && queue.pageInfo.hasNextPage) : null,
          topKeys: Object.keys(it.data).join(','),
          userKeys: it.data.user ? Object.keys(it.data.user).join(',') : '(no user)'
        });
        if (captureLog.length > 60) captureLog.shift();
      });
    } catch (e) { /* not JSON — not our business */ }
  }

  /* ------------------------------------------------------------------ */
  /* 2. Patching fetch                                                   */
  /* ------------------------------------------------------------------ */

  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    let url = '';
    let method = 'GET';
    try {
      if (typeof input === 'string') {
        url = input;
        method = (init && init.method) || 'GET';
      } else if (input && input.url) {
        url = input.url;
        method = (init && init.method) || input.method || 'GET';
      }
    } catch (e) { /* ignore */ }

    if (!looksLikeGql(url)) {
      return originalFetch.apply(this, arguments);
    }

    // fetch can get headers both in the Request and in the second argument —
    // we take both, the second one wins.
    const fromRequest = (input && input.headers) ? normalizeHeaders(input.headers) : {};
    const fromInit = (init && init.headers) ? normalizeHeaders(init.headers) : {};
    rememberHeaders(Object.assign({}, fromRequest, fromInit));
    const body = (init && init.body) || (input && input.body);
    parseOps(body).forEach((o) => seenOps.add(o));
    rememberBody(body);
    fetchLog.push({
      at: new Date().toISOString(),
      ops: parseOps(body),
      bodyLen: typeof body === 'string' ? body.length : 0
    });
    if (fetchLog.length > 60) fetchLog.shift();

    const p = originalFetch.apply(this, arguments);
    p.then((res) => {
      try {
        const clone = res.clone();
        clone.text().then(rememberPayload).catch(() => {});
      } catch (e) { /* ignore */ }
    }).catch(() => {});
    return p;
  };

  /* ------------------------------------------------------------------ */
  /* 3. Patching XMLHttpRequest                                          */
  /* ------------------------------------------------------------------ */

  const XHR = window.XMLHttpRequest;
  const openOrig = XHR.prototype.open;
  const sendOrig = XHR.prototype.send;
  const setHeaderOrig = XHR.prototype.setRequestHeader;

  XHR.prototype.open = function (method, url) {
    this.__tprUrl = url;
    this.__tprMethod = method;
    this.__tprHeaders = {};
    this.__tprHeaderOrder = [];
    return openOrig.apply(this, arguments);
  };

  XHR.prototype.setRequestHeader = function (name, value) {
    try {
      if (this.__tprHeaders) this.__tprHeaders[String(name).toLowerCase()] = value;
      if (this.__tprHeaderOrder) this.__tprHeaderOrder.push(String(name).toLowerCase());
    } catch (e) { /* ignore */ }
    return setHeaderOrig.apply(this, arguments);
  };

  XHR.prototype.send = function (body) {
    try {
      if (looksLikeGql(this.__tprUrl)) {
        rememberHeaders(this.__tprHeaders);
        parseOps(body).forEach((o) => seenOps.add(o));
        rememberBody(body);
        this.addEventListener('load', () => {
          try { rememberPayload(this.responseText); } catch (e) { /* ignore */ }
        });
      }
    } catch (e) { /* ignore */ }
    return sendOrig.apply(this, arguments);
  };

  /* ------------------------------------------------------------------ */
  /* 4. Repeating the request (read-only)                                 */
  /* ------------------------------------------------------------------ */

  const GQL_HEADER_NAMES = [
    'client-id',
    'client-integrity',
    'client-session-id',
    'client-version',
    'x-device-id',
    'authorization'
  ];

  // For diagnostics we want to see exactly what we sent and what the server
  // responded. We store the last exchange in full and the history of all
  // attempts: otherwise a successful attempt is masked by the message about a failed one.
  let lastExchange = null;
  const exchangeLog = [];

  function buildSendHeaders(useCapturedHeaders, skipIntegrity) {
    const sendHeaders = { 'content-type': 'text/plain;charset=UTF-8' };
    if (useCapturedHeaders) {
      GQL_HEADER_NAMES.forEach((n) => {
        if (skipIntegrity && n === 'client-integrity') return;
        if (headers && headers[n]) sendHeaders[n] = headers[n];
      });
    }
    return sendHeaders;
  }

  /* One request attempt. It is important not to swallow the failure reason here:
   * "Failed to fetch" by itself explains nothing, so we put the mode and what the
   * server responded into the error text.
   *
   * About credentials — that was the real cause of the failure:
   * gql.twitch.tv responds with `access-control-allow-origin: *` and does NOT send
   * `access-control-allow-credentials`. Under the CORS rules the browser is
   * obliged to reject a request with a cookie to such a response, and that looks
   * exactly like "Failed to fetch". So we do not set credentials at all: the
   * request goes out as an ordinary CORS request, and authorization is the
   * Authorization header, which the page sets itself and which we intercept.
   */
  async function attempt(ops, mode, useCapturedHeaders, withCredentials, skipIntegrity) {
    const sendHeaders = buildSendHeaders(useCapturedHeaders, skipIntegrity);

    const init = {
      method: 'POST',
      headers: sendHeaders,
      body: JSON.stringify(ops)
    };
    // we never set include — see the explanation above.
    if (withCredentials === 'include') init.credentials = 'include';

    const record = {
      at: new Date().toISOString(),
      mode: mode,
      url: GQL_URL,
      sentHeaders: sendHeaders,
      sentBody: JSON.stringify(ops),
      status: null,
      responseBody: null,
      error: null
    };
    lastExchange = record;
    exchangeLog.push(record);
    if (exchangeLog.length > 20) exchangeLog.shift();

    let res;
    try {
      res = await originalFetch.call(window, GQL_URL, init);
    } catch (e) {
      const err = new Error('network: ' + (e && e.name ? e.name + ' — ' : '') + (e && e.message || e) +
        ' [mode ' + mode + ']');
      err.network = true;
      err.mode = mode;
      err.name_ = e && e.name;
      record.error = String(e && e.name || '') + ': ' + String(e && e.message || e);
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      record.status = res.status;
      record.responseBody = text.slice(0, 2000);
      const err = new Error('HTTP ' + res.status + (text ? ' — ' + text.slice(0, 300) : '') + ' [mode ' + mode + ']');
      err.status = res.status;
      err.mode = mode;
      throw err;
    }

    const text = await res.text();
    record.status = res.status;
    record.responseBody = text.slice(0, 2000);

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      const err = new Error('response did not parse as JSON [mode ' + mode + ']: ' + text.slice(0, 200));
      err.mode = mode;
      throw err;
    }

    // GraphQL errors come with HTTP 200 — they must be shown.
    const items = Array.isArray(json) ? json : [json];
    const errs = [];
    items.forEach((it) => {
      if (it && it.errors && it.errors.length) {
        it.errors.forEach((g) => {
          errs.push((g.message || 'no message') +
            (g.path ? ' (path: ' + JSON.stringify(g.path) + ')' : '') +
            (g.extensions && g.extensions.code ? ' [' + g.extensions.code + ']' : ''));
        });
      }
    });
    if (errs.length) {
      const err = new Error('GraphQL: ' + errs.join(' | ') + ' [mode ' + mode + ']');
      err.graphql = errs;
      err.mode = mode;
      throw err;
    }

    return { data: items, mode: mode };
  }

  /* Order of attempts: first the one closest to what the page does, then
   * simplifications. The first successful one is the one used. */
  async function gqlCall(ops) {
    if (!headers || !headers['client-integrity']) {
      throw new Error('Page headers are not captured yet: reload the reward queue panel.');
    }

    const attempts = [
      { mode: 'page headers', useCapturedHeaders: true, skipIntegrity: false },
      { mode: 'page headers without integrity', useCapturedHeaders: true, skipIntegrity: true },
      { mode: 'page headers + cookie', useCapturedHeaders: true, withCredentials: 'include' }
    ];

    const failures = [];
    for (const a of attempts) {
      try {
        const r = await attempt(ops, a.mode, a.useCapturedHeaders, a.withCredentials, a.skipIntegrity);
        if (a.mode !== attempts[0].mode) {
          console.warn(TAG, 'the request only succeeded in mode "' + a.mode + '»');
        }
        return r.data;
      } catch (e) {
        failures.push('[' + a.mode + '] ' + String(e && e.message || e));
        // 401/403 is a matter of permissions and cookies, another mode is worth trying.
        // For other substantive refusals there is no point trying further.
        if (e && e.status && e.status !== 401 && e.status !== 403) throw e;
      }
    }

    // We show the reasons for ALL attempts: otherwise the message about the
    // last (and obviously weakest) one masks the result of the first ones.
    const err = new Error(failures.join('  ||  '));
    err.failures = failures;
    throw err;
  }

  /* ------------------------------------------------------------------ */
  /* 5. Bridge to the content script                                     */
  /* ------------------------------------------------------------------ */

  function reply(id, ok, payload) {
    window.postMessage(
      { source: 'tpr-injected', type: 'callResult', id: id, ok: ok, payload: payload },
      window.location.origin
    );
  }

  function announce(id, kind, payload) {
    window.postMessage(
      { source: 'tpr-injected', type: kind, id: id, payload: payload },
      window.location.origin
    );
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'tpr-content') return;

    if (d.type === 'call') {
      gqlCall(d.ops)
        .then((r) => reply(d.id, true, r))
        .catch((e) => reply(d.id, false, {
          message: String(e && e.message || e),
          failures: e && e.failures,
          status: e && e.status,
          graphql: e && e.graphql,
          exchange: lastExchange
        }));
      return;
    }

    if (d.type === 'collect') {
      // We hand over the accumulated page responses: the panel takes from them the
      // claims that Twitch requested itself. Together with them, the interception log.
      const rows = pageData.slice(-(d.limit || 50));
      reply(d.id, true, {
        rows: rows,
        count: pageData.length,
        captureLog: captureLog.slice(-20),
        fetchLog: fetchLog.slice(-20)
      });
      return;
    }

    if (d.type === 'status') {
      announce(d.id, 'status', {
        hasHeaders: !!headers,
        headersAgeMs: headersAge(),
        headerNames: headers ? Object.keys(headers) : [],
        seenOps: Array.from(seenOps),
        pageDataCount: pageData.length,
        pageBodyCount: pageBodies.length,
        version: TPR_VERSION,
        location: window.location.href
      });
      return;
    }

    if (d.type === 'testCall') {
      // Diagnostics: we compare two obviously simple requests — with the captured
      // page headers and without them. This separates two different causes:
      // "repeating requests does not work at all" and "the page headers are stale
      // or unsuitable".
      const probe = [{
        operationName: 'Consent',
        variables: { id: '00000000-0000-0000-0000-000000000000', includeNewCookieConsentFields: true, includeTCData: true },
        extensions: { persistedQuery: { version: 1, sha256Hash: '012157dd34a0fb2f401124cd5a66b3f333a6ea572f75ba0db91a69bae0c3bd13' } }
      }];

      const headerInfo = {
        hasHeaders: !!headers,
        headerNames: headers ? Object.keys(headers).sort() : [],
        hasAuthorization: !!(headers && headers['authorization']),
        integrityLength: headers && headers['client-integrity'] ? String(headers['client-integrity']).length : 0,
        integrityPrefix: headers && headers['client-integrity'] ? String(headers['client-integrity']).slice(0, 12) : '',
        headersAgeMs: headersAge(),
        headerOrder: lastHeaderOrder
      };

      (async () => {
        const results = {};
        const variants = [
          { key: 'headers', label: 'page headers', h: true, c: undefined, s: false },
          { key: 'headersNoIntegrity', label: 'headers without client-integrity', h: true, c: undefined, s: true },
          { key: 'headersCookie', label: 'page headers + cookie', h: true, c: 'include', s: false }
        ];
        for (const v of variants) {
          try {
            const r = await attempt(probe, v.label, v.h, v.c, v.s);
            results[v.key] = 'SUCCESS: ' + JSON.stringify(r.data).slice(0, 140);
          } catch (e) {
            results[v.key] = 'error: ' + String(e && e.message || e);
          }
        }
        reply(d.id, true, { ok: true, headerInfo: headerInfo, results: results, exchangeLog: exchangeLog.slice(-6) });
      })();
    }
  });

  console.info(TAG, 'request interception installed');

  /* ------------------------------------------------------------------ */
  /* 6. Console access for diagnostics                                   */
  /* ------------------------------------------------------------------ */

  // To avoid asking people to paste long snippets into the console: one command
  // is a fresh probe request, the other is the last exchange in full.
  window.__TPR_DEBUG = {
    // send the probe request again (the deliberately harmless Consent operation)
    test: async function () {
      const probe = [{
        operationName: 'Consent',
        variables: { id: '00000000-0000-0000-0000-000000000000', includeNewCookieConsentFields: true, includeTCData: true },
        extensions: { persistedQuery: { version: 1, sha256Hash: '012157dd34a0fb2f401124cd5a66b3f333a6ea572f75ba0db91a69bae0c3bd13' } }
      }];
      try {
        const r = await attempt(probe, 'console', true, undefined, false);
        return { ok: true, data: r.data };
      } catch (e) {
        return { ok: false, message: String(e && e.message || e), exchange: lastExchange };
      }
    },

    // what we sent and what the server responded last time
    last: function () { return lastExchange; },

    // attempt history: every mode and the response to it are visible
    log: function () { return exchangeLog.slice(); },

    // What the page managed to receive on its own: the reference for checking
    // whether the same operation with the same variables works for it and for us.
    pageResponses: function () { return pageData.slice(); },

    // Request bodies that the page itself sent
    pageBodies: function () { return pageBodies.slice(); },

    /* Repeat the body captured from the page verbatim. If the server answers the
     * same request fine but not ours, then the difference is in the body, and it
     * can be found by comparing the two line by line. */
    replayPageBody: async function (matchText) {
      const needle = matchText || 'RedemptionsByRewardID_Paginated';
      const body = pageBodies.slice().reverse().find((b) => b.indexOf(needle) !== -1);
      if (!body) return { ok: false, error: 'body with "' + needle + '" not found among the page requests' };

      const sendHeaders = buildSendHeaders(true, false);
      const record = {
        at: new Date().toISOString(), mode: 'replay of the page body', url: GQL_URL,
        sentHeaders: sendHeaders, sentBody: body, status: null, responseBody: null, error: null
      };
      lastExchange = record;
      exchangeLog.push(record);

      try {
        const res = await originalFetch.call(window, GQL_URL, {
          method: 'POST',
          headers: sendHeaders,
          body: body
        });
        const text = await res.text();
        record.status = res.status;
        record.responseBody = text.slice(0, 2000);
        return { ok: res.ok, status: res.status, body: text.slice(0, 1500), sentBody: body };
      } catch (e) {
        record.error = String(e && e.name || '') + ': ' + String(e && e.message || e);
        return { ok: false, error: record.error, sentBody: body };
      }
    },

    // Trying out variables for the queue request: to find out exactly what the
    // server dislikes. The variants go from the closest to what the page sends.
    queueVariants: async function (channelLogin) {
      const base = {
        operationName: 'RedemptionsByRewardID_Paginated',
        extensions: { persistedQuery: { version: 1, sha256Hash: '74740dc72455f428e464fad11770a543c3ac1092b89cb39ed7411ff3a69e6d37' } }
      };
      const variants = [
        { label: 'like the page: order+count50', vars: { channelLogin: channelLogin, order: 'OLDEST', count: 50 } },
        { label: 'count 50 without order', vars: { channelLogin: channelLogin, count: 50 } },
        { label: 'count 100 with order', vars: { channelLogin: channelLogin, order: 'OLDEST', count: 100 } },
        { label: 'count 25 with order', vars: { channelLogin: channelLogin, order: 'OLDEST', count: 25 } },
        { label: 'order NEWEST count 50', vars: { channelLogin: channelLogin, order: 'NEWEST', count: 50 } },
        { label: 'channelLogin only', vars: { channelLogin: channelLogin } }
      ];
      const out = [];
      for (const v of variants) {
        const ops = [Object.assign({}, base, { variables: v.vars })];
        try {
          const r = await attempt(ops, 'variant: ' + v.label, true, undefined, false);
          const q = r.data[0] && r.data[0].data && r.data[0].data.user &&
            r.data[0].data.user.channel && r.data[0].data.user.channel.communityPointsRedemptionQueue;
          out.push({ variant: v.label, ok: true, edges: q ? q.edges.length : null, hasNext: q ? q.pageInfo && q.pageInfo.hasNextPage : null });
        } catch (e) {
          out.push({ variant: v.label, ok: false, error: String(e && e.message || e) });
        }
      }
      return out;
    },

    // Request with a cursor: the variable name is cursor (not after)
    queueAfter: async function (channelLogin, cursor) {
      const ops = [{
        operationName: 'RedemptionsByRewardID_Paginated',
        variables: { channelLogin: channelLogin, order: 'OLDEST', count: 50, cursor: cursor },
        extensions: { persistedQuery: { version: 1, sha256Hash: '74740dc72455f428e464fad11770a543c3ac1092b89cb39ed7411ff3a69e6d37' } }
      }];
      try {
        const r = await attempt(ops, 'with a cursor', true, undefined, false);
        const q = r.data[0] && r.data[0].data && r.data[0].data.user &&
          r.data[0].data.user.channel && r.data[0].data.user.channel.communityPointsRedemptionQueue;
        const first = q && q.edges && q.edges[0];
        return {
          ok: true,
          edges: q ? q.edges.length : 0,
          firstTimestamp: first ? first.node.timestamp : null
        };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },
    /* Check each required operation separately. This separates "a particular
     * operation does not work" from "nothing works": until now we had seen only
     * RedemptionsByRewardID_Paginated fail and did not know whether the others get
     * through. */
    probeOps: async function (channelLogin, sampleUserId) {
      const results = [];
      const cases = [
        { label: 'CoPoRewardQueue (rewards)', ops: [{
            operationName: 'CoPoRewardQueue', variables: { channelLogin: channelLogin },
            extensions: { persistedQuery: { version: 1, sha256Hash: '3800572d63eefadf648592b20bd46765b6de50fc7e4afdb32a908e1961497a33' } } }] },
        { label: 'RedemptionsByRewardID_Paginated (claims)', ops: [{
            operationName: 'RedemptionsByRewardID_Paginated',
            variables: { channelLogin: channelLogin, order: 'OLDEST', count: 50 },
            extensions: { persistedQuery: { version: 1, sha256Hash: '74740dc72455f428e464fad11770a543c3ac1092b89cb39ed7411ff3a69e6d37' } } }] }
      ];
      if (sampleUserId) {
        cases.push({ label: 'UserWithBadges (viewer login)', ops: [{
          operationName: 'UserWithBadges', variables: { channelLogin: channelLogin, userID: sampleUserId },
          extensions: { persistedQuery: { version: 1, sha256Hash: '9a1a4c9d9bf80eed822bb8e0ab9d60325b4de1bd28f194e5ca9b44ea38138134' } } }] });
      }
      cases.push({ label: 'Consent (harmless probe)', ops: [{
        operationName: 'Consent',
        variables: { id: '00000000-0000-0000-0000-000000000000', includeNewCookieConsentFields: true, includeTCData: true },
        extensions: { persistedQuery: { version: 1, sha256Hash: '012157dd34a0fb2f401124cd5a66b3f333a6ea572f75ba0db91a69bae0c3bd13' } } }] });

      for (const c of cases) {
        try {
          const r = await attempt(c.ops, c.label, true, undefined, false);
          const item = r.data[0] || {};
          results.push({ op: c.label, ok: true, hasErrors: !!(item.errors && item.errors.length), errors: item.errors || null });
        } catch (e) {
          results.push({ op: c.label, ok: false, error: String(e && e.message || e) });
        }
      }
      return { version: TPR_VERSION, results: results };
    },

    /* Paging diagnostics. The main conclusion of this test: the operation takes the
     * cursor in the variable `cursor`, NOT `after`. With `after` the server silently
     * returns the first page again and again — that is exactly why paging looked
     * broken. */
    cursorTest: async function (channelLogin) {
      const hash = '74740dc72455f428e464fad11770a543c3ac1092b89cb39ed7411ff3a69e6d37';
      const mk = (vars) => [{
        operationName: 'RedemptionsByRewardID_Paginated',
        variables: vars,
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
      }];
      const run = async (label, vars) => {
        try {
          const r = await attempt(mk(vars), label, true, undefined, false);
          const q = r.data[0] && r.data[0].data && r.data[0].data.user &&
            r.data[0].data.user.channel && r.data[0].data.user.channel.communityPointsRedemptionQueue;
          const edges = (q && q.edges) || [];
          return {
            label: label,
            vars: vars,
            ok: true,
            edges: edges.length,
            hasNext: q ? !!(q.pageInfo && q.pageInfo.hasNextPage) : null,
            firstId: edges[0] ? edges[0].node.id : null,
            firstTs: edges[0] ? edges[0].node.timestamp : null,
            lastTs: edges.length ? edges[edges.length - 1].node.timestamp : null
          };
        } catch (e) {
          return { label: label, vars: vars, ok: false, error: String(e && e.message || e) };
        }
      };

      // step 1: the first page, to take a real cursor
      const base = await run('page 1 (order OLDEST, count 50)', { channelLogin: channelLogin, order: 'OLDEST', count: 50 });
      const out = [base];
      if (!base.ok) return { version: TPR_VERSION, results: out, note: 'the first page failed, there is nothing left to check' };

      // we need the cursor itself: we fetch it with a separate request via the low-level path
      const raw = await attempt(mk({ channelLogin: channelLogin, order: 'OLDEST', count: 50 }), 'following the cursor', true, undefined, false);
      const q = raw.data[0].data.user.channel.communityPointsRedemptionQueue;
      const cursor = q.edges[q.edges.length - 1].cursor;

      out.push(await run('page 2 with cursor', { channelLogin: channelLogin, order: 'OLDEST', count: 50, cursor: cursor }));
      out.push(await run('page 2 with after (for comparison)', { channelLogin: channelLogin, order: 'OLDEST', count: 50, after: cursor }));

      return { version: TPR_VERSION, cursor: cursor, results: out };
    },

    // A single queue request with a given page size
    queue: async function (channelLogin, count) {
      const ops = [{
        operationName: 'RedemptionsByRewardID_Paginated',
        variables: { channelLogin: channelLogin, order: 'OLDEST', count: count || 50 },
        extensions: { persistedQuery: { version: 1, sha256Hash: '74740dc72455f428e464fad11770a543c3ac1092b89cb39ed7411ff3a69e6d37' } }
      }];
      try {
        const r = await attempt(ops, 'console queue', true, undefined, false);
        const q = r.data[0] && r.data[0].data && r.data[0].data.user &&
          r.data[0].data.user.channel && r.data[0].data.user.channel.communityPointsRedemptionQueue;
        return { ok: true, edges: q ? q.edges.length : 0, hasNextPage: q && q.pageInfo && q.pageInfo.hasNextPage, raw: r.data };
      } catch (e) {
        return { ok: false, message: String(e && e.message || e), exchange: lastExchange };
      }
    },

    // what the page itself managed to request — the reference for comparison
    pageInfo: function () {
      return {
        hasHeaders: !!headers,
        headerNames: headers ? Object.keys(headers).sort() : [],
        hasAuthorization: !!(headers && headers['authorization']),
        integrityLength: headers && headers['client-integrity'] ? String(headers['client-integrity']).length : 0,
        headersAgeMs: headersAge(),
        version: TPR_VERSION,
        seenOps: Array.from(seenOps),
        pageDataCount: pageData.length,
        pageBodyCount: pageBodies.length,
        lastExchange: lastExchange
      };
    }
  };
  console.info(TAG, 'for diagnostics: __TPR_DEBUG.pageInfo(), __TPR_DEBUG.probeOps("channel"), __TPR_DEBUG.replayPageBody()');
})();
