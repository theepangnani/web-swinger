import * as THREE from 'three';

let webTexture: THREE.CanvasTexture | null = null;

/**
 * The web strand texture: a bright centre filament with criss-crossing side
 * strands, drawn on transparent alpha and tiled along the line's length.
 *
 * This is what makes a web line read as *webbing* rather than as a rope. A
 * tube — however many strands you twist together — still silhouettes as a
 * smooth cylinder. A flat, camera-facing ribbon carrying an actual lattice
 * pattern silhouettes as silk.
 */
export function getWebTexture(): THREE.CanvasTexture {
  if (webTexture) return webTexture;

  const w = 64;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot build web texture.');

  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';

  // Two criss-crossing strands running the length of the ribbon.
  const cross = 4;
  const step = h / cross;
  ctx.lineWidth = 3;
  for (let i = 0; i < cross; i++) {
    const y0 = i * step;
    ctx.beginPath();
    ctx.moveTo(w * 0.16, y0);
    ctx.lineTo(w * 0.84, y0 + step);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w * 0.84, y0);
    ctx.lineTo(w * 0.16, y0 + step);
    ctx.stroke();
  }

  // Bright core filament.
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.moveTo(w * 0.5, 0);
  ctx.lineTo(w * 0.5, h);
  ctx.stroke();

  // Slack cross-ties where the strands meet.
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i <= cross; i++) {
    const y = i * step;
    ctx.beginPath();
    ctx.moveTo(w * 0.16, y);
    ctx.lineTo(w * 0.84, y);
    ctx.stroke();
  }

  webTexture = new THREE.CanvasTexture(canvas);
  webTexture.wrapS = THREE.ClampToEdgeWrapping;
  webTexture.wrapT = THREE.RepeatWrapping;
  webTexture.colorSpace = THREE.SRGBColorSpace;
  webTexture.needsUpdate = true;
  return webTexture;
}

/**
 * A camera-facing ribbon strip rebuilt each frame from the rope's points.
 * Vertex and index buffers are allocated once.
 */
export class WebRibbon {
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly width: number;
  private readonly segments: number;

  private readonly tangent = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly side = new THREE.Vector3();

  private readonly uvs: Float32Array;
  private readonly tilesPerMetre: number;

  constructor(segments: number, width: number, opacity: number, tilesPerMetre: number) {
    this.segments = segments;
    this.width = width;
    this.tilesPerMetre = tilesPerMetre;

    const rings = segments + 1;
    this.positions = new Float32Array(rings * 2 * 3);
    const uvs = new Float32Array(rings * 2 * 2);
    this.uvs = uvs;
    const indices: number[] = [];

    for (let i = 0; i < rings; i++) {
      uvs[i * 4] = 0;
      uvs[i * 4 + 2] = 1;
    }
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);

    this.material = new THREE.MeshBasicMaterial({
      map: getWebTexture(),
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      alphaTest: 0.02,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // The line spans arbitrary distances; a stale bounding sphere would make
    // it flicker out of the frustum mid-swing.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 3;
  }

  /** Rebuilds the strip so it always faces `cameraPos`. */
  update(points: THREE.Vector3[], cameraPos: THREE.Vector3): void {
    const rings = Math.min(points.length, this.segments + 1);

    // Tile the weave by real length rather than by a fixed count, so the
    // pattern is the same physical size on a 15 m line and a 140 m one.
    let travelled = 0;
    for (let i = 0; i < rings; i++) {
      if (i > 0) travelled += points[i]!.distanceTo(points[i - 1]!);
      const v = travelled * this.tilesPerMetre;
      this.uvs[i * 4 + 1] = v;
      this.uvs[i * 4 + 3] = v;
    }
    (this.geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;

    for (let i = 0; i < rings; i++) {
      const p = points[i]!;
      const a = points[Math.max(0, i - 1)]!;
      const b = points[Math.min(rings - 1, i + 1)]!;

      this.tangent.copy(b).sub(a);
      if (this.tangent.lengthSq() < 1e-10) this.tangent.set(0, 1, 0);
      this.tangent.normalize();

      // Billboard: the ribbon's width axis is perpendicular to both the line
      // and the view direction, so it never turns edge-on and disappears.
      this.toCamera.copy(cameraPos).sub(p);
      this.side.crossVectors(this.tangent, this.toCamera);
      if (this.side.lengthSq() < 1e-10) this.side.set(1, 0, 0);
      this.side.normalize();

      // Silk tapers only slightly; too much taper reads as a fraying thread.
      const t = rings > 1 ? i / (rings - 1) : 0;
      const halfWidth = this.width * (0.72 + 0.4 * t) * 0.5;

      const base = i * 6;
      this.positions[base] = p.x - this.side.x * halfWidth;
      this.positions[base + 1] = p.y - this.side.y * halfWidth;
      this.positions[base + 2] = p.z - this.side.z * halfWidth;
      this.positions[base + 3] = p.x + this.side.x * halfWidth;
      this.positions[base + 4] = p.y + this.side.y * halfWidth;
      this.positions[base + 5] = p.z + this.side.z * halfWidth;
    }

    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
