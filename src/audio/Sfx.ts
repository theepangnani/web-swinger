/**
 * Procedural sound effects via the Web Audio API.
 *
 * Every sound is synthesised at runtime from oscillators and filtered noise —
 * no audio files, so the game stays a self-contained bundle and works offline,
 * exactly like the textures and characters.
 *
 * An AudioContext cannot start without a user gesture, so `unlock()` must be
 * called from a click handler.
 */
export type SfxId =
  | 'thwip'
  | 'attach'
  | 'release'
  | 'punch'
  | 'heavy'
  | 'explosion'
  | 'lightning'
  | 'splat'
  | 'land'
  | 'jump'
  | 'gadget'
  | 'hurt'
  | 'levelup'
  | 'ui'
  | 'alert'
  | 'sand'
  // Voice beds: short textures layered *under* a spoken line. A sub-bass
  // growl beneath Venom does more for "this is a monster talking" than any
  // amount of pitch shifting the synthesiser.
  | 'bed_growl'
  | 'bed_crackle'
  | 'bed_grit'
  | 'bed_cackle';

export class Sfx {
  enabled = true;
  volume = 0.7;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /** Continuous wind, driven by player speed. */
  private windSource: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  /** Cheap guard against dozens of identical sounds in the same frame. */
  private readonly lastPlayed = new Map<SfxId, number>();

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Creates or resumes the context. Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
        this.noise = this.buildNoise(this.ctx);
        this.startWind();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      // Audio unavailable — the game runs silent rather than failing.
      this.ctx = null;
    }
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  /** Wind volume and brightness track how fast the player is moving. */
  setWind(speed: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const t = Math.max(0, Math.min(1, (speed - 12) / 70));
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(t * t * 0.28, now, 0.12);
    this.windFilter.frequency.setTargetAtTime(320 + t * 1500, now, 0.15);
  }

  play(id: SfxId, gain = 1, rate = 1): void {
    if (!this.enabled || !this.ctx || !this.master || this.ctx.state !== 'running') return;

    // Debounce: many systems can fire the same cue in one frame.
    const now = this.ctx.currentTime;
    const last = this.lastPlayed.get(id) ?? -1;
    if (now - last < 0.045) return;
    this.lastPlayed.set(id, now);

    switch (id) {
      case 'thwip':
        // Rising filtered hiss — the web leaving the shooter.
        this.burst(0.14, 900 * rate, 5200 * rate, 0.35 * gain, 'highpass');
        this.tone('sawtooth', 320 * rate, 1400 * rate, 0.1, 0.06 * gain);
        break;
      case 'attach':
        this.burst(0.07, 2400, 700, 0.3 * gain, 'bandpass');
        break;
      case 'release':
        this.burst(0.09, 1800, 400, 0.16 * gain, 'bandpass');
        break;
      case 'punch':
        // Body impact: a short low thump under a noise transient.
        this.tone('sine', 180 * rate, 60, 0.12, 0.5 * gain);
        this.burst(0.06, 1800, 300, 0.3 * gain, 'lowpass');
        break;
      case 'heavy':
        this.tone('sine', 130 * rate, 42, 0.24, 0.7 * gain);
        this.burst(0.12, 1200, 180, 0.4 * gain, 'lowpass');
        break;
      case 'explosion':
        this.tone('sine', 90, 30, 0.5, 0.75 * gain);
        this.burst(0.55, 1600, 90, 0.6 * gain, 'lowpass');
        break;
      case 'lightning':
        // Crackle: fast bright noise plus a buzzing partial.
        this.burst(0.22, 6000, 1800, 0.35 * gain, 'highpass');
        this.tone('square', 2200, 260, 0.18, 0.1 * gain);
        break;
      case 'splat':
        this.burst(0.2, 700, 160, 0.4 * gain, 'lowpass');
        this.tone('triangle', 240, 70, 0.16, 0.16 * gain);
        break;
      case 'land':
        this.tone('sine', 150, 45, 0.2, 0.55 * gain);
        this.burst(0.14, 900, 140, 0.3 * gain, 'lowpass');
        break;
      case 'jump':
        this.tone('triangle', 260, 520, 0.11, 0.14 * gain);
        break;
      case 'gadget':
        this.burst(0.09, 1400, 3600, 0.22 * gain, 'bandpass');
        break;
      case 'hurt':
        this.tone('sawtooth', 300, 110, 0.2, 0.28 * gain);
        this.burst(0.14, 1000, 250, 0.22 * gain, 'lowpass');
        break;
      case 'levelup':
        // Simple rising triad.
        this.tone('triangle', 520, 520, 0.14, 0.16 * gain, 0);
        this.tone('triangle', 660, 660, 0.14, 0.16 * gain, 0.1);
        this.tone('triangle', 880, 880, 0.26, 0.18 * gain, 0.2);
        break;
      case 'alert':
        this.tone('square', 420, 300, 0.16, 0.12 * gain, 0);
        this.tone('square', 300, 220, 0.24, 0.12 * gain, 0.16);
        break;
      case 'sand':
        // Dry grit: broadband noise with no tonal component at all.
        this.burst(0.4, 3200, 900, 0.3 * gain, 'bandpass');
        this.burst(0.26, 800, 260, 0.22 * gain, 'lowpass');
        break;
      case 'bed_growl':
        // Long, low and quiet — it sits under the line rather than over it.
        this.tone('sawtooth', 58, 44, 1.5, 0.13 * gain);
        this.tone('sine', 31, 27, 1.6, 0.16 * gain);
        this.burst(1.2, 260, 90, 0.07 * gain, 'lowpass');
        break;
      case 'bed_crackle':
        this.burst(1.1, 7000, 2400, 0.09 * gain, 'highpass');
        this.tone('square', 118, 96, 1.2, 0.035 * gain);
        break;
      case 'bed_grit':
        this.burst(1.3, 1800, 500, 0.1 * gain, 'bandpass');
        this.tone('sine', 46, 40, 1.3, 0.09 * gain);
        break;
      case 'bed_cackle':
        // Three quick rising blips: a laugh implied rather than sampled.
        this.tone('triangle', 620, 900, 0.09, 0.06 * gain, 0);
        this.tone('triangle', 720, 1040, 0.09, 0.06 * gain, 0.13);
        this.tone('triangle', 840, 1200, 0.12, 0.06 * gain, 0.26);
        break;
      default:
        this.tone('sine', 700, 700, 0.06, 0.1 * gain);
        break;
    }
  }

  dispose(): void {
    try {
      this.windSource?.stop();
    } catch {
      // Already stopped.
    }
    this.windSource = null;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  // ---------------------------------------------------------------- private

  /** One second of white noise, reused by every noise-based cue. */
  private buildNoise(ctx: AudioContext): AudioBuffer {
    const length = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private startWind(): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 400;
    filter.Q.value = 0.7;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter).connect(gain).connect(this.master);
    source.start();

    this.windSource = source;
    this.windFilter = filter;
    this.windGain = gain;
  }

  /** A filtered noise burst with an exponential decay. */
  private burst(
    duration: number,
    freqFrom: number,
    freqTo: number,
    peak: number,
    type: BiquadFilterType,
  ): void {
    if (!this.ctx || !this.master || !this.noise) return;
    // exponentialRampToValueAtTime cannot start from zero, so a muted cue must
    // be skipped rather than scheduled.
    if (peak <= 0.0002) return;
    const now = this.ctx.currentTime;

    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;

    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(Math.max(20, freqFrom), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), now + duration);
    filter.Q.value = type === 'bandpass' ? 1.4 : 0.8;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  /** A pitch-swept oscillator with an exponential decay. */
  private tone(
    type: OscillatorType,
    freqFrom: number,
    freqTo: number,
    duration: number,
    peak: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.master) return;
    if (peak <= 0.0002) return;
    const now = this.ctx.currentTime + delay;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freqFrom), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), now + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }
}
