import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { clamp, damp, smoothstep } from '../core/MathUtils';

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Radial streaks in polar space. Each angular "lane" gets its own random
 * phase and speed, so the field reads as motion rather than a spinning wheel.
 */
const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;
uniform float uIntensity;
uniform float uTime;
uniform float uAspect;
uniform vec3 uColor;

float hash(float n) {
  return fract(sin(n * 127.1) * 43758.5453123);
}

void main() {
  if (uIntensity <= 0.001) discard;

  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x);

  const float LANES = 150.0;
  float lane = floor((a / 6.2831853 + 0.5) * LANES);

  float r1 = hash(lane);
  float r2 = hash(lane + 37.0);
  float r3 = hash(lane + 91.0);

  // Only the fastest lanes light up at low intensity.
  if (r3 > uIntensity * 1.35) discard;

  float speed = 0.9 + r1 * 2.4;
  float len = 0.08 + r2 * 0.26;
  float phase = fract(r1 * 13.0 + uTime * speed);
  float start = mix(0.10, 0.85, phase);

  float head = smoothstep(start, start + 0.015, r);
  float tail = 1.0 - smoothstep(start + len, start + len + 0.05, r);
  float streak = head * tail;

  // Fade the middle of the screen so the player stays readable.
  float radialMask = smoothstep(0.10, 0.48, r);

  float alpha = streak * radialMask * uIntensity * (0.3 + 0.7 * r2);
  if (alpha <= 0.002) discard;

  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * A full-screen additive overlay drawn after the main scene. Cheaper and more
 * robust than a post-processing chain, and it needs no extra render targets.
 */
export class SpeedLines {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private intensity = 0;
  private time = 0;

  constructor(aspect: number) {
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uIntensity: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: aspect },
        uColor: { value: new THREE.Color(0xdfefff) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(this.geometry, this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Maps player speed to overlay strength. */
  update(dt: number, speed: number): void {
    this.time += dt;
    const target = smoothstep(CONFIG.fx.speedLineRef * 0.35, CONFIG.fx.speedLineRef, speed) * CONFIG.fx.speedLineMax;
    this.intensity = damp(this.intensity, target, 7, dt);
    this.material.uniforms.uIntensity!.value = clamp(this.intensity, 0, 1);
    this.material.uniforms.uTime!.value = this.time;
  }

  /** 0..1, so the DOM vignette can be driven from the same signal. */
  get strength(): number {
    return clamp(this.intensity, 0, 1);
  }

  setAspect(aspect: number): void {
    this.material.uniforms.uAspect!.value = aspect;
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (this.intensity <= 0.002) return;
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
