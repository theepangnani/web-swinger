import {
  ACTION_LABELS,
  DIFFICULTIES,
  Settings,
  type BindableAction,
  type DifficultyId,
} from './Settings';

/**
 * The in-game settings screen: sliders for feel, toggles for presentation, and
 * a click-then-press rebinding list.
 */
export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly settings: Settings;
  /** The action currently waiting for a key press, if any. */
  private capturing: BindableAction | null = null;

  /** Raised when the panel opens or closes, so the Game can pause. */
  onVisibilityChange: ((open: boolean) => void) | null = null;
  /** Set while a rebind is in progress so Input can ignore the keystroke. */
  onCaptureChange: ((capturing: boolean) => void) | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
    this.root = requireEl('settings');
    this.body = requireEl('settings-body');

    requireEl('settings-close').addEventListener('click', () => this.close());
    requireEl('settings-reset').addEventListener('click', () => {
      this.settings.reset();
      this.render();
    });

    // Rebinding listens at the capture phase so nothing else sees the key.
    window.addEventListener(
      'keydown',
      (event) => {
        if (!this.capturing) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.code !== 'Escape') this.settings.rebind(this.capturing, event.code);
        this.capturing = null;
        this.onCaptureChange?.(false);
        this.render();
      },
      true,
    );
  }

  get open(): boolean {
    return this.root.classList.contains('open');
  }

  toggle(): boolean {
    if (this.open) this.close();
    else this.show();
    return this.open;
  }

  show(): void {
    this.render();
    this.root.classList.add('open');
    this.onVisibilityChange?.(true);
  }

  close(): void {
    this.capturing = null;
    this.onCaptureChange?.(false);
    this.root.classList.remove('open');
    this.onVisibilityChange?.(false);
  }

  private render(): void {
    this.body.replaceChildren();
    const data = this.settings.data;

    const game = this.section('Game');
    game.appendChild(
      this.choice(
        'Difficulty',
        Object.keys(DIFFICULTIES) as DifficultyId[],
        data.difficulty,
        (id) => DIFFICULTIES[id].label,
        (id) => this.settings.set('difficulty', id),
      ),
    );
    const note = document.createElement('div');
    note.className = 'settings-note';
    note.textContent = DIFFICULTIES[data.difficulty]?.blurb ?? '';
    game.appendChild(note);

    const controls = this.section('Controls');
    controls.appendChild(
      this.slider('Mouse sensitivity', data.mouseSensitivity, 0.2, 3, 0.05, (v) =>
        this.settings.set('mouseSensitivity', v),
      ),
    );
    controls.appendChild(
      this.slider('Stick sensitivity', data.stickSensitivity, 0.2, 3, 0.05, (v) =>
        this.settings.set('stickSensitivity', v),
      ),
    );
    controls.appendChild(
      this.toggle_('Invert vertical look', data.invertY, (v) => this.settings.set('invertY', v)),
    );

    const display = this.section('Display');
    display.appendChild(
      this.slider('Brightness', data.brightness, 0.8, 1.6, 0.05, (v) =>
        this.settings.set('brightness', v),
      ),
    );
    display.appendChild(
      this.slider('Field of view', data.fov, 50, 110, 1, (v) => this.settings.set('fov', v), '°'),
    );
    display.appendChild(
      this.toggle_('Shadows', data.shadows, (v) => this.settings.set('shadows', v)),
    );
    display.appendChild(
      this.toggle_('Speed lines', data.speedLines, (v) => this.settings.set('speedLines', v)),
    );

    const audio = this.section('Audio');
    audio.appendChild(
      this.toggle_('Sound effects', data.sfx, (v) => this.settings.set('sfx', v)),
    );
    audio.appendChild(
      this.slider('Effects volume', data.sfxVolume, 0, 1, 0.05, (v) =>
        this.settings.set('sfxVolume', v),
      ),
    );
    audio.appendChild(this.toggle_('Spoken barks', data.barks, (v) => this.settings.set('barks', v)));
    audio.appendChild(
      this.slider('Bark volume', data.barkVolume, 0, 1, 0.05, (v) =>
        this.settings.set('barkVolume', v),
      ),
    );

    const binds = this.section('Key bindings');
    for (const action of Object.keys(ACTION_LABELS) as BindableAction[]) {
      binds.appendChild(this.bindRow(action));
    }
  }

  private section(title: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'settings-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    wrapper.appendChild(heading);
    this.body.appendChild(wrapper);
    return wrapper;
  }

  private row(label: string): { row: HTMLElement; value: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const name = document.createElement('span');
    name.className = 'settings-label';
    name.textContent = label;
    const value = document.createElement('span');
    value.className = 'settings-value';
    row.append(name, value);
    return { row, value };
  }

  private slider(
    label: string,
    initial: number,
    min: number,
    max: number,
    step: number,
    onInput: (value: number) => void,
    suffix = '',
  ): HTMLElement {
    const { row, value } = this.row(label);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);

    const readout = (v: number): string => (step >= 1 ? v.toFixed(0) : v.toFixed(2)) + suffix;
    value.textContent = readout(initial);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      value.textContent = readout(v);
      onInput(v);
    });

    value.before(input);
    return row;
  }

  /** Cycles through a fixed list of options on click. */
  private choice<T extends string>(
    label: string,
    options: readonly T[],
    initial: T,
    display: (value: T) => string,
    onChange: (value: T) => void,
  ): HTMLElement {
    const { row, value } = this.row(label);
    const button = document.createElement('button');
    button.className = 'settings-toggle on';
    let index = Math.max(0, options.indexOf(initial));
    button.textContent = display(options[index]!);
    button.addEventListener('click', () => {
      index = (index + 1) % options.length;
      const picked = options[index]!;
      button.textContent = display(picked);
      onChange(picked);
      // Re-render so any dependent blurb updates with the choice.
      this.render();
    });
    value.appendChild(button);
    return row;
  }

  private toggle_(label: string, initial: boolean, onChange: (value: boolean) => void): HTMLElement {
    const { row, value } = this.row(label);
    const button = document.createElement('button');
    button.className = 'settings-toggle';
    const paint = (on: boolean): void => {
      button.textContent = on ? 'ON' : 'OFF';
      button.classList.toggle('on', on);
    };
    let state = initial;
    paint(state);
    button.addEventListener('click', () => {
      state = !state;
      paint(state);
      onChange(state);
    });
    value.replaceWith(button);
    return row;
  }

  private bindRow(action: BindableAction): HTMLElement {
    const { row, value } = this.row(ACTION_LABELS[action]);
    const button = document.createElement('button');
    button.className = 'settings-bind';
    const code = this.settings.binding(action);
    button.textContent = this.capturing === action ? 'PRESS A KEY…' : Settings.keyLabel(code);
    if (this.capturing === action) button.classList.add('capturing');

    button.addEventListener('click', () => {
      this.capturing = action;
      this.onCaptureChange?.(true);
      this.render();
    });

    value.replaceWith(button);
    return row;
  }
}

function requireEl(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Settings element #${id} is missing from index.html`);
  return node;
}
