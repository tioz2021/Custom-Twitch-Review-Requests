/* content.js — user interface and reading logic. Extension isolated world.
 *
 * Flow:
 *   1. the panel reads the whole reward queue once;
 *   2. the streamer types a viewer name and clicks "Find";
 *   3. unfulfilled claims of THAT viewer are shown, grouped by reward;
 *   4. the decision and the action stay with the human.
 *
 * The only state-changing operation in this file is the refund button, and it
 * runs solely on an explicit click. There is no bulk refund and no background
 * work: an accidental mass refund would be irreversible.
 *
 * Data comes from Twitch's internal GraphQL through injected.js (MAIN world).
 */
(function () {
  'use strict';

  const TAG = '[points-return]';

  /* Bundle version. Must match TPR_VERSION in injected.js: Chrome caches the
   * injected script under an unchanging URL, so after an update it is easy to
   * end up with a mix of an old injected.js and a new content.js. If the
   * versions diverge, the panel says so. */
  const TPR_VERSION = '2026-10-07.10';
  const SCAN_DELAY_MS = 120;   // delay between pagination requests
  const USERS_PER_BATCH = 25;  // UserWithBadges operations per HTTP request
  const USERS_BATCH_DELAY = 200;
  const MAX_PAGES = 200;       // safety limit: 200 * 50 = 10,000 claims

  /* Page size. Exactly 50 — that is what the Twitch panel itself requests, and
   * the only value verified against the live server. The server rejects the
   * value 100 with "GraphQL: server error", so we do not experiment. */
  const PAGE_SIZE = 50;

  /* ------------------------------------------------------------------ */
  /* GraphQL: persisted query hashes and operations                      */
  /* ------------------------------------------------------------------ */

  const HASH = {
    redemptions: '74740dc72455f428e464fad11770a543c3ac1092b89cb39ed7411ff3a69e6d37',
    rewards: '3800572d63eefadf648592b20bd46765b6de50fc7e4afdb32a908e1961497a33',
    user: '9a1a4c9d9bf80eed822bb8e0ab9d60325b4de1bd28f194e5ca9b44ea38138134',
    userIdByLogin: 'ee9b5e2c4a8f819700ac674d92f1e74ed3b21c6f42bad5f5d41a62d02ed7433c',
    /* Rejecting a claim is exactly the points refund: the native Twitch tooltip
     * on the Reject button says "Refund points back". The response shape was
     * taken from the Twitch bundle — the claim itself comes back with a new
     * status, so success is checked by status === 'CANCELED', and the row can be
     * updated without reloading the page. */
    updateStatus: 'd940a7ebb2e588c3fc0c69a2fb61c5aeb566833f514cf55b9de728082c90361d'
  };

  function op(name, hash, variables) {
    return {
      operationName: name,
      variables: variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Bridge into the MAIN world                                          */
  /* ------------------------------------------------------------------ */

  let msgSeq = 0;
  const pending = new Map();   // id -> { resolve, reject } for GraphQL requests
  const probes = new Map();    // id -> resolve for readiness probes

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'tpr-injected') return;

    if (d.type === 'status') {
      const p = probes.get(d.id);
      if (p) { probes.delete(d.id); p(d.payload); }
      return;
    }
    if (d.type === 'callResult') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.ok) p.resolve(d.payload);
      else {
        // The failure reason must not be lost: it is what separates a server
        // refusal from a network block.
        const pl = d.payload || {};
        const short = String(pl.message || 'unknown GraphQL error');
        const err = new Error(short);
        err.detail = pl.failures ? pl.failures.join(' | ') : short;
        err.status = pl.status;
        err.headerNames = pl.headerNames;
        err.graphql = pl.graphql;
        // Full exchange with the server: what was sent and what came back.
        err.exchange = pl.exchange;
        console.warn(TAG, 'request failed:', pl);
        if (pl.exchange) {
          console.warn(TAG, 'sent:', pl.exchange.mode, '| status:', pl.exchange.status);
          console.warn(TAG, 'response body:', pl.exchange.responseBody);
        }
        p.reject(err);
      }
    }
  });

  function injectedCall(ops) {
    return new Promise((resolve, reject) => {
      const id = 'tpr-' + (++msgSeq);
      pending.set(id, { resolve: resolve, reject: reject });
      window.postMessage({ source: 'tpr-content', type: 'call', id: id, ops: ops }, window.location.origin);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('GraphQL request timed out'));
        }
      }, 45000);
    });
  }

  // Interceptor readiness check. Each check has its own ID, so parallel
  // calls do not overwrite each other.
  function injectedStatus() {
    return new Promise((resolve) => {
      const id = 'tpr-probe-' + (++msgSeq);
      probes.set(id, resolve);
      window.postMessage({ source: 'tpr-content', type: 'status', id: id }, window.location.origin);
      setTimeout(() => {
        if (probes.has(id)) { probes.delete(id); resolve(null); }
      }, 900);
    });
  }

  async function waitForHeaders(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const st = await injectedStatus();
      if (st && st.hasHeaders) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(300);
    }
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const state = {
    channel: '',
    channelId: '',            // channel id — required by the refund request
    rewards: [],              // { id, title, count, pricingType } — prices are not kept
    redemptions: [],          // every claim in the queue, oldest first
    usersById: new Map(),     // id -> { login, displayName }
    loginIndex: new Map(),    // normalized login -> user id
    ready: false,
    loading: false,
    warnings: [],
    // search result
    viewer: null,             // { id, displayName, login, foundByQueue }
    viewerRedemptions: [],
    selectedCat: -1,          // reward selected in the left column (-1 = overview)
    lastQuery: '',
    // Refund confirmation is on by default: the action is irreversible and Twitch
    // shows no dialog of its own. The choice is remembered between page loads.
    confirmRefund: (function () {
      try { return localStorage.getItem('tpr-confirm-refund') !== '0'; } catch (e) { return true; }
    })(),
    collapsed: false,         // panel collapsed down to its header
    showIds: false,
    refundInFlight: false,
    stopPaging: false,        // paging stop flag
    paging: false             // whether paging is running right now
  };

  /* ------------------------------------------------------------------ */
  /* Network                                                             */
  /* ------------------------------------------------------------------ */

  async function rpc(ops) {
    const res = await injectedCall(ops);
    return res.map((item) => {
      if (item && item.errors && item.errors.length) {
        throw new Error('GraphQL: ' + (item.errors[0].message || 'error'));
      }
      return item && item.data;
    });
  }

  async function fetchRewards() {
    const [data] = await rpc([op('CoPoRewardQueue', HASH.rewards, { channelLogin: state.channel })]);
    const user = data && data.user;
    const settings = user && user.channel && user.channel.communityPointsSettings;
    if (!settings || !settings.summarizedRewards) {
      throw new Error('Response has no communityPointsSettings.summarizedRewards');
    }
    // The channel id is needed to reject claims: the request carries a channelID
    // field and it equals the id of the channel user.
    if (user.id) state.channelId = user.id;
    return settings.summarizedRewards.map((s) => ({
      id: s.node.id,
      title: s.node.title,
      pricingType: s.node.pricingType,
      count: s.count,
      isEnabled: s.node.isEnabled,
      isPaused: s.node.isPaused
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Refund for a single claim                                            */
  /* ------------------------------------------------------------------ */

  // Set of processed claims: the list is built from it, and it also protects
  // against refunding the same claim twice.
  const seenRedemptionIds = new Set();
  // Claims with a request in flight right now, so the button cannot be pressed
  // twice while the first request is still on its way.
  const inFlight = new Set();

  /* The only state-changing operation in the whole extension. It runs solely on
   * an explicit click on the "Refund points" button of one specific claim —
   * there is no background or automatic bulk refund.
   *
   * The refund uses the very same mechanism as the Reject button in Twitch's
   * panel: newStatus: 'CANCELED'. The value was captured from a real request,
   * the response shape comes from the Twitch bundle. */
  async function rejectRedemption(redemption) {
    if (!state.channelId) {
      throw new Error('Channel id is unknown — click "Reload claims" first.');
    }
    const [data] = await rpc([op('UpdateCoPoCustomRewardStatus', HASH.updateStatus, {
      input: {
        channelID: state.channelId,
        redemptionID: redemption.id,
        newStatus: 'CANCELED'
      }
    })]);

    // HTTP 200 does not mean success: GraphQL errors arrive inside the body,
    // so both the payload and the new claim status are checked.
    const updated = data && data.updateCommunityPointsCustomRewardRedemptionStatus
      && data.updateCommunityPointsCustomRewardRedemptionStatus.redemption;
    if (!updated) {
      throw new Error('The server did not return the updated claim.');
    }
    if (updated.status && updated.status !== 'CANCELED') {
      throw new Error('Claim status is still "' + updated.status + '" — points were not refunded.');
    }
    return updated;
  }

  // Removes a claim from local data after a successful refund, so that it is not
  // counted again on the next search.
  function forgetRedemption(id) {
    state.redemptions = state.redemptions.filter((r) => r.id !== id);
    state.viewerRedemptions = state.viewerRedemptions.filter((r) => r.id !== id);
    seenRedemptionIds.delete(id);
  }

  /* ------------------------------------------------------------------ */
  /* Collecting claims from the responses the page itself receives        */
  /* ------------------------------------------------------------------ */

  /* Parses any queue response, wherever it came from, and adds new claims.
   * This is how the full list is collected when the operation does not support
   * a cursor: the page loads page after page, and we accumulate everything that
   * passed through us. */
  function appendRedemptionsFromPayload(payload) {
    if (!payload) return 0;
    const items = Array.isArray(payload) ? payload : [payload];
    let added = 0;
    items.forEach((it) => {
      const queue = it && it.data && it.data.user && it.data.user.channel &&
        it.data.user.channel.communityPointsRedemptionQueue;
      if (!queue || !queue.edges) return;
      queue.edges.forEach((edge) => {
        const n = edge && edge.node;
        if (!n || !n.id || seenRedemptionIds.has(n.id)) return;
        seenRedemptionIds.add(n.id);
        state.redemptions.push({
          id: n.id,
          rewardId: n.reward && n.reward.id,
          rewardTitle: (n.reward && n.reward.title) || '',
          userId: n.user && n.user.id,
          input: n.input,
          timestamp: n.timestamp,
          cursor: edge.cursor
        });
        added++;
      });
    });
    if (added) {
      state.redemptions.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    }
    return added;
  }

  /* Paging through the native panel.
   *
   * Collecting all claims automatically did not work: the Twitch operation
   * ignores the after parameter — verified by a separate test; with a real
   * cursor, with a garbage one, with order and without it, the same first 50
   * come back. But the page can page on its own, and its responses pass through
   * our interceptor. So we can click "Next page" and accumulate what arrives.
   *
   * This is reading: clicking the paging button changes nothing in the claims
   * themselves. */
  function findNextPageButton() {
    const byLabel = document.querySelector('button[aria-label="Next page" i]');
    if (byLabel) return byLabel;
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find((b) => /next page/i.test(b.getAttribute('aria-label') || '')) || null;
  }

  function pageCounterText() {
    const m = document.body.innerText.match(/\d+\s*-\s*\d+\s+of\s+[\d,\s+]+/);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }

  async function loadAllByPaging(onProgress) {
    state.stopPaging = false;
    let round = 0;
    let stalled = 0;
    const MAX_ROUNDS = 300;

    while (round < MAX_ROUNDS && !state.stopPaging) {
      const btn = findNextPageButton();
      if (!btn) return { stopped: 'the "Next page" button was not found in the Twitch panel' };
      if (btn.disabled) return { stopped: 'end of the list reached' };

      const before = state.redemptions.length;
      btn.click();
      round++;

      // wait for the interceptor to see a new response
      await sleep(450);
      for (let i = 0; i < 20 && state.redemptions.length === before; i++) {
        await sleep(250);
      }

      const added = state.redemptions.length - before;
      if (onProgress) onProgress({ round: round, total: state.redemptions.length, added: added, counter: pageCounterText() });

      if (added === 0) {
        stalled++;
        if (stalled >= 3) return { stopped: 'no new claims are coming in' };
      } else {
        stalled = 0;
      }
    }
    return { stopped: state.stopPaging ? 'stopped manually' : 'page limit reached' };
  }

  /* Reading claims. The order is:
   *   1. take what the page has already received by itself (free);
   *   2. page with our own request by cursor.
   *
   * About the parameter name — that was the main finding. The operation
   * RedemptionsByRewardID_Paginated takes the cursor in the variable `cursor`,
   * not `after`: with `after` the server silently returns the first page again
   * and again, which made paging look broken. Verified by comparison: with
   * `cursor` the first claim of the next page comes AFTER the last claim of the
   * previous one. The variables `order` and `count` are mandatory here — without
   * them the server answers with an error. */
  async function scanRedemptions(onProgress) {
    // step 1: what the page has already requested itself
    const collected = await injectedCollected(60);
    state.captureInfo = {
      pageDataCount: collected.count,
      captureLog: collected.captureLog,
      fetchLog: collected.fetchLog
    };
    if (collected.rows.length) {
      let seeded = 0;
      collected.rows.forEach((p) => { seeded += appendRedemptionsFromPayload(p); });
      if (seeded) console.info(TAG, 'claims collected from page responses:', seeded);
    }

    // step 2: our own cursor paging
    const seen = new Set(state.redemptions.map((r) => r.id));
    let cursor = null;
    let pages = 0;
    let stalled = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const vars = { channelLogin: state.channel, order: 'OLDEST', count: PAGE_SIZE };
      if (cursor) vars.cursor = cursor;

      const [data] = await rpc([op('RedemptionsByRewardID_Paginated', HASH.redemptions, vars)]);
      const queue = data && data.user && data.user.channel && data.user.channel.communityPointsRedemptionQueue;
      if (!queue || !queue.edges) {
        throw new Error('Response has no communityPointsRedemptionQueue.edges');
      }

      let added = 0;
      queue.edges.forEach((edge) => {
        const n = edge.node;
        if (!n || seen.has(n.id)) return;
        seen.add(n.id);
        state.redemptions.push({
          id: n.id,
          rewardId: n.reward && n.reward.id,
          rewardTitle: (n.reward && n.reward.title) || '',
          userId: n.user && n.user.id,
          input: n.input,
          timestamp: n.timestamp,
          cursor: edge.cursor
        });
        added++;
      });
      state.redemptions.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      pages++;

      onProgress({ page: page, loaded: state.redemptions.length, added: added });

      if (!queue.pageInfo || !queue.pageInfo.hasNextPage) break;

      // The cursor did not move: the server announces a page, but there are no new claims.
      // Two such passes in a row — we are stuck, no point looping further.
      if (added === 0) {
        stalled++;
        if (stalled >= 2) {
          state.warnings.push('Paging stopped at page ' + page +
            ': the server announces a next page but returns no new claims. Loaded ' +
            fmt(state.redemptions.length) + '.');
          break;
        }
      } else {
        stalled = 0;
      }

      const last = queue.edges[queue.edges.length - 1];
      cursor = last && last.cursor;
      if (!cursor) break;
      await sleep(SCAN_DELAY_MS);
    }

    state.cursorPages = pages;
    state.paginationIncomplete = stalled > 0;
    return state.redemptions;
  }

  // Take the page responses collected by the interceptor, along with the log
  function injectedCollected(limit) {
    const empty = { rows: [], count: 0, captureLog: [], fetchLog: [] };
    return new Promise((resolve) => {
      const id = 'tpr-collect-' + (++msgSeq);
      pending.set(id, {
        resolve: (v) => resolve({
          rows: (v && v.rows) || [],
          count: (v && v.count) || 0,
          captureLog: (v && v.captureLog) || [],
          fetchLog: (v && v.fetchLog) || []
        }),
        reject: () => resolve(empty)
      });
      window.postMessage({ source: 'tpr-content', type: 'collect', id: id, limit: limit || 50 }, window.location.origin);
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve(empty); }
      }, 2000);
    });
  }

  async function resolveUsers(userIds, onProgress) {
    const todo = userIds.filter((id) => id && !state.usersById.has(id));
    for (let i = 0; i < todo.length; i += USERS_PER_BATCH) {
      const chunk = todo.slice(i, i + USERS_PER_BATCH);
      const ops = chunk.map((id) => op('UserWithBadges', HASH.user, { channelLogin: state.channel, userID: id }));
      try {
        const datas = await rpc(ops);
        datas.forEach((d) => {
          const u = d && d.user;
          if (u && u.id) rememberUser(u);
        });
      } catch (e) {
        console.warn(TAG, 'could not resolve logins for a batch', e);
      }
      onProgress({ resolved: Math.min(i + chunk.length, todo.length), total: todo.length });
      await sleep(USERS_BATCH_DELAY);
    }
  }

  function rememberUser(u) {
    state.usersById.set(u.id, { login: u.login || '', displayName: u.displayName || u.login || u.id });
    if (u.login) state.loginIndex.set(u.login.toLowerCase(), u.id);
    if (u.displayName) state.loginIndex.set(u.displayName.toLowerCase(), u.id);
  }

  // Search for a viewer by a login that is not among the claims: first we ask
  // Twitch for their ID, then for their profile. This is how "no claims" is
  // distinguished from "no such viewer".
  async function lookupViewerByLogin(login) {
    const [byLogin] = await rpc([op('UserIdByLogin', HASH.userIdByLogin, { channelLogin: login })]);
    const id = byLogin && byLogin.user && byLogin.user.id;
    if (!id) return null;
    const [profile] = await rpc([op('UserWithBadges', HASH.user, { channelLogin: state.channel, userID: id })]);
    const u = profile && profile.user;
    if (!u || !u.id) return null;
    rememberUser(u);
    return state.usersById.get(u.id);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ------------------------------------------------------------------ */
  /* Derived values                                                      */
  /* ------------------------------------------------------------------ */

  /* PRICES ARE DELIBERATELY NOT COMPUTED HERE.
   *
   * A claim does not carry the cost — only the reward id and title — while the
   * price lives in the channel's reward list. And some claims point to a reward
   * that is no longer in that list: on real channels that is a noticeable share
   * (rewards get recreated, and old claims keep the previous id).
   * Such claims could only be matched by title, which is approximate, and an
   * approximate total is worse than no total at all: the streamer would refund
   * less than the viewer spent and would not notice.
   *
   * So the panel shows what it knows for sure — the list of purchases by
   * category and their count. A human counts the points: they know the prices of
   * their rewards, including the ones that were deleted.
   */

  function normalizeTitle(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function fmt(n) {
    return (n || 0).toLocaleString('ru-RU');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  /* Categories = rewards for which the viewer has unfulfilled claims.
   *
   * The key is the reward ID from the claim itself. The title is taken from the
   * same place, from the claim: the channel's reward list is not needed for
   * grouping at all, so the fiddling with matching by title is gone as well.
   * Claims for deleted rewards do not disappear anywhere — they simply form
   * categories of their own.
   *
   * Sorting is by claim count: where there are more of them, there is more work. */
  function groupByReward(redemptions) {
    const map = new Map();
    redemptions.forEach((r) => {
      const key = r.rewardId || 't:' + normalizeTitle(r.rewardTitle);
      if (!map.has(key)) {
        map.set(key, {
          key: key,
          rewardId: r.rewardId,
          title: r.rewardTitle || 'Untitled reward',
          items: []
        });
      }
      map.get(key).items.push(r);
    });

    const groups = Array.from(map.values());
    groups.forEach((g) => {
      g.items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    });
    groups.sort((a, b) => b.items.length - a.items.length);
    return groups;
  }

  /* ------------------------------------------------------------------ */
  /* User interface                                                      */
  /* ------------------------------------------------------------------ */

  let el = {};

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /* Typography is set DIRECTLY IN THE ELEMENTS, not only through classes.
   *
   * Reason: Twitch's global styles overrode the classes — text got a zero line
   * height or a color matching the background, and the screen showed empty bars
   * with perfectly correct markup (DevTools confirmed this). An inline style
   * takes priority over any rules from the page, so it is more reliable. Classes
   * are kept for what does not affect readability: padding, borders, background. */
  const TXT = {
    fontFamily: 'Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif',
    fontSize: '13px',
    lineHeight: '1.4',
    color: '#efeff1',
    visibility: 'visible',
    opacity: '1',
    textAlign: 'left',
    textTransform: 'none',
    letterSpacing: 'normal',
    whiteSpace: 'normal'
    // we deliberately do NOT set display: table cells must stay table-cell,
    // and inline captions must stay inline. An element gets display on its own
    // only if it matters (see the txt calls with an explicit display).
  };

  // Applies readable typography to an element, with individual parts overridable
  function txt(node, extra) {
    const style = Object.assign({}, TXT, extra || {});
    Object.keys(style).forEach((k) => { node.style[k] = style[k]; });
    // Some resets color the text via -webkit-text-fill-color: without resetting it,
    // color alone is not enough.
    node.style.webkitTextFillColor = style.color;
    return node;
  }

  function buildPanel() {
    const root = h('div', 'tpr-root');

    /* header */
    const head = h('div', 'tpr-head');
    head.appendChild(txt(h('div', 'tpr-title', 'Points refund — search by viewer'),
      { fontSize: '14px', fontWeight: '600', lineHeight: '1.3', color: '#efeff1' }));
    /* The version tag is visible right in the interface. Chrome does not always
     * re-read content.js after the extension is updated, and then we deal with the
     * symptoms of stale code without noticing it. Now it is visible immediately. */
    head.appendChild(txt(h('span', 'tpr-version', 'v' + TPR_VERSION),
      { display: 'inline-block', fontSize: '10px', lineHeight: '1.2', color: '#7d7d8a', marginLeft: '8px', fontFamily: 'Consolas, monospace' }));

    const headRight = h('div', 'tpr-head-right');

    /* Refund confirmation toggle.
     * Confirmation is enabled by default: refunding points is irreversible, and
     * Twitch shows no dialog of its own. It is worth turning off deliberately —
     * when many claims are about to be refunded in a row and each one has been
     * checked by eye. */
    const confirmLabel = h('label', 'tpr-switch');
    confirmLabel.title = 'Ask for confirmation before every refund';
    el.confirmBox = h('input', 'tpr-switch-input');
    el.confirmBox.type = 'checkbox';
    el.confirmBox.checked = state.confirmRefund;
    el.confirmState = txt(h('span', 'tpr-switch-state', state.confirmRefund ? 'ON' : 'OFF'),
      { fontSize: '11px', lineHeight: '1.3', fontWeight: '700', whiteSpace: 'nowrap',
        color: state.confirmRefund ? '#a8e6a3' : '#ffb3b3' });
    el.confirmBox.addEventListener('change', () => {
      state.confirmRefund = el.confirmBox.checked;
      el.confirmState.textContent = state.confirmRefund ? 'ON' : 'OFF';
      el.confirmState.style.color = state.confirmRefund ? '#a8e6a3' : '#ffb3b3';
      try { localStorage.setItem('tpr-confirm-refund', state.confirmRefund ? '1' : '0'); } catch (e) { /* ignore */ }
    });
    confirmLabel.appendChild(el.confirmBox);
    confirmLabel.appendChild(txt(h('span', 'tpr-switch-text', 'Confirmation'),
      { fontSize: '11px', lineHeight: '1.3', color: '#adadb8', whiteSpace: 'nowrap' }));
    confirmLabel.appendChild(el.confirmState);
    headRight.appendChild(confirmLabel);

    el.diagBtn = h('button', 'tpr-btn tpr-btn-ghost tpr-btn-small', 'Diagnostics');
    el.diagBtn.title = 'Send one test request to the internal API and show the result';
    el.diagBtn.addEventListener('click', () => runDiagnostics());
    el.refreshBtn = h('button', 'tpr-btn tpr-btn-small', 'Reload claims');
    el.refreshBtn.addEventListener('click', () => startScan(true));
    el.closeBtn = h('button', 'tpr-btn tpr-btn-ghost tpr-btn-small', 'Collapse');
    el.closeBtn.title = "Hide the panel to work in Twitch's own interface";
    el.closeBtn.addEventListener('click', () => setCollapsed(!state.collapsed));
    headRight.appendChild(el.diagBtn);
    headRight.appendChild(el.refreshBtn);
    headRight.appendChild(el.closeBtn);
    head.appendChild(headRight);

    const body = h('div', 'tpr-body');
    el.body = body;

    /* loading status */
    el.status = h('div', 'tpr-status tpr-status-idle', 'Initializing…');
    body.appendChild(el.status);

    el.warnings = h('div', 'tpr-warnings');
    body.appendChild(el.warnings);

    /* viewer search — the main element of the panel */
    const search = h('div', 'tpr-search');
    el.viewerInput = h('input', 'tpr-search-input');
    el.viewerInput.type = 'text';
    el.viewerInput.placeholder = 'Enter a viewer name';
    el.viewerInput.autocomplete = 'off';
    el.viewerInput.spellcheck = false;
    el.viewerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });
    el.viewerInput.addEventListener('input', onInputChanged);

    el.searchBtn = h('button', 'tpr-btn tpr-btn-primary', 'Find');
    el.searchBtn.addEventListener('click', () => doSearch());

    search.appendChild(el.viewerInput);
    search.appendChild(el.searchBtn);
    body.appendChild(search);

    /* suggestions under the input */
    el.suggest = h('div', 'tpr-suggest');
    body.appendChild(el.suggest);

    /* Loading the remaining pages by paging through the native panel.
     * Needed because Twitch's claims operation ignores the cursor. */
    el.paging = h('div', 'tpr-paging');
    el.loadAllBtn = h('button', 'tpr-btn tpr-btn-ghost tpr-btn-small', 'Load the remaining pages');
    el.loadAllBtn.title = 'The panel will page through Twitch and collect every claim. This is reading only, claims are not changed.';
    el.loadAllBtn.addEventListener('click', () => runPaging());
    el.stopBtn = h('button', 'tpr-btn tpr-btn-ghost tpr-btn-small', 'Stop');
    el.stopBtn.style.display = 'none';
    el.stopBtn.addEventListener('click', () => { state.stopPaging = true; });
    el.paging.appendChild(el.loadAllBtn);
    el.paging.appendChild(el.stopBtn);
    el.paging.style.display = 'none';
    body.appendChild(el.paging);

    /* the search result — two columns, like in the native Twitch panel:
     * the reward list on the left, the contents of the selected one on the right.
     * More familiar than dropdowns, and it also removes the scrolling problem. */
    const cols = h('div', 'tpr-cols');
    el.side = h('div', 'tpr-side');
    el.main = h('div', 'tpr-main');
    cols.appendChild(el.side);
    cols.appendChild(el.main);
    body.appendChild(cols);

    root.appendChild(head);
    root.appendChild(body);

    /* IMPORTANT: the panel must not live inside the React tree.
     *
     * Twitch is an SPA: it re-renders its subtree (including
     * div.reward-queue-view) and wipes everything we inserted there. So we
     * attach the panel directly to <body>, outside React, and make it the first
     * element: it scrolls together with the page, so it covers nothing and does
     * not require reserving space for itself. */
    document.body.insertBefore(root, document.body.firstChild);
    el.root = root;
  }

  // If Twitch did throw our panel out of the DOM, we put it back in place.
  // We watch only the direct children of <body>, so there is no extra work.
  function guardPanel() {
    const observer = new MutationObserver(() => {
      if (!el.root) return;
      if (el.root.parentNode !== document.body) {
        document.body.insertBefore(el.root, document.body.firstChild);
      }
    });
    observer.observe(document.body, { childList: true });
  }

  function setStatus(text, kind) {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.className = 'tpr-status tpr-status-' + (kind || 'idle');
  }

  /* Collapse/expand the panel.
   *
   * A collapsed panel shrinks to a single header row and stops taking up the
   * screen — the native Twitch interface under it is visible and fully usable.
   * Previously "Collapse" only hid the innards, while the panel still hung over
   * the whole screen, and the claims list could not be worked with. */
  function setCollapsed(on) {
    state.collapsed = !!on;
    if (!el.root) return;
    el.root.classList.toggle('tpr-collapsed', state.collapsed);
    if (el.body) el.body.style.display = state.collapsed ? 'none' : '';
    if (el.closeBtn) el.closeBtn.textContent = state.collapsed ? 'Expand' : 'Collapse';
  }

  /* Refund button handler.
   *
   * The order is deliberate: confirmation first, then the request, then the
   * result for that particular claim. A refund is irreversible and Twitch shows
   * no dialog of its own — pressing Reject in its panel fires immediately.
   * Confirmation can be turned off with the switch in the header. */
  async function onRefundClick(redemption, group) {
    if (inFlight.has(redemption.id) || redemption.refunded) return;
    if (state.refundInFlight) return;

    if (state.confirmRefund) {
      const where = group ? '\"' + group.title + '\"' : 'this claim';
      const msg = 'Refund points for ' + where + ' from ' + fmtDate(redemption.timestamp) + '?\n\n' +
        'This cannot be undone: the claim will be rejected and the points go back to the viewer.';
      if (!window.confirm(msg)) return;
    }

    inFlight.add(redemption.id);
    state.refundInFlight = true;
    renderResult();

    try {
      const updated = await rejectRedemption(redemption);
      redemption.refunded = true;
      redemption.refundError = '';
      redemption.status = (updated && updated.status) || 'CANCELED';
      console.info(TAG, 'points refunded for claim', redemption.id);
      // The claim is processed — drop it from the list to avoid confusion
      forgetRedemption(redemption.id);
      setStatus('Points refunded. The claim was removed from the list.', 'ok');
    } catch (e) {
      redemption.refundError = String(e && (e.detail || e.message) || e);
      console.warn(TAG, 'could not refund claim ' + redemption.id, e);
      setStatus('Refund failed: ' + redemption.refundError, 'err');
    } finally {
      inFlight.delete(redemption.id);
      state.refundInFlight = false;
      renderResult();
    }
  }

  function renderWarnings() {
    if (!el.warnings) return;
    el.warnings.innerHTML = '';
    (state.warnings || []).forEach((w) => el.warnings.appendChild(txt(h('div', 'tpr-warning', w),
      { fontSize: '12px', lineHeight: '1.4', color: '#ffe0a3' })));
  }

  // Diagnostics: one simple request to the internal API, with no queue logic.
  // Needed to tell "repeating requests does not work at all" apart from "the
  // server dislikes a particular queue operation".
  function injectedTestCall() {
    return new Promise((resolve) => {
      const id = 'tpr-test-' + (++msgSeq);
      pending.set(id, { resolve: resolve, reject: () => resolve(null) });
      window.postMessage({ source: 'tpr-content', type: 'testCall', id: id }, window.location.origin);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 20000);
    });
  }

  async function runDiagnostics() {
    setStatus('Diagnostics: sending one test request…', 'work');
    const st = await injectedStatus();
    const lines = [];
    lines.push('header capture: ' + (st && st.hasHeaders ? 'yes' : 'NO'));
    if (st && st.headerNames) lines.push('page headers: ' + st.headerNames.join(', '));
    if (st && st.headersAgeMs >= 0) lines.push('captured ' + Math.round(st.headersAgeMs / 1000) + ' ago');
    if (st && st.location) lines.push('url: ' + st.location);

    try {
      const res = await injectedTestCall();
      if (res && res.ok) {
        const hi = res.headerInfo || {};
        lines.push('page headers: ' + (hi.headerNames || []).join(', '));
        lines.push('authorization captured: ' + (hi.hasAuthorization ? 'yes' : 'NO (falling back to cookies)'));
        lines.push('client-integrity: ' + (hi.integrityLength ? hi.integrityLength + ' chars, starts with ' + hi.integrityPrefix : 'none'));
        if (hi.headersAgeMs >= 0) lines.push('captured ' + Math.round(hi.headersAgeMs / 1000) + ' ago');
        if (hi.headerOrder && hi.headerOrder.length) lines.push('header order: ' + hi.headerOrder.join(' → '));
        const r = res.results || {};
        const labels = {
          headers: 'with all page headers',
          headersNoIntegrity: 'without client-integrity',
          headersCookie: 'with cookies (credentials: include)'
        };
        Object.keys(labels).forEach((k) => {
          if (r[k] !== undefined) lines.push(labels[k] + ': ' + r[k]);
        });
      } else {
        lines.push('test request: error — ' + ((res && res.message) || 'no response from the interceptor'));
      }
    } catch (e) {
      lines.push('test request: exception ' + String(e && e.message || e));
    }

    state.warnings = lines;
    renderWarnings();
    setStatus('Diagnostics finished — result below.', 'work');
  }

  // Loading more by paging through the native Twitch panel
  async function runPaging() {
    if (state.paging) return;
    state.paging = true;
    state.stopPaging = false;
    el.loadAllBtn.disabled = true;
    el.stopBtn.style.display = '';
    const started = state.redemptions.length;
    // interception log before loading more — to see whether clicks get responses
    const before = await injectedCollected(1);

    try {
      const res = await loadAllByPaging((p) => {
        setStatus('Collecting claims: pass ' + p.round + ', total ' + fmt(p.total) +
          (p.counter ? ' (' + p.counter + ')' : ''), 'work');
      });
      const added = state.redemptions.length - started;
      setStatus('Paging finished: +' + fmt(added) + ' claims, total ' + fmt(state.redemptions.length) +
        '. ' + (res && res.stopped ? '(' + res.stopped + ')' : ''), added ? 'ok' : 'work');

      // Working out why nothing may have been added: we look at the interception log
      if (!added) {
        const after = await injectedCollected(1);
        const beforeEdges = (before.captureLog || []).filter((c) => c.edges > 0).length;
        const afterEdges = (after.captureLog || []).filter((c) => c.edges > 0).length;
        state.warnings.push(
          'Paging added no claims. Responses intercepted: was ' + before.count + ', now ' + after.count +
          '; of them with claims: was ' + beforeEdges + ', now ' + afterEdges + '. ' +
          (after.count === before.count
            ? 'No new responses arrive — clicks do not trigger claim requests (or they bypass the interceptor).'
            : 'Responses arrive but carry no claims — the page is probably paging a different list.')
        );
        const lastLog = (after.captureLog || []).slice(-3);
        lastLog.forEach((c) => state.warnings.push('last response: claims ' + c.edges +
          ', hasNext ' + c.hasNext + ', keys ' + c.topKeys));
        const lastFetch = (after.fetchLog || []).slice(-3);
        lastFetch.forEach((f) => state.warnings.push('last page request: ' + (f.ops || []).join(', ') + ' (body ' + f.bodyLen + ')'));
        renderWarnings();
        return;
      }

      // logins for new viewers
      const users = Array.from(new Set(state.redemptions.map((r) => r.userId).filter(Boolean)));
      await resolveUsers(users, (p) => setStatus('Resolving logins: ' + p.resolved + ' / ' + p.total, 'work'));
      renderResult();
    } catch (e) {
      setStatus('Paging error: ' + String(e && e.message || e), 'err');
      console.warn(TAG, e);
    } finally {
      state.paging = false;
      el.loadAllBtn.disabled = false;
      el.stopBtn.style.display = 'none';
    }
  }

  function setSearchEnabled(on) {
    if (el.searchBtn) el.searchBtn.disabled = !on;
    if (el.viewerInput) el.viewerInput.disabled = !on;
  }

  /* ------------------------------------------------------------------ */
  /* Search                                                              */
  /* ------------------------------------------------------------------ */

  function onInputChanged() {
    const q = el.viewerInput.value.trim().toLowerCase();
    if (!q || q === state.lastQuery) { el.suggest.innerHTML = ''; return; }
    // suggestions come from already read claims, so we do not hit the server on every keystroke
    const matches = [];
    for (const [norm, id] of state.loginIndex) {
      if (norm.indexOf(q) !== -1) {
        const u = state.usersById.get(id);
        if (u) matches.push(u);
      }
      if (matches.length >= 8) break;
    }
    el.suggest.innerHTML = '';
    if (!matches.length) return;
    const box = h('div', 'tpr-suggest-box');
    matches.forEach((u) => {
      const b = h('button', 'tpr-suggest-item', u.displayName + (u.login.toLowerCase() !== u.displayName.toLowerCase() ? ' (' + u.login + ')' : ''));
      b.addEventListener('click', () => {
        el.viewerInput.value = u.displayName;
        el.suggest.innerHTML = '';
        doSearch();
      });
      box.appendChild(b);
    });
    el.suggest.appendChild(box);
  }

  async function doSearch() {
    const raw = el.viewerInput.value.trim();
    el.suggest.innerHTML = '';
    if (!raw) {
      setResultMessage('Enter a viewer name and click "Find".', 'hint');
      return;
    }
    if (!state.ready) {
      setResultMessage('Data is still loading — please wait for it to finish.', 'hint');
      return;
    }

    state.lastQuery = raw.toLowerCase();
    state.selectedCat = -1;   // a new search starts from the reward overview
    setSearchEnabled(false);
    setResultMessage('Searching for "' + raw + '»…', 'work');

    try {
      const norm = raw.replace(/^@/, '').toLowerCase();
      let userId = state.loginIndex.get(norm);

      if (!userId) {
        // The viewer may exist but the login is spelled differently (for example,
        // with a capital in the middle, or by displayName). We check by substrings.
        for (const [key, id] of state.loginIndex) {
          if (key === norm) { userId = id; break; }
        }
      }

      let foundByQueue = !!userId;

      if (!userId) {
        // The viewer is not among the claims: we ask Twitch whether they exist.
        try {
          const u = await lookupViewerByLogin(norm);
          if (u) {
            userId = u.id;
            state.loginIndex.set(norm, u.id);
          }
        } catch (e) {
          console.warn(TAG, 'could not verify the login', e);
        }
      }

      if (!userId) {
        state.viewer = null;
        state.viewerRedemptions = [];
        setResultMessage('Viewer "' + raw + '" was not found.', 'err');
        renderResult();
        return;
      }

      const u = state.usersById.get(userId) || { id: userId, displayName: raw, login: norm };
      state.viewer = {
        id: userId,
        displayName: u.displayName || u.login || raw,
        login: u.login || norm,
        foundByQueue: foundByQueue
      };
      state.viewerRedemptions = state.redemptions.filter((r) => r.userId === userId);

      setResultMessage('', 'ok');
      renderResult();
    } catch (e) {
      console.warn(TAG, e);
      setResultMessage('Search error: ' + String(e && e.message || e), 'err');
    } finally {
      setSearchEnabled(true);
    }
  }

  // A short service message in the right column (for example "Searching…" or an error)
  function setResultMessage(text, kind) {
    if (!el.main) return;
    el.main.innerHTML = '';
    if (!text) return;
    const box = h('div', 'tpr-message tpr-message-' + kind, text);
    el.main.appendChild(box);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering the result                                                */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* Rendering: rewards on the left, contents on the right                */
  /* ------------------------------------------------------------------ */

  /* The layout mirrors Twitch's own panel: a reward column on the left and the
   * contents of the selected reward on the right. You pick a reward at a glance
   * and then work with its claims — no expanding and collapsing a list. */
  function renderResult() {
    if (!el.side || !el.main) return;
    renderSide();
    renderMain();
  }

  /* ---------- left column ---------- */

  function renderSide() {
    el.side.innerHTML = '';

    if (!state.viewer) {
      el.side.appendChild(txt(h('div', 'tpr-empty',
        state.ready ? 'Enter a viewer name and click "Find".' : 'Loading data…'),
        { fontSize: '13px', lineHeight: '1.4', color: '#adadb8' }));
      return;
    }

    const items = state.viewerRedemptions;
    const groups = groupByReward(items);

    /* viewer summary */
    const card = h('div', 'tpr-viewer');
    card.appendChild(txt(h('div', 'tpr-viewer-name', state.viewer.displayName),
      { fontSize: '16px', fontWeight: '700', lineHeight: '1.3', color: '#ffffff' }));
    if (state.viewer.login && state.viewer.login.toLowerCase() !== state.viewer.displayName.toLowerCase()) {
      card.appendChild(txt(h('div', 'tpr-viewer-login', state.viewer.login),
        { fontSize: '11px', lineHeight: '1.3', color: '#adadb8' }));
    }
    card.appendChild(txt(h('div', 'tpr-viewer-count',
      fmt(items.length) + ' ' + plural(items.length, 'claim') +
      ' · ' + groups.length + ' ' + plural(groups.length, 'reward')),
      { fontSize: '11px', lineHeight: '1.3', color: '#d9c7ff', marginTop: '4px' }));
    el.side.appendChild(card);

    if (!items.length) {
      el.side.appendChild(txt(h('div', 'tpr-empty',
        state.viewer.foundByQueue
          ? 'This viewer has no unfulfilled claims.'
          : 'The viewer exists but has no unfulfilled claims.'),
        { fontSize: '12px', lineHeight: '1.4', color: '#a8e6a3' }));
      return;
    }

    el.side.appendChild(txt(h('div', 'tpr-side-title',
      'Rewards (' + groups.length + ')'),
      { fontSize: '11px', lineHeight: '1.3', color: '#adadb8', textTransform: 'uppercase',
        letterSpacing: '.04em', margin: '10px 0 6px 0' }));

    const list = h('div', 'tpr-rewards');
    groups.forEach((g, idx) => {
      const item = h('button', 'tpr-reward' + (idx === state.selectedCat ? ' tpr-reward-active' : ''));
      item.appendChild(txt(h('div', 'tpr-reward-title', g.title),
        { fontSize: '13px', lineHeight: '1.3', fontWeight: '600', color: '#ffffff' }));
      item.appendChild(txt(h('div', 'tpr-reward-count',
        g.items.length + ' ' + plural(g.items.length, 'claim')),
        { fontSize: '11px', lineHeight: '1.3', color: '#adadb8', marginTop: '2px' }));
      item.addEventListener('click', () => {
        state.selectedCat = idx;
        renderResult();
      });
      list.appendChild(item);
    });
    el.side.appendChild(list);
  }

  /* ---------- right column ---------- */

  function renderMain() {
    el.main.innerHTML = '';

    if (!state.viewer) {
      el.main.appendChild(txt(h('div', 'tpr-empty', 'Claims of the selected reward will appear here.'),
        { fontSize: '13px', lineHeight: '1.4', color: '#7d7d8a' }));
      return;
    }

    const items = state.viewerRedemptions;
    const groups = groupByReward(items);
    const group = groups[state.selectedCat];

    if (!items.length) {
      el.main.appendChild(txt(h('div', 'tpr-empty', 'The viewer has no unfulfilled claims.'),
        { fontSize: '13px', lineHeight: '1.4', color: '#a8e6a3' }));
      return;
    }

    if (!group) {
      // Nothing is selected on the left — we show the general overview, not emptiness.
      el.main.appendChild(txt(h('div', 'tpr-main-title', 'All viewer rewards'),
        { fontSize: '16px', lineHeight: '1.3', fontWeight: '700', color: '#ffffff' }));
      el.main.appendChild(txt(h('div', 'tpr-main-sub',
        'Pick a reward on the left to see its claims and refund them.'),
        { fontSize: '12px', lineHeight: '1.4', color: '#adadb8', marginTop: '4px' }));

      const overview = h('div', 'tpr-rewards');
      groups.forEach((g, idx) => {
        const row = h('button', 'tpr-reward tpr-reward-wide');
        row.appendChild(txt(h('span', 'tpr-reward-title', g.title),
          { display: 'inline-block', fontSize: '13px', lineHeight: '1.3', fontWeight: '600', color: '#ffffff' }));
        row.appendChild(txt(h('span', 'tpr-reward-count',
          g.items.length + ' ' + plural(g.items.length, 'claim')),
          { display: 'inline-block', float: 'right', fontSize: '12px', lineHeight: '1.3', color: '#adadb8' }));
        row.addEventListener('click', () => {
          state.selectedCat = idx;
          renderResult();
        });
        overview.appendChild(row);
      });
      el.main.appendChild(overview);
      return;
    }

    /* header of the selected reward */
    const head = h('div', 'tpr-main-head');
    head.appendChild(txt(h('div', 'tpr-main-title', group.title),
      { fontSize: '16px', lineHeight: '1.3', fontWeight: '700', color: '#ffffff' }));
    head.appendChild(txt(h('div', 'tpr-main-sub',
      group.items.length + ' ' + plural(group.items.length, 'claim') +
      ' — each can be refunded separately'),
      { fontSize: '12px', lineHeight: '1.4', color: '#adadb8', marginTop: '4px' }));

    const back = h('button', 'tpr-btn tpr-btn-small tpr-btn-ghost', 'All rewards');
    back.addEventListener('click', () => {
      state.selectedCat = -1;
      renderResult();
    });
    head.appendChild(back);
    el.main.appendChild(head);

    /* claims of the selected reward */
    const table = h('table', 'tpr-table');
    const thead = h('thead');
    const hr = h('tr');
    const headers = ['№', 'Date and time', 'What the viewer entered'];
    if (state.showIds) headers.push('Claim ID');
    headers.push('Action');
    headers.forEach((t) => hr.appendChild(h('th', null, t)));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = h('tbody');
    group.items.forEach((r, i) => {
      const tr = h('tr');
      tr.appendChild(txt(h('td', 'tpr-td-num', String(i + 1)),
        { textAlign: 'right', color: '#7d7d8a' }));

      tr.appendChild(txt(h('td', 'tpr-td-date', fmtDate(r.timestamp)),
        { whiteSpace: 'nowrap', color: '#adadb8' }));

      const tdInput = txt(h('td', 'tpr-td-input'), { color: '#b9b9c4' });
      if (r.input) {
        tdInput.textContent = String(r.input);
        tdInput.title = String(r.input);
      } else {
        tdInput.appendChild(txt(h('span', 'tpr-muted', '—'), { color: '#5c5c68' }));
      }
      tr.appendChild(tdInput);

      if (state.showIds) {
        tr.appendChild(txt(h('td', 'tpr-td-id', r.id),
          { fontFamily: 'Consolas, "Courier New", monospace', fontSize: '11px', color: '#7d7d8a', whiteSpace: 'nowrap' }));
      }

      /* Refund button for a single claim.
       * The action is irreversible, so: confirmation before sending, an
       * "in progress" state (so it cannot be pressed twice) and the result on
       * the row itself rather than one generic "done" for the whole panel. */
      const tdAct = txt(h('td', 'tpr-td-act'), { textAlign: 'right', whiteSpace: 'nowrap' });
      const busy = inFlight.has(r.id);
      const btn = txt(h('button', 'tpr-refund-btn',
        busy ? 'Refunding…' : (r.refunded ? 'Refunded' : 'Refund points')),
        { display: 'inline-block', fontFamily: 'inherit', fontSize: '12px', lineHeight: '1.2',
          fontWeight: '600', color: '#efeff1', whiteSpace: 'nowrap' });
      btn.disabled = busy || !!r.refunded;
      if (r.refunded) btn.classList.add('tpr-refunded');
      if (r.refundError) {
        btn.classList.add('tpr-refund-failed');
        btn.textContent = 'Failed — retry';
        btn.title = r.refundError;
      }
      btn.addEventListener('click', () => onRefundClick(r, group));
      tdAct.appendChild(btn);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const wrap = h('div', 'tpr-table-wrap');
    wrap.appendChild(table);
    el.main.appendChild(wrap);

    /* a tidy path to manual moderation in Twitch's own panel */
    const openOnPage = h('button', 'tpr-btn tpr-btn-small tpr-btn-ghost', 'Show this reward in the Twitch panel');
    openOnPage.addEventListener('click', () => openRewardInTwitch(group));
    el.main.appendChild(openOnPage);
  }

  // Clicks the reward button in Twitch's sidebar so the streamer can work in the
  // native interface.
  function openRewardInTwitch(g) {
    const buttons = document.querySelectorAll('button[data-test-selector="reward-queue-custom-reward-button"]');
    for (const b of buttons) {
      const p = b.querySelector('p[title]');
      if (!p) continue;
      const title = (p.getAttribute('title') || '').trim().toLowerCase();
      const target = (g.title || '').trim().toLowerCase();
      if (title === target || title.indexOf(target) !== -1 || target.indexOf(title) !== -1) {
        b.click();
        return;
      }
    }
    console.info(TAG, 'reward button not found in the Twitch panel:', g.title);
  }

  function plural(n, one, few, many) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
    return many;
  }

  /* ------------------------------------------------------------------ */
  /* Loading data                                                        */
  /* ------------------------------------------------------------------ */

  function readChannelLogin() {
    const m = location.pathname.match(/\/popout\/([^/]+)\/reward-queue/i);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function startScan(force) {
    if (state.loading) return;
    state.loading = true;
    state.ready = false;
    state.warnings = [];
    if (force) {
      state.redemptions = [];
      state.rewards = [];
      state.usersById = new Map();
      state.loginIndex = new Map();
      state.viewer = null;
      state.viewerRedemptions = [];
      renderResult();
    }
    el.refreshBtn.disabled = true;
    setSearchEnabled(false);
    renderWarnings();

    try {
      state.channel = state.channel || readChannelLogin();
      setStatus('Waiting for the page requests to be intercepted…', 'work');
      const ok = await waitForHeaders(20000);
      if (!ok) throw new Error('Could not intercept the page requests. Reload the reward queue page (F5).');

      // Version tag of the injected script: it helps notice that Chrome served
      // an old injected.js from the cache.
      const st0 = await injectedStatus();
      if (st0 && st0.version) {
        const stale = st0.version !== TPR_VERSION;
        console.info(TAG, 'interceptor version:', st0.version, stale ? '<- STALE, reload the extension' : '');
        if (stale) state.warnings.push('Warning: the injected script is version ' + st0.version +
          ' while the panel is version ' + TPR_VERSION + '. Chrome served an old cached file — ' +
          'reload the extension at chrome://extensions and refresh the page.');
      }

      // The reward list is needed only to get the channel ID for the logins
      // request and to show how many rewards there are at all. Prices from it
      // are not used (see the explanation in the "Derived values" section).
      setStatus('Reading the reward list…', 'work');
      state.rewards = await fetchRewards();
      const totalPending = state.rewards.reduce((a, r) => a + (r.count || 0), 0);

      setStatus('Rewards: ' + state.rewards.length + '. Reading claims…', 'work');
      seenRedemptionIds.clear();
      state.redemptions = [];
      state.redemptions = await scanRedemptions((p) => {
        setStatus('Reading claims… page ' + p.page + ', loaded ' + fmt(p.loaded), 'work');
      });

      setStatus('Loaded ' + fmt(state.redemptions.length) + '. Resolving viewer logins…', 'work');
      const uniqueUsers = Array.from(new Set(state.redemptions.map((r) => r.userId).filter(Boolean)));
      await resolveUsers(uniqueUsers, (p) => {
        setStatus('Resolving logins: ' + p.resolved + ' / ' + p.total, 'work');
      });

      // Twitch's panel counters are truncated (the number is shown with a "+" and
      // rewards have a cap), so a mismatch with what was actually read is normal
      // and worth warning about.
      const expected = state.rewards.reduce((a, r) => a + (r.count || 0), 0);
      if (expected && expected < state.redemptions.length) {
        state.warnings.push('Loaded ' + fmt(state.redemptions.length) + ' claims while the panel counters give only ' +
          fmt(expected) + ': Twitch truncates them in the UI (some rewards cap at 100), ' +
          'so they cannot be trusted. The exact number is here.');
      }

      // The cursor did not work (for example, Twitch changes the variable name
      // again) — we suggest loading more by paging through the native panel.
      if (state.paginationIncomplete) {
        state.warnings.push(
          'Not all claims were collected: paging stopped at ' + fmt(state.redemptions.length) + '. ' +
          'Click "Load the remaining pages" — the panel will page through the native interface ' +
          'and collect the rest (this is reading only, claims are not changed).');
        el.paging.style.display = '';
      } else {
        el.paging.style.display = 'none';
      }

      state.ready = true;
      setStatus('Done: ' + fmt(state.redemptions.length) + ' claims, ' + fmt(state.usersById.size) + ' viewers. Ready to search.', 'ok');
      renderWarnings();
      renderResult();
      el.viewerInput.focus();
    } catch (e) {
      const detail = (e && (e.detail || e.message)) || String(e);
      state.warnings = ['Error: ' + detail];
      if (e && e.graphql && e.graphql.length) {
        e.graphql.forEach((g) => state.warnings.push('server response: ' + g));
      }
      if (e && e.exchange) {
        state.warnings.push('request mode: ' + e.exchange.mode + ', response: HTTP ' + e.exchange.status +
          ', headers length: ' + Object.keys(e.exchange.sentHeaders || {}).length);
        state.warnings.push('headers: ' + Object.keys(e.exchange.sentHeaders || {}).join(', '));
      }
      setStatus('Error — details below.', 'err');
      renderWarnings();
      console.warn(TAG, e);
    } finally {
      state.loading = false;
      el.refreshBtn.disabled = false;
      setSearchEnabled(state.ready);
      renderWarnings();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Startup                                                             */
  /* ------------------------------------------------------------------ */

  function inject() {
    try {
      /* We load the styles with a script, NOT through the manifest.
       *
       * Reason: Chrome caches the stylesheet declared in the manifest, and there
       * is no way to re-read it — the URL does not change. Because of that, after
       * an extension update the browser ran a new content.js with an OLD
       * content.css: the panel was drawn by the previous version's rules, and we
       * chased the symptoms of stale styles. With the version tag in the URL the
       * browser has to take a fresh file, so the styles always match the code. */
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('content.css') + '?v=' + TPR_VERSION;
      link.dataset.tpr = 'css';
      (document.head || document.documentElement).appendChild(link);

      const s = document.createElement('script');
      // The version tag is needed here too, for the same reason.
      s.src = chrome.runtime.getURL('injected.js') + '?v=' + TPR_VERSION;
      s.dataset.tpr = '1';
      s.onload = function () { this.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.error(TAG, 'could not inject the script or styles', e);
    }
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  inject();
  whenReady(() => {
    buildPanel();
    guardPanel();
    setCollapsed(false);   // the panel starts expanded
    setStatus('Starting to read…', 'work');
    startScan(false);
  });

  console.info(TAG, 'content script loaded, channel: ' + readChannelLogin());
})();
