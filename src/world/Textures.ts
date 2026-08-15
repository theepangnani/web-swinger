import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import type { Rng } from '../core/MathUtils';
import { clamp, randRange } from '../core/MathUtils';

export interface FacadeTextures {
  /** Albedo: base wall + window glass. */
  map: THREE.CanvasTexture;
  /** Emissive: only the lit windows, everything else black. */
  emissive: THREE.CanvasTexture;
}

interface FacadePalette {
  wall: string;
  wallDark: string;
  mullion: string;
  glassOff: string;
  litColors: string[];
  litChance: number;
}

const FACADE_PALETTES: FacadePalette[] = [
  {
    wall: '#242a38',
    wallDark: '#161a24',
    mullion: '#10131b',
    glassOff: '#0d1119',
    litColors: ['#ffe0a3', '#ffd27a', '#fff1cf', '#ffc766'],
    litChance: 0.42,
  },
  {
    wall: '#3a3128',
    wallDark: '#241e18',
    mullion: '#171310',
    glassOff: '#12100e',
    litColors: ['#ffd9a0', '#ffbe63', '#ffeccb'],
    litChance: 0.34,
  },
  {
    wall: '#1d2a3a',
    wallDark: '#101822',
    mullion: '#0b1017',
    glassOff: '#0b1522',
    litColors: ['#bfe4ff', '#e8f6ff', '#8fd0ff', '#ffe9b8'],
    litChance: 0.5,
  },
  {
    wall: '#2e3036',
    wallDark: '#1b1c20',
    mullion: '#111215',
    glassOff: '#0e0f12',
    litColors: ['#fff3d6', '#ffcf8a', '#d9f0ff'],
    litChance: 0.3,
  },
];

/**
 * Builds every texture in the game from a 2D canvas at runtime — no image
 * files, no network fetches, so the build is entirely self-contained.
 */
export class TextureFactory {
  private readonly anisotropy: number;
  private readonly owned: THREE.Texture[] = [];

  constructor(maxAnisotropy = 4) {
    this.anisotropy = clamp(maxAnisotropy, 1, 16);
  }

  get variantCount(): number {
    return FACADE_PALETTES.length;
  }

  /**
   * Facade albedo + emissive pair. Both canvases are painted from the same RNG
   * walk, so a window that is drawn lit in the albedo glows in the emissive.
   */
  facade(rng: Rng, variant: number): FacadeTextures {
    const palette = FACADE_PALETTES[variant % FACADE_PALETTES.length]!;
    const size = 512;
    const cols = CONFIG.city.windowsPerTileX;
    const rows = CONFIG.city.windowsPerTileY;
    const cw = size / cols;
    const chh = size / rows;

    const { canvas: albedo, ctx } = createCanvas(size);
    const { canvas: glow, ctx: gctx } = createCanvas(size);

    // Wall base with a soft vertical gradient so tiles don't read as flat.
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, palette.wall);
    grad.addColorStop(1, palette.wallDark);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    gctx.fillStyle = '#000000';
    gctx.fillRect(0, 0, size, size);

    speckle(ctx, size, rng, 0.06);

    const insetX = cw * 0.19;
    const insetY = chh * 0.16;
    const winW = cw - insetX * 2;
    const winH = chh * 0.58;

    for (let row = 0; row < rows; row++) {
      const cellY = row * chh;

      // Spandrel: the solid band between floors.
      ctx.fillStyle = palette.mullion;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, cellY + chh - insetY * 0.8, size, insetY * 0.8);
      ctx.globalAlpha = 1;

      for (let col = 0; col < cols; col++) {
        const x = col * cw + insetX;
        const y = cellY + insetY;

        const lit = rng() < palette.litChance;
        if (lit) {
          const color = palette.litColors[Math.floor(rng() * palette.litColors.length)]!;
          ctx.fillStyle = color;
          ctx.fillRect(x, y, winW, winH);

          // Interior silhouette: a darker sliver so lit rooms aren't flat.
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          const sh = winH * randRange(rng, 0.15, 0.45);
          ctx.fillRect(x, y + winH - sh, winW, sh);

          gctx.save();
          gctx.shadowColor = color;
          gctx.shadowBlur = 10;
          gctx.fillStyle = color;
          gctx.globalAlpha = randRange(rng, 0.72, 1);
          gctx.fillRect(x, y, winW, winH);
          gctx.restore();
        } else {
          // Unlit glass: dark, with a faint sky reflection at the top.
          ctx.fillStyle = palette.glassOff;
          ctx.fillRect(x, y, winW, winH);
          ctx.fillStyle = 'rgba(120,170,220,0.10)';
          ctx.fillRect(x, y, winW, winH * 0.32);
        }

        // Mullion between panes.
        ctx.strokeStyle = palette.mullion;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, winW - 1, winH - 1);
      }
    }

    // Grime streaks running down the facade.
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#000000';
    for (let i = 0; i < 26; i++) {
      const x = rng() * size;
      const w = randRange(rng, 1, 5);
      const y = rng() * size * 0.6;
      ctx.fillRect(x, y, w, size - y);
    }
    ctx.globalAlpha = 1;

    return {
      map: this.finish(albedo, true),
      emissive: this.finish(glow, true),
    };
  }

  /** Gravel roof with vents, patches and edge staining. */
  roof(rng: Rng): THREE.CanvasTexture {
    const size = 256;
    const { canvas, ctx } = createCanvas(size);
    ctx.fillStyle = '#2b2b2f';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rng, 0.22);

    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = rng() > 0.5 ? '#3a3a40' : '#202024';
      const w = randRange(rng, 12, 60);
      const h = randRange(rng, 12, 60);
      ctx.fillRect(rng() * size, rng() * size, w, h);
    }
    ctx.globalAlpha = 1;

    // Tar seams.
    ctx.strokeStyle = '#191a1e';
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const y = (i + 0.5) * (size / 5);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y + randRange(rng, -6, 6));
      ctx.stroke();
    }
    return this.finish(canvas, true);
  }

  /** Road surface. Lane markings are separate geometry so they align exactly. */
  asphalt(rng: Rng): THREE.CanvasTexture {
    const size = 256;
    const { canvas, ctx } = createCanvas(size);
    ctx.fillStyle = '#191a1d';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rng, 0.3);

    ctx.globalAlpha = 0.25;
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = rng() > 0.5 ? '#232428' : '#121316';
      ctx.beginPath();
      ctx.ellipse(rng() * size, rng() * size, randRange(rng, 3, 22), randRange(rng, 2, 10), rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return this.finish(canvas, true);
  }

  /** Sidewalk / plaza concrete with a paving grid. */
  concrete(rng: Rng): THREE.CanvasTexture {
    const size = 256;
    const { canvas, ctx } = createCanvas(size);
    ctx.fillStyle = '#4a4a50';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rng, 0.16);

    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    const step = size / 4;
    for (let i = 0; i <= 4; i++) {
      const p = i * step;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
    return this.finish(canvas, true);
  }

  dispose(): void {
    for (const t of this.owned) t.dispose();
    this.owned.length = 0;
  }

  private finish(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.anisotropy;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.owned.push(tex);
    return tex;
  }
}

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot generate textures.');
  return { canvas, ctx };
}

/** Cheap per-pixel grain, applied straight to the backing ImageData. */
function speckle(ctx: CanvasRenderingContext2D, size: number, rng: Rng, strength: number): void {
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rng() - 0.5) * 255 * strength;
    data[i] = clamp(data[i]! + n, 0, 255);
    data[i + 1] = clamp(data[i + 1]! + n, 0, 255);
    data[i + 2] = clamp(data[i + 2]! + n, 0, 255);
  }
  ctx.putImageData(image, 0, 0);
}
