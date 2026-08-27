import { CONFIG } from '../core/Config';
import { clamp } from '../core/MathUtils';

export interface VillainReadout {
  name: string;
  /** 0..1 */
  health: number;
  distance: number;
  /**
   * Recovering, because nobody has hit them for a while.
   *
   * On the readout because an invisible mechanic that undoes the player's work
   * does not read as a rule — it reads as the damage being broken.
   */
  regenerating: boolean;
  /** Staggered, having been interrupted mid-recovery. */
  stunned: boolean;
  /** What they are working at, and how far through it, 0..1. */
  objective: string;
  objectiveProgress: number;
}

export interface AllyReadout {
  name: string;
  /** 0..1 */
  health: number;
  /** Short line describing what they are doing, or why they are not. */
  status: string;
  downed: boolean;
}

export interface HudState {
  heroName: string;
  heroColor: string;
  abilityName: string;
  /** 0..1 */
  health: number;
  /** 0..1 */
  special: number;
  speedKmh: number;
  movementState: string;
  webLength: number | null;
  tension: number;
  combo: number;
  gamepadConnected: boolean;
  /**
   * Every boss currently in play, nearest first. A team-up chapter puts two
   * here and the panel grows a second row — with one bar you cannot tell
   * whether the other one is nearly down or untouched.
   */
  villains: readonly VillainReadout[];
  /** The partner hero's readout, or null when fighting alone. */
  ally: AllyReadout | null;
  /** 24-hour clock from the day/night cycle. */
  clock: string;
  questTitle: string;
  questDesc: string;
  /** 0..1, drives the vignette overlay. */
  speedIntensity: number;
  damaged: boolean;
  /** True when a villain is inside the strike cone. */
  hasStrikeTarget: boolean;
  pointerLocked: boolean;
  voiceEnabled: boolean;
  voiceSupported: boolean;
  /** 0..1 */
  focus: number;
  /** 0..1 progress through the current level. */
  xp: number;
  level: number;
  skillPoints: number;
  gadgetName: string;
  gadgetAmmo: number;
  /** 0 = no threat, 1 = attack landing now. */
  senseUrgency: number;
  /** Bearing to the threat in radians; 0 is dead ahead, positive is right. */
  senseAngle: number;
  districtName: string;
  fps: number;
  /** Persistent banner while a special rule is in force, else null. */
  arenaLabel: string | null;
}

export interface ScreenMarker {
  /** Viewport pixels. */
  x: number;
  y: number;
  label: string;
  kind: 'crime' | 'villain';
}

const STATE_COLORS: Record<string, string> = {
  RUNNING: '#52fa7c',
  AIRBORNE: '#3b82f6',
  SWINGING: '#ffb703',
  'WALL-CRAWL': '#c084fc',
  'WEB STRIKE': '#ef4444',
};

/**
 * Thin wrapper over the static markup in index.html. Every write is guarded by
 * a cached previous value — the DOM is far more expensive to touch than to
 * compare, and this runs every frame.
 */
export class HUD {
  private readonly heroName = el('hero-name');
  private readonly abilityLabel = el('ability-label');
  private readonly hpBar = el('hp-bar');
  private readonly specialBar = el('special-bar');
  private readonly speedTxt = el('speed-txt');
  private readonly stateTxt = el('state-txt');
  private readonly webTxt = el('web-txt');
  private readonly tensionTxt = el('tension-txt');
  private readonly gamepadStatus = el('gamepad-status');
  private readonly voiceStatus = el('voice-status');
  private readonly subtitle = el('subtitle');
  private readonly subtitleSpeaker = el('subtitle-speaker');
  private readonly subtitleText = el('subtitle-text');
  private readonly comboTxt = el('combo-txt');
  private readonly bossPanel = el('boss-panel');
  private readonly allyPanel = el('ally-panel');
  private readonly allyName = el('ally-name');
  private readonly allyHpBar = el('ally-hp-bar');
  private readonly allyStatus = el('ally-status');
  private readonly clockTxt = el('clock-txt');
  private readonly questTitle = el('quest-title');
  private readonly questDesc = el('quest-desc');
  private readonly speedLines = el('speed-lines');
  private readonly dmgFlash = el('dmg-flash');
  private readonly crosshair = el('crosshair');
  private readonly overlay = el('overlay');
  private readonly overlayMsg = el('overlay-msg');
  private readonly overlayCta = el('overlay-cta');
  private readonly focusBar = el('focus-bar');
  private readonly xpBar = el('xp-bar');
  private readonly levelTxt = el('level-txt');
  private readonly skillPointsTxt = el('skillpoints-txt');
  private readonly gadgetName = el('gadget-name');
  private readonly gadgetAmmo = el('gadget-ammo');
  private readonly spiderSense = el('spider-sense');
  private readonly webReticle = el('web-reticle');
  private readonly sensePointer = el('sense-pointer');
  private readonly sensePointerArrow = el('sense-arrow');
  private readonly markersRoot = el('markers');
  private readonly skillsPanel = el('skills');
  private readonly skillBranches = el('skill-branches');
  private readonly skillPointsAvail = el('skill-points-avail');
  private readonly suitList = el('suit-list');
  private readonly arenaBanner = el('arena-banner');
  private readonly districtTxt = el('district-txt');
  private readonly fpsTxt = el('fps-txt');

  private readonly markerPool: HTMLElement[] = [];
  private readonly bossRows: HTMLElement[] = [];

  private readonly cache = new Map<string, string>();
  private flashTimer = 0;
  private subtitleTimer = 0;

  update(state: HudState, dt: number): void {
    this.setText(this.heroName, state.heroName);
    this.setStyle(this.heroName, 'color', state.heroColor);
    this.setText(this.abilityLabel, state.abilityName);

    this.setStyle(this.hpBar, 'width', `${(clamp(state.health, 0, 1) * 100).toFixed(1)}%`);
    this.setStyle(this.specialBar, 'width', `${(clamp(state.special, 0, 1) * 100).toFixed(1)}%`);
    // The special bar pulses once it is chargeable.
    this.setStyle(this.specialBar, 'background', state.special >= 1 ? '#ffe066' : '#ffb703');

    this.setText(this.speedTxt, `${Math.round(state.speedKmh)} km/h`);
    this.setText(this.stateTxt, state.movementState);
    this.setStyle(this.stateTxt, 'color', STATE_COLORS[state.movementState] ?? '#ffffff');

    this.setText(this.webTxt, state.webLength === null ? '--' : `${state.webLength.toFixed(0)} m`);
    this.setText(this.tensionTxt, `${Math.round(state.tension)} N`);

    this.setStyle(this.gamepadStatus, 'display', state.gamepadConnected ? 'block' : 'none');
    this.setText(
      this.voiceStatus,
      state.voiceSupported
        ? `Barks: ${state.voiceEnabled ? 'ON' : 'MUTED'} · M to toggle`
        : 'Barks: subtitles only',
    );

    if (this.subtitleTimer > 0) {
      this.subtitleTimer = Math.max(0, this.subtitleTimer - dt);
      // Hold full opacity, then fade over the last second or so.
      const fade = clamp(this.subtitleTimer / (CONFIG.voice.subtitleSeconds * 0.33), 0, 1);
      this.setStyle(this.subtitle, 'opacity', fade.toFixed(2));
    }

    if (state.combo > 1) {
      this.setText(this.comboTxt, `${state.combo}x COMBO`);
      this.setStyle(this.comboTxt, 'opacity', '1');
    } else {
      this.setStyle(this.comboTxt, 'opacity', '0');
    }

    this.setBossRows(state.villains);

    if (state.ally) {
      this.setStyle(this.allyPanel, 'display', 'block');
      this.setText(this.allyName, state.ally.name);
      this.setStyle(this.allyHpBar, 'width', `${(clamp(state.ally.health, 0, 1) * 100).toFixed(1)}%`);
      this.setStyle(this.allyHpBar, 'background', state.ally.downed ? '#e63946' : '#52fa7c');
      this.setText(this.allyStatus, state.ally.status);
    } else {
      this.setStyle(this.allyPanel, 'display', 'none');
    }

    this.setText(this.questTitle, state.questTitle);
    this.setText(this.questDesc, state.questDesc);

    this.setStyle(this.speedLines, 'opacity', state.speedIntensity.toFixed(2));

    // Damage vignette: triggered on the hit frame, then decays.
    if (state.damaged) this.flashTimer = 0.45;
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - dt);
      this.setStyle(this.dmgFlash, 'opacity', (this.flashTimer / 0.45).toFixed(2));
    }

    this.crosshair.classList.toggle('locked', state.pointerLocked);
    this.crosshair.classList.toggle('target-locked', state.hasStrikeTarget);

    // --- progression + gadgets -----------------------------------------
    this.setStyle(this.focusBar, 'width', `${(clamp(state.focus, 0, 1) * 100).toFixed(1)}%`);
    this.setStyle(this.focusBar, 'background', state.focus >= 1 ? '#8fd0ff' : '#4ea8ff');
    this.setStyle(this.xpBar, 'width', `${(clamp(state.xp, 0, 1) * 100).toFixed(1)}%`);
    this.setText(this.levelTxt, String(state.level));
    this.setText(this.skillPointsTxt, String(state.skillPoints));
    this.setStyle(this.skillPointsTxt, 'color', state.skillPoints > 0 ? '#52fa7c' : '#888');
    // Standing state banner, so an active rule is never invisible.
    this.setText(this.arenaBanner, state.arenaLabel ?? '');
    this.setStyle(this.arenaBanner, 'display', state.arenaLabel ? 'block' : 'none');

    this.setText(this.districtTxt, state.districtName);
    this.setText(this.clockTxt, state.clock);
    this.setText(this.fpsTxt, `${Math.round(state.fps)} fps`);
    this.setStyle(this.fpsTxt, 'color', state.fps < 45 ? '#e63946' : state.fps < 55 ? '#ffb703' : '#666');
    this.setText(this.gadgetName, state.gadgetName);
    this.setText(this.gadgetAmmo, String(state.gadgetAmmo));
    this.setStyle(this.gadgetAmmo, 'color', state.gadgetAmmo > 0 ? '#ffb703' : '#e63946');

    // --- spider-sense ---------------------------------------------------
    // A centred ring said "something is happening" and nothing more. The
    // pointer rotates to the bearing of the threat, so it tells you which way
    // to dodge.
    if (state.senseUrgency > 0) {
      const u = clamp(state.senseUrgency, 0, 1);
      const colour = u > 0.66 ? '#ff3b3b' : u > 0.33 ? '#ffb703' : '#ffe066';

      this.setStyle(this.spiderSense, 'opacity', (0.3 + u * 0.7).toFixed(2));
      this.setStyle(this.spiderSense, 'transform', `scale(${(1.45 - u * 0.6).toFixed(3)})`);
      this.setStyle(this.spiderSense, 'border-color', colour);

      const degrees = (state.senseAngle * 180) / Math.PI;
      this.setStyle(this.sensePointer, 'opacity', (0.45 + u * 0.55).toFixed(2));
      this.setStyle(this.sensePointer, 'transform', `rotate(${degrees.toFixed(1)}deg)`);
      this.setStyle(this.sensePointerArrow, 'border-bottom-color', colour);
    } else {
      this.setStyle(this.spiderSense, 'opacity', '0');
      this.setStyle(this.sensePointer, 'opacity', '0');
    }
  }

  /**
   * Renders one health bar per live boss, growing the pool as needed.
   *
   * A team-up with a single shared bar is unreadable — you cannot tell which
   * of the two you have actually hurt.
   */
  private setBossRows(villains: readonly VillainReadout[]): void {
    while (this.bossRows.length < villains.length) {
      const row = document.createElement('div');
      row.className = 'boss-row';
      row.innerHTML =
        '<div class="stat-label"></div>' +
        '<div class="bar-container"><div class="boss-hp"></div></div>' +
        '<div class="boss-dist">Distance: <b></b></div>';
      this.bossPanel.appendChild(row);
      this.bossRows.push(row);
    }

    this.setStyle(this.bossPanel, 'display', villains.length > 0 ? 'block' : 'none');

    for (let i = 0; i < this.bossRows.length; i++) {
      const row = this.bossRows[i]!;
      const readout = villains[i];
      if (!readout) {
        row.style.display = 'none';
        continue;
      }
      row.style.display = 'block';
      const name = row.querySelector('.stat-label');
      const bar = row.querySelector<HTMLElement>('.boss-hp');
      const dist = row.querySelector('.boss-dist b');
      if (name && name.textContent !== readout.name) name.textContent = readout.name;
      if (bar) {
        bar.style.width = `${(clamp(readout.health, 0, 1) * 100).toFixed(1)}%`;
        // Green while it is climbing back, so the bar itself says what is
        // happening without the player reading a word.
        bar.style.background = readout.regenerating ? '#52fa7c' : '';
      }
      // Replaces the distance rather than sitting beside it: while a boss is
      // healing or reeling, how far away they are is not the useful number.
      // Priority order is what the player can do something about soonest: an
      // opening now, then health being undone, then a thing being taken that
      // only matters if they are too far away to stop it — which is exactly
      // when the distance stops being the useful number.
      const label = readout.stunned
        ? 'STAGGERED'
        : readout.regenerating
          ? 'RECOVERING — go back in'
          : readout.objectiveProgress > 0.02
            ? `${readout.objective} ${Math.round(readout.objectiveProgress * 100)}%  ·  ${Math.round(readout.distance)}m`
            : `${Math.round(readout.distance)}m`;
      if (dist && dist.textContent !== label) dist.textContent = label;
    }
  }

  /** Repositions objective markers; extra pool entries are hidden. */
  setMarkers(markers: readonly ScreenMarker[]): void {
    while (this.markerPool.length < markers.length) {
      const node = document.createElement('div');
      node.className = 'marker';
      node.innerHTML = '<span class="pip"></span><span class="label"></span>';
      this.markersRoot.appendChild(node);
      this.markerPool.push(node);
    }

    for (let i = 0; i < this.markerPool.length; i++) {
      const node = this.markerPool[i]!;
      const marker = markers[i];
      if (!marker) {
        node.style.display = 'none';
        continue;
      }
      node.style.display = 'block';
      node.className = `marker ${marker.kind}`;
      node.style.left = `${marker.x.toFixed(0)}px`;
      node.style.top = `${marker.y.toFixed(0)}px`;
      const label = node.querySelector('.label');
      if (label && label.textContent !== marker.label) label.textContent = marker.label;
    }
  }

  // ------------------------------------------------------------ skill tree

  get skillsOpen(): boolean {
    return this.skillsPanel.classList.contains('open');
  }

  toggleSkills(): boolean {
    this.skillsPanel.classList.toggle('open');
    return this.skillsOpen;
  }

  closeSkills(): void {
    this.skillsPanel.classList.remove('open');
  }

  /**
   * Rebuilds the skill screen. `state` reports each skill's availability and
   * `onUnlock` is invoked with the chosen id.
   */
  renderSkills(
    branches: ReadonlyArray<{
      name: string;
      skills: ReadonlyArray<{ id: string; name: string; desc: string; cost: number; owned: boolean; available: boolean }>;
    }>,
    points: number,
    onUnlock: (id: string) => void,
  ): void {
    this.setText(this.skillPointsAvail, String(points));
    this.skillBranches.replaceChildren();

    for (const branch of branches) {
      const column = document.createElement('div');
      column.className = 'branch';

      const heading = document.createElement('h3');
      heading.textContent = branch.name;
      column.appendChild(heading);

      for (const skill of branch.skills) {
        const node = document.createElement('div');
        node.className = `skill${skill.owned ? ' owned' : skill.available ? '' : ' locked'}`;
        node.innerHTML =
          `<span class="cost">${skill.owned ? 'OWNED' : `${skill.cost} pt`}</span>` +
          `<div class="name"></div><div class="desc"></div>`;
        node.querySelector('.name')!.textContent = skill.name;
        node.querySelector('.desc')!.textContent = skill.desc;
        if (!skill.owned && skill.available) {
          node.addEventListener('click', () => onUnlock(skill.id));
        }
        column.appendChild(node);
      }
      this.skillBranches.appendChild(column);
    }
  }

  /** Rebuilds the suit picker beneath the skill tree. */
  renderSuits(
    suits: ReadonlyArray<{
      id: string;
      name: string;
      blurb: string;
      color: string;
      accent: string;
      unlockLevel: number;
      owned: boolean;
      equipped: boolean;
    }>,
    onEquip: (id: string) => void,
  ): void {
    this.suitList.replaceChildren();

    for (const suit of suits) {
      const node = document.createElement('div');
      node.className = `suit${suit.equipped ? ' equipped' : suit.owned ? '' : ' locked'}`;
      node.innerHTML =
        '<div class="name"><span class="swatch"></span><span class="suit-name"></span></div>' +
        '<div class="desc"></div>';

      const swatch = node.querySelector<HTMLElement>('.swatch')!;
      swatch.style.background = suit.color;
      swatch.style.borderColor = suit.accent;
      node.querySelector('.suit-name')!.textContent = suit.name;
      node.querySelector('.desc')!.textContent = suit.owned
        ? suit.blurb
        : `Unlocks at level ${suit.unlockLevel}.`;

      if (suit.owned && !suit.equipped) node.addEventListener('click', () => onEquip(suit.id));
      this.suitList.appendChild(node);
    }
  }

  /** Wires the boot-overlay mode buttons. */
  onModeSelect(
    handler: (mode: 'STORY' | 'FREE_ROAM') => void,
    onContinue: () => void,
  ): void {
    el('mode-continue').addEventListener('click', (e) => {
      e.stopPropagation();
      onContinue();
    });
    el('mode-story').addEventListener('click', (e) => {
      e.stopPropagation();
      handler('STORY');
    });
    el('mode-free').addEventListener('click', (e) => {
      e.stopPropagation();
      handler('FREE_ROAM');
    });
  }

  /**
   * Marks where a web would attach. Pass null to hide it.
   * Shown only when a shot would actually connect, so it doubles as feedback
   * that the aim is valid.
   */
  setWebReticle(target: { x: number; y: number; scale: number } | null): void {
    if (!target) {
      this.setStyle(this.webReticle, 'opacity', '0');
      return;
    }
    this.setStyle(this.webReticle, 'opacity', '1');
    this.setStyle(
      this.webReticle,
      'transform',
      `translate(${target.x.toFixed(0)}px, ${target.y.toFixed(0)}px) translate(-50%, -50%) scale(${target.scale.toFixed(2)})`,
    );
  }

  /** Data attribution line, required by the OSM licence when imported. */
  setAttribution(text: string): void {
    this.setText(el('attribution'), text);
    this.setStyle(el('attribution'), 'display', 'block');
  }

  /** Shows the Continue button with a one-line summary of the stored save. */
  setSaveSummary(summary: string | null): void {
    this.setStyle(el('mode-continue'), 'display', summary ? 'block' : 'none');
    this.setText(el('save-summary'), summary ?? '');
  }

  /** Swaps the overlay from mode-select to the simple resume prompt. */
  setModeSelectVisible(visible: boolean): void {
    this.setStyle(el('mode-select'), 'display', visible ? 'flex' : 'none');
    this.setStyle(this.overlayCta, 'display', visible ? 'none' : 'block');
  }

  /**
   * Displays a subtitle, by default for `CONFIG.voice.subtitleSeconds`.
   *
   * Scripted story lines pass their own duration. A long one holds the floor
   * for up to six and a half seconds, and on the fixed bark window the text
   * disappeared three seconds before the voice reading it had finished.
   */
  showSubtitle(speaker: string, text: string, color: string, seconds?: number): void {
    this.setText(this.subtitleSpeaker, speaker);
    this.setStyle(this.subtitleSpeaker, 'color', color);
    this.setText(this.subtitleText, text);
    this.subtitleTimer = seconds ?? CONFIG.voice.subtitleSeconds;
    this.setStyle(this.subtitle, 'opacity', '1');
  }

  /**
   * Keeps the current subtitle up for longer.
   *
   * Only ever extends. The exact length of a spoken line is not known until
   * its audio reports it, which is a moment after the subtitle went up.
   */
  extendSubtitle(seconds: number): void {
    if (seconds > this.subtitleTimer) {
      this.subtitleTimer = seconds;
      this.setStyle(this.subtitle, 'opacity', '1');
    }
  }

  showOverlay(message: string, cta: string): void {
    this.overlayMsg.innerHTML = message;
    this.overlayCta.textContent = cta;
    this.overlay.classList.remove('hidden');
  }

  hideOverlay(): void {
    this.overlay.classList.add('hidden');
  }

  /** Replaces the overlay with a non-dismissable fatal-error report. */
  showFatal(message: string, detail?: string): void {
    this.overlayMsg.innerHTML = message;
    this.overlayCta.textContent = detail ? '' : 'RELOAD TO RETRY';
    if (detail) {
      const pre = document.createElement('pre');
      pre.textContent = detail;
      this.overlayCta.replaceWith(pre);
    }
    this.overlay.classList.remove('hidden');
    this.overlay.style.cursor = 'default';
  }

  onOverlayClick(handler: () => void): void {
    this.overlay.addEventListener('click', handler);
  }

  private setText(node: HTMLElement, value: string): void {
    const key = `t:${node.id}`;
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    node.textContent = value;
  }

  private setStyle(node: HTMLElement, property: string, value: string): void {
    const key = `s:${node.id}:${property}`;
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    node.style.setProperty(property, value);
  }
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`HUD element #${id} is missing from index.html`);
  return node;
}
