/* Feedback button, shared by Job Book, Receipt Run and Field Measure.
 *
 * The same file is copied into each app's repo (keep them identical; the
 * master copy lives in BuildWrite Apps/shared/feedback.js). Each app calls
 *
 *   BWFeedback.mount({ app: 'receipt-run', into: <element>, client: () => supabaseClient, version: 'x' })
 *
 * and gets a small "Feedback" button in that element. A note is saved to the
 * app_feedback table with who sent it, from which app and page. With no
 * signal it waits on the phone and goes out the next time the app is online.
 */
(function () {
  'use strict';
  var QUEUE = 'bw.feedback.queue.v1';
  var opts = null;

  function queue() { try { return JSON.parse(localStorage.getItem(QUEUE) || '[]') || []; } catch (e) { return []; } }
  function setQueue(q) { try { localStorage.setItem(QUEUE, JSON.stringify(q)); } catch (e) {} }

  function send(note) {
    var c = opts && opts.client && opts.client();
    if (!c || !navigator.onLine) return Promise.resolve(false);
    return c.auth.getSession().then(function (r) {
      if (!r || !r.data || !r.data.session) return false;
      return c.from('app_feedback').insert(note).then(function (res) { return !res.error; }, function () { return false; });
    }, function () { return false; });
  }
  function flush() {
    var q = queue();
    if (!q.length) return;
    var left = [], chain = Promise.resolve();
    q.forEach(function (n) { chain = chain.then(function () { return send(n).then(function (ok) { if (!ok) left.push(n); }); }); });
    chain.then(function () { setQueue(left); });
  }

  var CSS = 'font-family:inherit;font-size:13px;line-height:1.4;';
  function el(tag, style, text) { var e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; }

  function open() {
    var shade = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center');
    var box = el('div', CSS + 'width:100%;max-width:560px;max-height:100vh;overflow:auto;box-sizing:border-box;background:#fff;color:#14161a;' +
      'border-radius:14px 14px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:10px;' +
      'box-shadow:0 -8px 30px rgba(0,0,0,.25)');
    box.appendChild(el('div', 'font-size:17px;font-weight:700', 'Send feedback'));
    box.appendChild(el('div', 'font-size:13px;color:#555', 'What works, what doesn’t, what would help? Short is fine.'));
    var ta = el('textarea', CSS + 'font-size:16px;min-height:120px;padding:10px;border:1px solid #c9ccd2;border-radius:9px;resize:vertical;color:#14161a;background:#f7f7f8');
    ta.setAttribute('maxlength', '5000');
    ta.placeholder = 'e.g. Picking a division takes too many taps on site';
    box.appendChild(ta);
    var msg = el('div', 'font-size:13px;min-height:18px;color:#555', '');
    box.appendChild(msg);
    var row = el('div', 'display:flex;gap:10px');
    var cancel = el('button', CSS + 'flex:1;padding:12px;border:1px solid #c9ccd2;border-radius:9px;background:#fff;color:#14161a;font-weight:600', 'Cancel');
    var go = el('button', CSS + 'flex:2;padding:12px;border:none;border-radius:9px;background:#14161a;color:#fff;font-weight:700', 'Send');
    row.appendChild(cancel); row.appendChild(go); box.appendChild(row);
    shade.appendChild(box); document.body.appendChild(shade);
    setTimeout(function () { try { ta.focus(); } catch (e) {} }, 60);

    function close() { shade.remove(); }
    cancel.onclick = close;
    shade.addEventListener('click', function (e) { if (e.target === shade) close(); });
    go.onclick = function () {
      var text = (ta.value || '').trim();
      if (!text) { msg.textContent = 'Type a note first.'; ta.focus(); return; }
      var note = {
        app: opts.app, message: text.slice(0, 5000),
        page: (location.pathname + location.hash).slice(0, 200),
        app_version: String(opts.version || ''),
        device: (navigator.userAgent || '').slice(0, 300)
      };
      go.disabled = true; msg.textContent = 'Sending…';
      send(note).then(function (ok) {
        if (!ok) { var q = queue(); q.push(note); setQueue(q); }
        msg.textContent = ok ? 'Thanks — sent.' : 'No signal or not signed in — saved on this phone, it goes out next time.';
        setTimeout(close, ok ? 900 : 2200);
      });
    };
  }

  window.BWFeedback = {
    mount: function (o) {
      opts = o || {};
      if (!opts.into || document.getElementById('bw-feedback-btn')) return;
      var b = el('button', opts.buttonStyle || (CSS + 'font-size:12px;padding:5px 10px;border-radius:999px;border:1px solid currentColor;' +
        'background:transparent;color:inherit;opacity:.85;cursor:pointer;white-space:nowrap'), 'Feedback');
      b.id = 'bw-feedback-btn';
      b.type = 'button';
      b.setAttribute('aria-label', 'Send feedback');
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(); });
      if (opts.before) opts.into.insertBefore(b, opts.before); else opts.into.appendChild(b);
      setTimeout(flush, 4000);
      addEventListener('online', function () { setTimeout(flush, 1500); });
    },
    flush: flush
  };
})();
