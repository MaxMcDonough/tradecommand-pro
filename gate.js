// ═══ SITE-WIDE PASSWORD GATE ═══
// Protects all pages behind a password before any content renders.
// Password is checked against a SHA-256 hash — the plaintext is never in the code.
(function() {
  'use strict';
  // SHA-256 hash of the site password (hash of "tcpro2026")
  var HASH = 'a0f10ba36abef7a6b6c5592ab795bbcf5913c6391d2b6baf83b80be9a71ee666';
  var STORAGE_KEY = 'tcp_site_auth';
  var EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Check if already authenticated
  function isAuthed() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (data.hash === HASH && Date.now() - data.ts < EXPIRY_MS) return true;
      localStorage.removeItem(STORAGE_KEY);
    } catch(e) {}
    return false;
  }

  // SHA-256 hash function
  async function sha256(str) {
    var buf = new TextEncoder().encode(str);
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }

  if (isAuthed()) return; // Already authenticated — let page load normally

  // Block the page
  document.documentElement.style.overflow = 'hidden';

  // Wait for DOM then inject gate
  function injectGate() {
    // Hide everything
    document.body.style.visibility = 'hidden';
    document.body.style.overflow = 'hidden';

    // Create gate overlay
    var overlay = document.createElement('div');
    overlay.id = 'site-gate';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#08090f;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    overlay.innerHTML = '<div style="text-align:center;max-width:380px;padding:40px">' +
      '<div style="font-size:48px;margin-bottom:16px">⚡</div>' +
      '<h1 style="color:#f1f5f9;font-size:24px;font-weight:800;margin-bottom:8px">TradeCommand Pro</h1>' +
      '<p style="color:#64748b;font-size:13px;margin-bottom:28px">This site is currently in private beta. Enter the access code to continue.</p>' +
      '<input type="password" id="gate-pw" placeholder="Access code" autocomplete="off" style="width:100%;padding:12px 16px;background:#111827;border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#f1f5f9;font-size:15px;text-align:center;outline:none;margin-bottom:12px;letter-spacing:2px">' +
      '<button id="gate-btn" style="width:100%;padding:12px;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer">Enter →</button>' +
      '<div id="gate-err" style="color:#ef4444;font-size:12px;margin-top:10px;min-height:18px"></div>' +
      '</div>';

    // Make gate visible even though body is hidden
    overlay.style.visibility = 'visible';
    document.body.appendChild(overlay);

    var input = document.getElementById('gate-pw');
    var btn = document.getElementById('gate-btn');
    var err = document.getElementById('gate-err');

    async function tryAuth() {
      var pw = input.value.trim();
      if (!pw) { err.textContent = 'Enter the access code'; return; }
      var h = await sha256(pw);
      if (h === HASH) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({hash: HASH, ts: Date.now()}));
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity .3s ease';
        setTimeout(function(){
          overlay.remove();
          document.body.style.visibility = '';
          document.body.style.overflow = '';
          document.documentElement.style.overflow = '';
        }, 300);
      } else {
        err.textContent = 'Incorrect access code';
        input.value = '';
        input.focus();
        input.style.borderColor = '#ef4444';
        setTimeout(function(){ input.style.borderColor = 'rgba(255,255,255,.1)'; }, 1500);
      }
    }

    btn.addEventListener('click', tryAuth);
    input.addEventListener('keydown', function(e){ if(e.key==='Enter') tryAuth(); });
    setTimeout(function(){ input.focus(); }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectGate);
  } else {
    injectGate();
  }
})();
