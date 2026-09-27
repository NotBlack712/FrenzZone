// Notification sounds.
//
// Every ping is SYNTHESISED with the Web Audio API instead of loaded from an
// <audio> file: nothing to download, nothing to 404, and it works the same on
// localhost and the tunnel. The whole module is a tiny factory that lives
// behind window.sfx so the rest of the app can call sfx.play('notify') with
// or without sounds being switched on.
//
// Browsers refuse to start an AudioContext before a real user gesture, so the
// context is created lazily and resumed on the first click/key/tap. If a
// notification arrives before that happens the play is simply skipped — a
// silent failure, never an exception in the UI.
const sfx = (() => {
  const STORAGE_KEY = 'frenza.sounds';

  // Persisted per device (a sound switch is a local preference: one machine
  // with speakers, one without). Defaults to ON.
  let enabled = true;
  try { enabled = localStorage.getItem(STORAGE_KEY) !== 'off'; } catch (e) { /* private mode */ }

  let ctx = null;
  let bus = null; // every note feeds this one shared output bus

  // ---- Loudness ----
  // The old pings used raw gains of 0.03–0.05 (about -30 dB): easy to miss in
  // a noisy room. BOOST is the single loudness dial for the whole app — it is
  // multiplied into each note's gain in tone(). Notes then pass through a
  // soft-knee limiter (below) so stacking several of them loudens the sound
  // instead of clipping/distorting the speakers.
  const BOOST = 12;

  function ensureContext() {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      // Output chain: note -> bus (sum) -> limiter (safety) -> speakers.
      bus = ctx.createGain();
      bus.gain.value = 1;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;  // let quiet parts through untouched
      limiter.knee.value = 8;
      limiter.ratio.value = 12;      // squash anything that would clip
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      bus.connect(limiter).connect(ctx.destination);
    } catch (e) {
      ctx = null;
      bus = null;
    }
    return ctx;
  }

  // ---- Unlock on the first real interaction (autoplay policy) ----
  function unlock() {
    const c = ensureContext();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
    ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
      window.removeEventListener(ev, unlock));
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, unlock, { passive: true }));

  // ---- One note ----
  // `slide` bends the pitch while the note plays, which is what makes the
  // error buzz sound different from a plain blip.
  function tone({ freq = 740, at = 0, dur = 0.09, type = 'sine', gain = 0.05, slide = 0 }) {
    const c = ensureContext();
    if (!c || !enabled) return;
    if (c.state === 'suspended') {
      c.resume().catch(() => {}); // no gesture yet: silently does nothing
      return;
    }
    try {
      const t0 = c.currentTime + at;
      const osc = c.createOscillator();
      const amp = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t0 + dur);
      // Tiny attack/decay envelope — a raw gate on a square wave clicks.
      // `gain * BOOST` is the loudness setting; see the BOOST note above.
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(Math.max(0.001, gain * BOOST), t0 + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(amp).connect(bus || c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
      osc.onended = () => { try { osc.disconnect(); amp.disconnect(); } catch (e) {} };
    } catch (e) { /* never let a sound break the notification */ }
  }

  // ---- The actual "notifications" ----
  // Kept short, but unmistakable: a three-note chime with a ringing tail for
  // things you must not miss, and punchier variants for everything else.
  // Loudness itself is handled centrally by BOOST, not by these numbers.
  const patterns = {
    // Real-time events (socket 'notification'): a bright rising chime that
    // rings on for a moment — noticeable even across a room.
    notify: () => {
      tone({ freq: 988, dur: 0.1, type: 'triangle' });
      tone({ freq: 1319, at: 0.1, dur: 0.11, type: 'triangle' });
      tone({ freq: 1760, at: 0.21, dur: 0.3, type: 'triangle', gain: 0.06 });
    },
    // Chat: a quick, higher triple tap so it never sounds like a notification.
    message: () => {
      tone({ freq: 1047, dur: 0.07, type: 'triangle' });
      tone({ freq: 1319, at: 0.08, dur: 0.08, type: 'triangle' });
      tone({ freq: 1568, at: 0.16, dur: 0.2, type: 'triangle', gain: 0.055 });
    },
    // Friend requests / accepts: mid-range, friendly two-note rise.
    social: () => {
      tone({ freq: 659, dur: 0.09, type: 'triangle' });
      tone({ freq: 988, at: 0.09, dur: 0.2, type: 'triangle', gain: 0.055 });
    },
    // Plain confirmations ("Settings saved ✓") — audible but not shouty.
    success: () => {
      tone({ freq: 784, dur: 0.08, type: 'triangle' });
      tone({ freq: 1175, at: 0.08, dur: 0.18, type: 'triangle' });
    },
    // Everything else that pops up.
    info: () => tone({ freq: 880, dur: 0.1, type: 'triangle' }),
    // Failures: a low, descending double buzz that gets in your face.
    error: () => {
      tone({ freq: 300, dur: 0.14, type: 'square', slide: 190 });
      tone({ freq: 200, at: 0.15, dur: 0.2, type: 'square', gain: 0.045, slide: 130 });
    }
  };

  function play(kind) {
    if (!enabled) return;
    const fn = patterns[kind] || patterns.info;
    fn();
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch (e) {}
  }

  return {
    get enabled() { return enabled; },
    setEnabled,
    play
  };
})();

window.sfx = sfx;
