/* Receipt Run — data layer.
 *
 * Receipt Run was first built on claude.ai, where the page asks the host for
 * its services with window.claude.use("db" | "assets" | "sample" | "user" |
 * "downloads"). This file answers those same calls, backed by Supabase, so
 * index.html keeps its code nearly exactly as it was (same approach as Job Book).
 *
 * What the app uses:
 *   db.doc("coll/id") and db.collection(name).doc(id): .set / .update / .delete
 *   db.collection(name)[.orderBy(field, dir)][.limit(n)].onSnapshot(cb, onErr)
 *   assets.upload(blob, {type}) -> {id};  assets.delete(id)
 *   downloads.save({filename, data})
 *   sample.limits() / sample.json(prompt, {images}) -- receipt reading
 *
 * Records live in one table, receiptrun_docs (collection + id + a jsonb "data"
 * column holding the app's fields exactly as written), locked to the signed-in
 * owner. Images live in the private "receiptrun" storage bucket under
 * <user id>/<asset id>. The app shows images by asset id through
 * window.RR_blobUrl(id), which returns a signed link prepared before the
 * receipt list is drawn.
 */
(function () {
  'use strict';

  var CFG = window.RR_CONFIG || {};
  var TABLE = 'receiptrun_docs';
  var COLLECTIONS = ['receipts', 'jobs', 'cards', 'jobcodes', 'divisions', 'aliases'];
  var SIGN_SECONDS = 60 * 60 * 24 * 7;   // a week; re-signed on every load

  var client = null;
  var session = null;
  var readyPromise = null;

  var cache = {};      // collection -> Map(id -> data)
  var subs = {};       // collection -> [{cb, onErr, order, limit}]
  var loaded = {};
  var starting = {};
  var channel = null;
  var emitTimer = {};
  var signed = {};     // asset id -> signed URL
  var signing = {};    // asset id -> true while a request is out

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function mapErr(e) {
    if (!e) return err('unknown');
    var msg = e.message || '';
    if (e.code === '42501' || /row-level security|permission denied/i.test(msg)) return err('not_granted', msg);
    if (e.code === 'PGRST301' || /jwt/i.test(msg)) return err('session_expired', msg);
    if (e.statusCode === '413' || e.status === 413 || /too large|exceeded the maximum/i.test(msg)) return err('too_large', msg);
    return err(e.code || 'unknown', msg);
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function uid() { return session ? session.user.id : null; }
  function pathFor(assetId) { return uid() + '/' + assetId; }

  /* ---------- images ------------------------------------------------------ */

  window.RR_blobUrl = function (id) { return (id && signed[id]) || ''; };

  function assetIdsIn(name) {
    var out = [];
    if (name !== 'receipts' || !cache.receipts) return out;
    cache.receipts.forEach(function (d) {
      var ids = (d.assetIds && d.assetIds.length) ? d.assetIds : (d.assetId ? [d.assetId] : []);
      ids.forEach(function (a) { if (a && !signed[a] && !signing[a]) out.push(a); });
    });
    return out;
  }
  function signMany(ids) {
    if (!ids.length) return Promise.resolve();
    ids.forEach(function (a) { signing[a] = true; });
    var chunks = [], i;
    for (i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    return Promise.all(chunks.map(function (chunk) {
      return client.storage.from(CFG.bucket).createSignedUrls(chunk.map(pathFor), SIGN_SECONDS)
        .then(function (r) {
          (r.data || []).forEach(function (row, k) { if (row && row.signedUrl) signed[chunk[k]] = row.signedUrl; });
        });
    })).catch(function () {}).then(function () {
      ids.forEach(function (a) { delete signing[a]; });
    });
  }

  /* ---------- live collections ------------------------------------------- */

  function makeDoc(id, data) { return { id: id, exists: true, data: function () { return clone(data); } }; }

  function schedule(name) {
    if (emitTimer[name]) return;
    emitTimer[name] = setTimeout(function () {
      emitTimer[name] = null;
      /* sign any new images first, so a receipt never draws with a blank photo */
      signMany(assetIdsIn(name)).then(function () { emit(name); });
    }, 16);
  }
  function emit(name) {
    var m = cache[name];
    if (!m || !loaded[name]) return;
    (subs[name] || []).forEach(function (s) {
      var rows = [];
      m.forEach(function (data, id) { rows.push({ id: id, data: data }); });
      if (s.order) {
        var f = s.order.field, desc = s.order.dir === 'desc';
        rows.sort(function (a, b) {
          var x = a.data[f], y = b.data[f];
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
        });
      }
      if (s.limit) rows = rows.slice(0, s.limit);
      try { s.cb({ docs: rows.map(function (r) { return makeDoc(r.id, r.data); }) }); }
      catch (e) { console.error(e); }
    });
  }

  function fetchAll(name) {
    var out = new Map(), from = 0, PAGE = 1000;
    function page() {
      return client.from(TABLE).select('id,data').eq('collection', name).order('id')
        .range(from, from + PAGE - 1)
        .then(function (r) {
          if (r.error) throw mapErr(r.error);
          (r.data || []).forEach(function (row) { out.set(row.id, row.data || {}); });
          if ((r.data || []).length === PAGE) { from += PAGE; return page(); }
          return out;
        });
    }
    return page();
  }
  function refresh(name) {
    return fetchAll(name).then(function (m) {
      cache[name] = m; loaded[name] = true; schedule(name);
      if (name === 'receipts') prepareFilingLinks();
    });
  }

  /* ---------- links for filing -------------------------------------------- */
  /* Filing is done by Claude on Stephen's PC ("file my receipts"). Claude reads
     the receipt records from Supabase, but the photos are private, so each
     unfiled receipt carries time-limited download links (fileLinks) that the
     PC can fetch straight into the job's Receipts folder. Refreshed whenever
     the app opens; they last a week. Claude removes them when it files. */
  var LINK_SECONDS = 60 * 60 * 24 * 7, LINK_REFRESH_MS = 1000 * 60 * 60 * 24 * 3, preparing = false;
  function prepareFilingLinks() {
    if (preparing || !cache.receipts) return;
    var now = Date.now(), todo = [];
    cache.receipts.forEach(function (d, id) {
      if (d.filedAt) return;
      var ids = (d.assetIds && d.assetIds.length) ? d.assetIds : (d.assetId ? [d.assetId] : []);
      if (!ids.length) return;
      var at = d.fileLinksAt ? Date.parse(d.fileLinksAt) : 0;
      if (now - at > LINK_REFRESH_MS) todo.push({ id: id, ids: ids });
    });
    if (!todo.length) return;
    preparing = true;
    var chain = Promise.resolve();
    todo.forEach(function (t) {
      chain = chain.then(function () {
        return client.storage.from(CFG.bucket).createSignedUrls(t.ids.map(pathFor), LINK_SECONDS)
          .then(function (r) {
            var links = (r.data || []).map(function (x) { return x && x.signedUrl; }).filter(Boolean);
            if (links.length !== t.ids.length) return;
            return docRef('receipts', t.id).update({ fileLinks: links, fileLinksAt: new Date().toISOString() });
          }).catch(function () {});
      });
    });
    chain.then(function () { preparing = false; }, function () { preparing = false; });
  }
  function refreshAll() {
    Object.keys(starting).forEach(function (n) { if (starting[n]) refresh(n).catch(function () {}); });
  }

  function subscribeAll() {
    if (channel) return;
    channel = client.channel('receiptrun-' + uid())
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: 'user_id=eq.' + uid() },
        function (p) {
          var row = p.eventType === 'DELETE' ? p.old : p.new;
          if (!row || !row.collection || !starting[row.collection]) return;
          var m = cache[row.collection] || (cache[row.collection] = new Map());
          if (p.eventType === 'DELETE') m.delete(row.id);
          else m.set(row.id, row.data || {});
          schedule(row.collection);
        })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') refreshAll();
      });
  }

  function start(name) {
    if (starting[name]) return;
    starting[name] = true;
    refresh(name).then(subscribeAll, function (e) {
      starting[name] = false;
      (subs[name] || []).forEach(function (s) { if (s.onErr) try { s.onErr(e); } catch (x) {} });
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && session) refreshAll();
  });
  window.addEventListener('online', function () { if (session) refreshAll(); });

  /* ---------- writes ------------------------------------------------------ */

  function settle(name) {
    return function (r) {
      if (r && r.error) { refresh(name).catch(function () {}); throw mapErr(r.error); }
    };
  }
  function networkFail(name) {
    return function (e) {
      refresh(name).catch(function () {});
      throw (e && e.code) ? e : err('network', e && e.message);
    };
  }

  function docRef(name, id) {
    if (COLLECTIONS.indexOf(name) === -1) throw err('invalid_argument', 'Unknown collection: ' + name);
    id = String(id);
    return {
      id: id,
      get: function () {
        return client.from(TABLE).select('data').eq('collection', name).eq('id', id).maybeSingle()
          .then(function (r) {
            if (r.error) throw mapErr(r.error);
            return r.data ? makeDoc(id, r.data.data || {})
                          : { id: id, exists: false, data: function () { return undefined; } };
          });
      },
      set: function (data) {
        var d = clone(data || {});
        (cache[name] || (cache[name] = new Map())).set(id, d);
        schedule(name);
        return client.from(TABLE)
          .upsert({ user_id: uid(), collection: name, id: id, data: d }, { onConflict: 'user_id,collection,id' })
          .then(settle(name), networkFail(name));
      },
      update: function (patch) {
        var p = clone(patch || {});
        var m = cache[name];
        if (m && m.has(id)) { m.set(id, Object.assign({}, m.get(id), p)); schedule(name); }
        return client.rpc('receiptrun_patch', { p_collection: name, p_id: id, p_patch: p })
          .then(settle(name), networkFail(name));
      },
      delete: function () {
        var m = cache[name];
        if (m && m.delete(id)) schedule(name);
        return client.from(TABLE).delete().eq('collection', name).eq('id', id)
          .then(settle(name), networkFail(name));
      }
    };
  }

  function query(name, order, limit) {
    return {
      doc: function (id) { return docRef(name, id); },
      orderBy: function (field, dir) { return query(name, { field: field, dir: dir || 'asc' }, limit); },
      limit: function (n) { return query(name, order, n); },
      onSnapshot: function (cb, onErr) {
        var sub = { cb: cb, onErr: onErr, order: order, limit: limit };
        (subs[name] || (subs[name] = [])).push(sub);
        if (loaded[name]) schedule(name); else start(name);
        return function () { subs[name] = (subs[name] || []).filter(function (s) { return s !== sub; }); };
      }
    };
  }

  var dbApi = {
    collection: function (name) {
      if (COLLECTIONS.indexOf(name) === -1) throw err('invalid_argument', 'Unknown collection: ' + name);
      return query(name, null, null);
    },
    doc: function (path) {
      var p = String(path).split('/');
      return docRef(p[0], p.slice(1).join('/'));
    }
  };

  /* ---------- images: upload / delete ------------------------------------- */

  function newAssetId() {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
  }
  var assetsApi = {
    upload: function (blob, opts) {
      var id = newAssetId();
      var type = (opts && opts.type) || blob.type || 'image/jpeg';
      return client.storage.from(CFG.bucket).upload(pathFor(id), blob, { contentType: type, upsert: false })
        .then(function (r) {
          if (r.error) throw mapErr(r.error);
          return signMany([id]).then(function () { return { id: id }; });
        });
    },
    delete: function (id) {
      delete signed[id];
      return client.storage.from(CFG.bucket).remove([pathFor(id)]).then(function (r) {
        if (r.error) throw mapErr(r.error);
      });
    }
  };

  /* ---------- downloads --------------------------------------------------- */

  var downloadsApi = {
    save: function (o) {
      var data = o.data;
      var blob = data instanceof Blob ? data : new Blob([data], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = o.filename || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return Promise.resolve();
    }
  };

  /* ---------- receipt reading --------------------------------------------- */
  /* On claude.ai the page asked the host to read a receipt. Here it goes to
     the receiptrun-read Supabase function, which holds the Anthropic key. */
  function blobToB64(b) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); res(s.slice(s.indexOf(',') + 1)); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(b);
    });
  }
  function callReader(body) {
    return client.functions.invoke('receiptrun-read', { body: body }).then(function (r) {
      if (r.error) throw err('network', r.error.message);
      var d = r.data || {};
      if (!d.ok) throw err(d.code || 'read_failed', d.message);
      return d;
    });
  }
  var readerReady = null;
  var sampleApi = {
    limits: function () {
      if (!readerReady) {
        readerReady = callReader({ ping: true }).then(function (d) { return { images: !!d.ready }; },
          function () { readerReady = null; return { images: false }; });
      }
      return readerReady;
    },
    json: function (prompt, opts) {
      var imgs = (opts && opts.images) || [];
      return Promise.all(imgs.map(blobToB64)).then(function (b64) {
        return callReader({ prompt: prompt, images: b64 });
      }).then(function (d) { return d.result; });
    }
  };
  /* for the one-time side-by-side reading test (test-read.html) */
  window.RR_read = callReader;

  /* ---------- the viewer -------------------------------------------------- */

  var userApi = {
    id: function () { return Promise.resolve(uid()); },
    can: function () { return Promise.resolve(!!session); },
    me: function () {
      if (!session) return Promise.resolve(null);
      var u = session.user;
      return Promise.resolve({ id: u.id, name: String(u.email || '').split('@')[0], email: u.email });
    }
  };

  /* ---------- sign in ----------------------------------------------------- */
  /* Same accounts as Field Measure and Job Book: email and password. */

  function sheet(html) {
    var w = document.createElement('div');
    w.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(8,9,12,.78);display:flex;align-items:flex-end';
    w.innerHTML = '<div style="width:100%;max-width:720px;margin:0 auto;background:var(--surface,#1c1f25);color:var(--fg,#ECEEF2);' +
      'border-top:1px solid var(--line,#333845);border-radius:18px 18px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px));' +
      'display:flex;flex-direction:column;gap:11px;font-family:var(--font-body,system-ui)">' + html + '</div>';
    document.body.appendChild(w);
    return w;
  }
  var BTN = 'border:none;border-radius:11px;padding:14px;background:var(--accent,#E8A33D);color:var(--accent-ink,#1A1205);' +
    'font-size:16px;font-weight:600';
  var LINK = 'border:none;background:none;padding:9px;color:var(--muted,#99A2B1);font-size:13px;text-decoration:underline';
  var FIELD = 'font-size:16px;padding:12px;border:1px solid var(--line,#333845);border-radius:9px;' +
    'background:var(--bg,#14161a);color:var(--fg,#ECEEF2);width:100%';
  var TITLE = 'font-family:var(--font-display,system-ui);font-size:19px;font-weight:700';

  function signInSheet(done) {
    var box = sheet(
      '<div id="rrtitle" style="' + TITLE + '">Sign in to Receipt Run</div>' +
      '<div style="font-size:13px;line-height:1.5;color:var(--muted,#99A2B1)">Same email and password as Job Book and Field Measure.</div>' +
      '<input id="rrem" type="email" inputmode="email" autocomplete="username" autocapitalize="none" autocorrect="off" placeholder="you@example.com" style="' + FIELD + '">' +
      '<input id="rrpw" type="password" autocomplete="current-password" placeholder="password" style="' + FIELD + '">' +
      '<div id="rrmsg" style="font-size:13px;line-height:1.45;min-height:18px;color:var(--muted,#99A2B1)"></div>' +
      '<button id="rrgo" style="' + BTN + '">Sign in</button>');
    var msg = box.querySelector('#rrmsg'), go = box.querySelector('#rrgo'), pw = box.querySelector('#rrpw');
    function submit() {
      var email = (box.querySelector('#rrem').value || '').trim(), pass = pw.value || '';
      if (!email || !pass) { msg.textContent = 'Fill in both boxes.'; return; }
      go.disabled = true; msg.textContent = 'Signing in…';
      client.auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
        go.disabled = false;
        if (r.error) {
          msg.textContent = /invalid login/i.test(r.error.message || '') ? 'Email or password not right.'
            : (r.error.message || 'That did not go through.');
          return;
        }
        box.remove();
        done(r.data.session);
      }, function () { go.disabled = false; msg.textContent = 'Could not reach the server. Check your signal.'; });
    }
    go.onclick = submit;
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise(function (resolve, reject) {
      if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey) { reject(err('offline', 'The database library did not load.')); return; }
      try {
        client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
      } catch (e) { reject(err('offline', e && e.message)); return; }
      client.auth.onAuthStateChange(function (event, s) {
        if (s) session = s;
        if (event === 'SIGNED_OUT') { session = null; setTimeout(function () { location.reload(); }, 0); }
      });
      client.auth.getSession().then(function (r) {
        var s = r && r.data && r.data.session;
        if (s) { session = s; resolve(); }
        else signInSheet(function (s2) { session = s2; resolve(); });
      }, function (e) { reject(mapErr(e)); });
    });
    return readyPromise;
  }

  /* Sign out: open the app with #signout on the end of the address. */
  if (location.hash === '#signout') {
    ready().then(function () { history.replaceState(null, '', location.pathname); return client.auth.signOut(); })
      .catch(function () {});
  }

  /* ---------- what index.html calls --------------------------------------- */

  var APIS = { db: dbApi, assets: assetsApi, sample: sampleApi, user: userApi, downloads: downloadsApi };
  window.claude = window.claude || {};
  window.claude.use = function (what) {
    if (!APIS[what]) return Promise.reject(err('not_available', what + ' is not available'));
    return ready().then(function () { return APIS[what]; });
  };
  /* for the migration check and future cross-app steps */
  window.RR_client = function () { return client; };
})();
