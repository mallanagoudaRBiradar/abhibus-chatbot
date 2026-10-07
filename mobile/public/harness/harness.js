// WebView test harness: plays the AbhiBus app around the hosted chat.
// The chat (in the iframe, same origin) talks to us with postMessage, exactly the
// messages the native apps receive. See docs/WEBVIEW_PLAN.md §4 for the contract.
(() => {
  const $ = (id) => document.getElementById(id);
  const frame = $('chat');
  const store = sessionStorage;
  const fields = ['api', 'key', 'pnr', 'seat', 'name', 'platform', 'theme', 'gps'];
  const cfg = window.__TRIPCHAT_CONFIG__ || {};

  // ------------------------------------------------------------ settings --
  $('api').value = store.getItem('h.api') || cfg.apiUrl || `${location.protocol}//${location.hostname}:4000`;
  for (const f of fields.slice(1)) { const v = store.getItem(`h.${f}`); if (v) $(f).value = v; }
  let device = localStorage.getItem('h.device');
  if (!device) { device = `harness-${crypto.randomUUID()}`; localStorage.setItem('h.device', device); }
  $('device').value = device;
  const save = () => { for (const f of fields) store.setItem(`h.${f}`, $(f).value); localStorage.setItem('h.device', $('device').value); };
  const caps = () => [...document.querySelectorAll('.caps input:checked')].map((i) => i.value);

  // ----------------------------------------------------------------- log --
  const log = (dir, type, data) => {
    const li = document.createElement('li');
    li.className = dir;
    const time = new Date().toLocaleTimeString();
    li.textContent = `${time}  ${dir === 'in' ? 'chat → app' : dir === 'out' ? 'app → chat' : '••'}  ${type}${data && Object.keys(data).length ? '  ' + JSON.stringify(data) : ''}`;
    $('log').prepend(li);
  };

  // ------------------------------------------------------------- session --
  let session = null;
  async function mintSession() {
    const pasted = $('pasted').value.trim();
    if (pasted) return JSON.parse(pasted);
    const res = await fetch(`${$('api').value.replace(/\/$/, '')}/v1/partner/chat-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': $('key').value },
      body: JSON.stringify({ pnr: $('pnr').value, seat: $('seat').value, deviceId: $('device').value, profile: { name: $('name').value, avatar: null } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${body.code || ''} ${body.message || ''}`);
    return body;
  }

  const send = (type, data = {}) => {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({ v: 1, type, data }, location.origin);
    log('out', type, type === 'boot' || type === 'session' ? { journey: data.session?.journey?.journeyId ?? data.journey?.journeyId } : data);
  };

  $('open').addEventListener('click', async () => {
    save();
    try {
      session = await mintSession();
      log('note', `session for seat ${session.me.seat} on ${session.journey.journeyId}`);
    } catch (e) { log('note', `chat-sessions failed: ${e.message}`); return; }
    $('placeholder').hidden = true;
    frame.hidden = false;
    frame.src = `/?harness=${Date.now()}`;
  });

  // ------------------------------------------- chat → app (the bridge) --
  let voiceTimers = [];
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const { type, data = {} } = e.data || {};
    if (!type) return;
    log('in', type, data);
    switch (type) {
      case 'hello': // the chat is asking for its boot payload (native apps inject it before load instead)
        send('boot', { v: 1, session, deviceId: $('device').value, platform: $('platform').value, appVersion: 'harness', theme: $('theme').value, locale: 'en-IN', capabilities: caps() });
        break;
      case 'close':
        log('note', `app would close the chat screen (reason: ${data.reason})`);
        frame.hidden = true; $('placeholder').hidden = false; $('placeholder').textContent = `Closed (${data.reason}). Open again to reload.`;
        break;
      case 'call':
        log('note', `app would open the dialer: ${data.number}`);
        break;
      case 'openExternal':
        log('note', `app would open outside the WebView: ${data.url}`);
        break;
      case 'locationRequest': {
        if ($('denyLoc').checked) { send('location', { denied: true }); break; }
        const [lat, lng] = $('gps').value.split(',').map((n) => parseFloat(n));
        send('location', { lat, lng, accuracyM: 12 });
        break;
      }
      case 'voiceStart':
        voiceTimers.forEach(clearTimeout);
        voiceTimers = [
          setTimeout(() => send('voiceResult', { text: 'reaching', final: false }), 700),
          setTimeout(() => send('voiceResult', { text: 'reaching Kurnool by ten', final: false }), 1400),
          setTimeout(() => send('voiceResult', { text: 'reaching Kurnool by ten', final: true }), 2200),
        ];
        break;
      case 'voiceStop':
        voiceTimers.forEach(clearTimeout);
        if (data.cancel) send('voiceError', { error: 'aborted' });
        else send('voiceResult', { text: 'reaching Kurnool by ten', final: true });
        break;
      case 'sessionExpired':
        if (!$('autoRenew').checked) break;
        try { session = await mintSession(); send('session', session); } catch (err) { log('note', `renew failed: ${err.message}`); }
        break;
      default:
        break; // ready, haptic: logged only
    }
  });

  // ---------------------------------------------------- app → chat buttons --
  document.querySelectorAll('[data-send]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.send;
    if (k === 'back') send('back');
    if (k === 'theme-dark') send('theme', { theme: 'dark' });
    if (k === 'theme-light') send('theme', { theme: 'light' });
    if (k === 'bg') send('appState', { state: 'background' });
    if (k === 'fg') send('appState', { state: 'active' });
    if (k === 'session') { try { session = await mintSession(); send('session', session); } catch (err) { log('note', err.message); } }
  }));
})();
