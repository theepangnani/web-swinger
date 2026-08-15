import * as THREE from 'three';

/**
 * Procedural suit surfacing.
 *
 * The web pattern is drawn once as a neutral white-with-dark-lines albedo, so a
 * single texture serves every suit — `material.color` supplies the hue. A
 * matching normal map is derived from the same pattern via Sobel, which is what
 * actually sells the raised webbing under moving light.
 */

interface SuitMaps {
  web: THREE.CanvasTexture;
  webNormal: THREE.CanvasTexture;
  webRough: THREE.CanvasTexture;
  panel: THREE.CanvasTexture;
  panelNormal: THREE.CanvasTexture;
}

let cached: SuitMaps | null = null;

export function getSuitMaps(): SuitMaps {
  if (cached) return cached;

  const size = 512;
  const webHeight = drawWebHeight(size);
  const panelHeight = drawPanelHeight(size);

  cached = {
    web: toTexture(drawWebAlbedo(size), true),
    webNormal: toTexture(heightToNormal(webHeight), false),
    webRough: toTexture(heightToRoughness(webHeight, 0.32, 0.62), false),
    panel: toTexture(drawPanelAlbedo(size), true),
    panelNormal: toTexture(heightToNormal(panelHeight), false),
  };
  return cached;
}

/** A tinted clone, so different body parts can tile at different densities. */
export function tiled(texture: THREE.CanvasTexture, u: number, v: number): THREE.Texture {
  const clone = texture.clone();
  clone.wrapS = THREE.RepeatWrapping;
  clone.wrapT = THREE.RepeatWrapping;
  clone.repeat.set(u, v);
  clone.needsUpdate = true;
  return clone;
}

// ------------------------------------------------------------------ drawing

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot build suit textures.');
  return { canvas, ctx };
}

/**
 * Seamless web net: a diamond lattice whose strands sag toward each cell
 * centre, which reads much more like woven webbing than straight lines.
 */
function strokeWeb(ctx: CanvasRenderingContext2D, size: number, width: number): void {
  const cells = 6;
  const step = size / cells;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';

  // Diagonal strands in both directions, wrapping past the edges so it tiles.
  for (let i = -cells; i <= cells * 2; i++) {
    for (const dir of [1, -1]) {
      ctx.beginPath();
      for (let j = 0; j <= cells * 2; j++) {
        const x = j * step * 0.5;
        const y = (i * step) + dir * x;
        const sag = Math.sin((j / (cells * 2)) * Math.PI) * step * 0.14;
        if (j === 0) ctx.moveTo(x, y + sag);
        else ctx.lineTo(x, y + sag);
      }
      ctx.stroke();
    }
  }

  // Cross-strands tying the lattice together.
  for (let i = 0; i <= cells * 2; i++) {
    const y = i * step * 0.5;
    ctx.beginPath();
    for (let j = 0; j <= cells * 4; j++) {
      const x = (j / (cells * 4)) * size;
      const wave = Math.sin((x / size) * Math.PI * cells) * step * 0.1;
      if (j === 0) ctx.moveTo(x, y + wave);
      else ctx.lineTo(x, y + wave);
    }
    ctx.stroke();
  }
}

function drawWebAlbedo(size: number): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(size);
  // White base: the material's own colour tints this.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Fabric grain.
  const grain = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < grain.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    grain.data[i] = clamp255(grain.data[i]! + n);
    grain.data[i + 1] = clamp255(grain.data[i + 1]! + n);
    grain.data[i + 2] = clamp255(grain.data[i + 2]! + n);
  }
  ctx.putImageData(grain, 0, 0);

  // Webbing: a dark line, then a lighter highlight just off it for relief.
  ctx.strokeStyle = 'rgba(20,20,26,0.85)';
  strokeWeb(ctx, size, 3.2);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.translate(0, -1.4);
  strokeWeb(ctx, size, 1.1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return canvas;
}

function drawWebHeight(size: number): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#ffffff';
  strokeWeb(ctx, size, 3.4);
  return canvas;
}

/** Miles' suit: panel seams rather than webbing. */
function drawPanelAlbedo(size: number): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 2.4;
  const cells = 4;
  const step = size / cells;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step + step * 0.28);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step - step * 0.18, size);
    ctx.stroke();
  }

  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#000000';
  for (let i = 0; i < 60; i++) {
    const w = 6 + Math.random() * 40;
    ctx.fillRect(Math.random() * size, Math.random() * size, w, 2);
  }
  ctx.globalAlpha = 1;
  return canvas;
}

function drawPanelHeight(size: number): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#8a8a8a';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 3;
  const cells = 4;
  const step = size / cells;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step + step * 0.28);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step - step * 0.18, size);
    ctx.stroke();
  }
  return canvas;
}

// ------------------------------------------------------------- conversions

/** Sobel gradient of a greyscale height field into a tangent-space normal map. */
function heightToNormal(height: HTMLCanvasElement): HTMLCanvasElement {
  const size = height.width;
  const src = height.getContext('2d')!.getImageData(0, 0, size, size).data;
  const { canvas, ctx } = createCanvas(size);
  const out = ctx.createImageData(size, size);

  const at = (x: number, y: number): number => {
    // Wrap, so the normal map tiles as seamlessly as the albedo.
    const xi = ((x % size) + size) % size;
    const yi = ((y % size) + size) % size;
    return src[(yi * size + xi) * 4]! / 255;
  };

  const strength = 2.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;

      const i = (y * size + x) * 4;
      out.data[i] = (nx * 0.5 + 0.5) * 255;
      out.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      out.data[i + 2] = (nz / len) * 0.5 * 255 + 127.5;
      out.data[i + 3] = 255;
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** Raised webbing is glossier than the surrounding fabric. */
function heightToRoughness(height: HTMLCanvasElement, low: number, high: number): HTMLCanvasElement {
  const size = height.width;
  const src = height.getContext('2d')!.getImageData(0, 0, size, size);
  const { canvas, ctx } = createCanvas(size);
  const out = ctx.createImageData(size, size);

  for (let i = 0; i < src.data.length; i += 4) {
    const h = src.data[i]! / 255;
    const rough = (high + (low - high) * h) * 255;
    out.data[i] = rough;
    out.data[i + 1] = rough;
    out.data[i + 2] = rough;
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
