import { Game } from './Game';
import { loadOsmCity } from './world/OsmData';

/**
 * Refuses to run inside another site's frame.
 *
 * The `frame-ancestors` and `X-Frame-Options` headers in `public/_headers` are
 * the real defence, but they only exist if the site is deployed somewhere that
 * reads that file. This is the part that travels with the build: without it,
 * anyone can iframe the game into their own page, wrap it in their own
 * advertising and never host a byte of it — the cheapest way there is to steal
 * something that runs in a browser.
 *
 * Reading `window.top` across origins throws, and that throw is itself the
 * answer: only a cross-origin embed can raise it.
 */
function framed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/**
 * Boot entry point. Everything that can fail before the Game exists — missing
 * DOM nodes, no WebGL — is reported into the overlay rather than left as a
 * blank black screen.
 */

function reportFatal(headline: string, detail?: unknown): void {
  const overlay = document.getElementById('overlay');
  const message = document.getElementById('overlay-msg');
  const cta = document.getElementById('overlay-cta');

  if (message) message.innerHTML = headline;
  if (cta) cta.textContent = 'UNABLE TO START';
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.cursor = 'default';
    if (detail !== undefined) {
      const pre = document.createElement('pre');
      pre.textContent = detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail);
      overlay.appendChild(pre);
    }
  }
  console.error(headline, detail);
}

function hasWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    return Boolean(
      probe.getContext('webgl2') ??
        probe.getContext('webgl') ??
        probe.getContext('experimental-webgl'),
    );
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  if (framed()) {
    reportFatal(
      'This game does not run inside another site.<br>' +
        'Open it directly and it will start normally.',
    );
    return;
  }

  const container = document.getElementById('canvas-container');
  if (!container) {
    reportFatal('Missing <code>#canvas-container</code> in index.html.');
    return;
  }

  if (!hasWebGL()) {
    reportFatal(
      'WebGL is not available in this browser.<br>' +
        'Enable hardware acceleration, or try a recent Chrome, Edge, Firefox or Safari.',
    );
    return;
  }

  try {
    // Real OpenStreetMap footprints if they have been imported, otherwise the
    // procedural skyline. See scripts/fetch-osm.py.
    const osm = await loadOsmCity('./city/osm-city.json');
    const game = new Game(container, osm);
    // Handy for tuning from the console; harmless in production.
    (window as unknown as Record<string, unknown>).game = game;
  } catch (error) {
    reportFatal('The game failed to start.', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}
