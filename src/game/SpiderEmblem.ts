import * as THREE from 'three';

let cached: THREE.CanvasTexture | null = null;

/**
 * A white spider silhouette on transparent alpha, drawn once and shared.
 * Meshes tint it via `material.color`, so Peter gets white, Miles red and
 * Venom the oversized white emblem.
 */
export function getSpiderTexture(): THREE.CanvasTexture {
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot draw emblem.');

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';

  const cx = size / 2;
  const cy = size / 2;

  // Abdomen and thorax.
  ctx.beginPath();
  ctx.ellipse(cx, cy + 20, 9, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy - 10, 7, 13, 0, 0, Math.PI * 2);
  ctx.fill();

  // Four legs per side, sweeping outward from the thorax.
  const legs: Array<[number, number, number]> = [
    [-0.4, -34, 6],
    [-0.1, -46, 5],
    [0.25, -44, 5],
    [0.6, -30, 4],
  ];
  for (const side of [-1, 1]) {
    for (const [bend, reach, width] of legs) {
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6 + bend * 26);
      ctx.quadraticCurveTo(
        cx + side * Math.abs(reach) * 0.6,
        cy - 6 + bend * 26 - 14,
        cx + side * Math.abs(reach),
        cy - 6 + bend * 40,
      );
      ctx.stroke();
    }
  }

  cached = new THREE.CanvasTexture(canvas);
  cached.colorSpace = THREE.SRGBColorSpace;
  cached.needsUpdate = true;
  return cached;
}

/** A double-sided emblem decal ready to parent onto a chest or back. */
export function createEmblemMesh(color: number, scale: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(scale, scale);
  const material = new THREE.MeshBasicMaterial({
    map: getSpiderTexture(),
    color,
    transparent: true,
    alphaTest: 0.35,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  return new THREE.Mesh(geometry, material);
}
