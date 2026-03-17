// ═══ SITE-WIDE PASSWORD GATE ═══
// Protects all pages behind a password before any content renders.
// Uses SHA-256 when available, falls back to simple hash for HTTP/older mobile browsers.
(function() {
  'use strict';
  var HASH = 'a0f10ba36abef7a6b6c5592ab795bbcf5913c6391d2b6baf83b80be9a71ee666';
  var PLAIN_HASH = 'tcp_v2_8f3a'; // Fallback verification token
  var STORAGE_KEY = 'tcp_site_auth';
  var EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
  var CORRECT_PW = [116,99,112,114,111,50,48,50,54]; // encoded check

  function isAuthed() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if ((data.hash === HASH || data.hash === PLAIN_HASH) && Date.now() - data.ts < EXPIRY_MS) return true;
      localStorage.removeItem(STORAGE_KEY);
    } catch(e) {}
    return false;
  }

  // SHA-256 — only works in secure contexts (HTTPS)
  async function sha256(str) {
    var buf = new TextEncoder().encode(str);
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }

  // Fallback: direct byte comparison (for HTTP / mobile browsers without crypto.subtle)
  function checkPwDirect(pw) {
    if (pw.length !== CORRECT_PW.length) return false;
    for (var i = 0; i < pw.length; i++) {
      if (pw.charCodeAt(i) !== CORRECT_PW[i]) return false;
    }
    return true;
  }

  if (isAuthed()) return;

  // Block the page immediately
  document.documentElement.style.overflow = 'hidden';

  function injectGate() {
    document.body.style.visibility = 'hidden';
    document.body.style.overflow = 'hidden';

    var overlay = document.createElement('div');
    overlay.id = 'site-gate';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:#08090f;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;visibility:visible;-webkit-overflow-scrolling:touch;';
    overlay.innerHTML =
      '<div style="text-align:center;max-width:380px;width:90%;padding:40px 20px;box-sizing:border-box">' +
        '<div style="font-size:48px;margin-bottom:16px">⚡</div>' +
        '<h1 style="color:#f1f5f9;font-size:22px;font-weight:800;margin:0 0 8px">TradeCommand Pro</h1>' +
        '<p style="color:#64748b;font-size:13px;margin:0 0 28px;line-height:1.5">This site is currently in private beta.<br>Enter the access code to continue.</p>' +
        '<form id="gate-form" autocomplete="off" style="margin:0">' +
          '<input type="password" id="gate-pw" placeholder="Access code" autocomplete="off" inputmode="text" ' +
            'style="width:100%;padding:14px 16px;background:#111827;border:1px solid rgba(255,255,255,.15);border-radius:10px;color:#f1f5f9;font-size:16px;text-align:center;outline:none;margin-bottom:12px;letter-spacing:2px;box-sizing:border-box;-webkit-appearance:none;appearance:none">' +
          '<button type="submit" id="gate-btn" ' +
            'style="width:100%;padding:14px;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;-webkit-appearance:none;appearance:none;touch-action:manipulation">' +
            'Enter →</button>' +
        '</form>' +
        '<div id="gate-err" style="color:#ef4444;font-size:12px;margin-top:10px;min-height:18px"></div>' +
      '</div>';

    document.body.appendChild(overlay);

    var form = document.getElementById('gate-form');
    var input = document.getElementById('gate-pw');
    var err = document.getElementById('gate-err');

    function unlock() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({hash: HASH, ts: Date.now()}));
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity .3s ease';
      setTimeout(function(){
        overlay.remove();
        document.body.style.visibility = '';
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }, 300);
    }

    function showError() {
      err.textContent = 'Incorrect access code';
      input.value = '';
      input.focus();
      input.style.borderColor = '#ef4444';
      setTimeout(function(){ input.style.borderColor = 'rgba(255,255,255,.15)'; }, 1500);
    }

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      var pw = input.value.trim();
      if (!pw) { err.textContent = 'Enter the access code'; return; }

      // Try SHA-256 first, fall back to direct comparison
      if (window.crypto && window.crypto.subtle) {
        sha256(pw).then(function(h) {
          if (h === HASH) { unlock(); }
          else { showError(); }
        }).catch(function() {
          // crypto.subtle failed (e.g. insecure context) — use fallback
          if (checkPwDirect(pw)) { unlock(); }
          else { showError(); }
        });
      } else {
        // No crypto.subtle at all — use fallback
        if (checkPwDirect(pw)) { unlock(); }
        else { showError(); }
      }
    });

    // Focus input after a short delay (helps on mobile)
    setTimeout(function(){ input.focus(); }, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectGate);
  } else {
    injectGate();
  }
})();
