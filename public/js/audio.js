// Tiny synthesized sound kit (no audio files). Off by default; toggle with M.
export class Sound {
  constructor() {
    this.enabled = localStorage.getItem('office.sound') === 'on';
    this.ctx = null;
    this.lastTick = 0;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('office.sound', this.enabled ? 'on' : 'off');
    if (this.enabled) { this.ensure(); this.pop(); }
    return this.enabled;
  }

  tone(freq, start, dur, { type = 'sine', vol = 0.2, slide = 0 } = {}) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime + start);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, c.currentTime + start + dur);
    g.gain.setValueAtTime(0, c.currentTime + start);
    g.gain.linearRampToValueAtTime(vol, c.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(g); g.connect(this.master);
    o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.05);
  }

  play(fn) { if (!this.enabled) return; this.ensure(); fn(); }

  /** Agent needs you: a gentle two-note chime. */
  chime() { this.play(() => { this.tone(880, 0, 0.6, { vol: 0.18 }); this.tone(1318.5, 0.15, 0.9, { vol: 0.15 }); }); }
  /** Agent finished its turn. */
  done() { this.play(() => { this.tone(660, 0, 0.25, { vol: 0.1 }); this.tone(990, 0.09, 0.35, { vol: 0.08 }); }); }
  /** A new session walks in. */
  pop() { this.play(() => this.tone(520, 0, 0.18, { vol: 0.12, slide: 1.6 })); }
  /** Opening a panel. */
  click() { this.play(() => this.tone(1200, 0, 0.05, { type: 'triangle', vol: 0.05 })); }

  /** Soft keyboard clicks from a working agent at a given distance. */
  typing(distance) {
    if (!this.enabled || distance > 7) return;
    const now = performance.now();
    if (now - this.lastTick < 60 + Math.random() * 120) return;
    this.lastTick = now;
    this.play(() => {
      const c = this.ctx;
      const len = Math.floor(c.sampleRate * 0.015);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      const src = c.createBufferSource();
      src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2500 + Math.random() * 1500;
      const g = c.createGain(); g.gain.value = 0.25 / (1 + distance * distance * 0.4);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();
    });
  }
}
