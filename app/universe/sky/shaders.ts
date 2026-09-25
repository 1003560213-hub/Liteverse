/**
 * GLSL for the Deep Universe renderer. All programs use additive light
 * transport except the dust pass, which multiplies the frame buffer by a
 * transmission factor. Point sizes that fall below one device pixel keep a
 * one-pixel footprint and dim by the lost area, so distant galaxies keep their
 * integrated brightness instead of flickering or blooming.
 */

export const GALAXY_VERTEX = /* glsl */ `
  attribute vec3 color;
  attribute float size;
  attribute float population;

  uniform float uTime;
  uniform float uSpin;
  uniform float uRotation;
  uniform float uPointPixels;
  uniform float uAlphaScale;
  uniform float uBrightness;
  uniform float uDustPass;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    bool isDust = population > 3.5 && population < 4.5;
    if ((uDustPass > 0.5) != isDust) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec3 p = position;
    // Differential rotation with a softened flat rotation curve:
    // Omega(R) = v0 / sqrt(R^2 + Rc^2), in units of the galaxy radius.
    float R = length(p.xz);
    float omega = uRotation / sqrt(R * R + 0.0225);
    float angle = uTime * uSpin * omega;
    float c = cos(angle);
    float s = sin(angle);
    p.xz = mat2(c, -s, s, c) * p.xz;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    // Stars are unresolved: a fixed small screen footprint. Surface
    // brightness is conserved by uAlphaScale (computed on the CPU from the
    // galaxy's projected area and the number of points drawn), so a galaxy
    // keeps the same surface brightness at any distance or level of detail.
    float relative = 0.55 + size * 1.1;
    if (population > 4.5) relative *= 1.6;
    float pixels = uPointPixels * relative;
    gl_PointSize = clamp(pixels, 1.0, 9.0);
    float footprint = max(1.0, gl_PointSize * gl_PointSize * 0.45);
    float intensity = population > 4.5 ? 1.6 : population > 2.5 ? 1.25 : population > 1.5 ? 1.05 : population > 0.5 ? 0.8 : 0.9;
    vColor = color;
    float alpha = uAlphaScale * relative * relative / footprint;
    vAlpha = isDust ? min(0.8, alpha * 1.6) : min(1.0, alpha * intensity * uBrightness);
  }
`;

export const GALAXY_FRAGMENT = /* glsl */ `
  uniform float uDustPass;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    float profile = exp(-r2 * 4.0);
    if (uDustPass > 0.5) {
      gl_FragColor = vec4(vec3(vAlpha * profile), 1.0);
    } else {
      gl_FragColor = vec4(vColor * vAlpha * profile, 1.0);
    }
  }
`;

export const DEEP_FIELD_VERTEX = /* glsl */ `
  attribute vec3 color;
  attribute float size;
  attribute float population;
  attribute float extra;

  uniform float uPixelRatio;
  uniform float uViewportHeight;
  uniform float uFovScale;

  varying vec3 vColor;
  varying float vKind;
  varying float vAxis;
  varying float vAngle;
  varying float vAlpha;

  void main() {
    vec3 direction = normalize(position);
    vec4 mv = modelViewMatrix * vec4(direction * 900.0, 1.0);
    gl_Position = projectionMatrix * mv;
    // Angular sizes are fixed on the sky and scale with the field of view.
    float pixels = (0.8 + size * 7.0) * uPixelRatio * uFovScale;
    float kind = population;
    vKind = kind;
    // Foreground stars flagged for diffraction spikes get a larger sprite.
    if (kind > 0.5 && kind < 1.5) pixels *= 4.0;
    float coverage = 1.0;
    if (pixels < 1.0) {
      coverage = max(pixels * pixels, 0.05);
      pixels = 1.0;
    }
    gl_PointSize = min(pixels, 64.0);
    vColor = color;
    vAxis = 0.25 + 0.75 * fract(extra / 16.0);
    vAngle = floor(extra / 16.0) / 16.0 * 3.14159265;
    vAlpha = coverage;
  }
`;

export const DEEP_FIELD_FRAGMENT = /* glsl */ `
  uniform float uExposure;
  varying vec3 vColor;
  varying float vKind;
  varying float vAxis;
  varying float vAngle;
  varying float vAlpha;

  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float light = 0.0;
    if (vKind < 0.5) {
      // Faint field star: unresolved point-spread function.
      light = exp(-dot(q, q) * 6.0);
    } else if (vKind < 1.5) {
      // Bright foreground star with six-fold diffraction spikes, as produced
      // by a segmented hexagonal primary mirror, plus a faint horizontal
      // spike from the secondary support.
      float r = length(q);
      float core = exp(-r * r * 90.0) + 0.25 * exp(-r * r * 16.0);
      float spikes = 0.0;
      for (int k = 0; k < 3; k++) {
        float a = float(k) * 1.0471976 + 1.5707963;
        vec2 d = vec2(cos(a), sin(a));
        float along = abs(dot(q, d));
        float across = abs(dot(q, vec2(-d.y, d.x)));
        spikes += exp(-across * 70.0) * (1.0 - smoothstep(0.0, 1.0, along));
      }
      float horizontal = exp(-abs(q.y) * 90.0) * (1.0 - smoothstep(0.0, 0.7, abs(q.x))) * 0.45;
      light = core + 0.55 * spikes + horizontal;
    } else {
      // Distant galaxy: inclined exponential/Sersic-like disc.
      float c = cos(vAngle);
      float s = sin(vAngle);
      vec2 p = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
      p.y /= vAxis;
      float r = length(p);
      light = vKind > 2.5 ? exp(-pow(r * 3.2, 0.5) * 3.0) * 1.4 : exp(-r * 4.0);
    }
    if (light < 0.004) discard;
    gl_FragColor = vec4(vColor * light * vAlpha * uExposure, 1.0);
  }
`;

export const PAPER_STAR_VERTEX = /* glsl */ `
  attribute vec3 color;
  attribute float size;
  attribute float highlight;
  uniform float uPixelRatio;
  uniform float uTime;
  varying vec3 vColor;
  varying float vHighlight;

  void main() {
    if (size < -0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float pixels = (11.0 + size * 12.0 + highlight * 12.0) * uPixelRatio;
    gl_PointSize = pixels;
    vColor = color;
    vHighlight = highlight;
  }
`;

export const PAPER_STAR_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vHighlight;

  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r = length(q);
    float core = exp(-r * r * 26.0);
    float halo = exp(-r * r * 5.0) * 0.35;
    float cross = (exp(-abs(q.x) * 40.0) + exp(-abs(q.y) * 40.0)) * (1.0 - smoothstep(0.0, 1.0, r)) * 0.4;
    float ring = vHighlight > 0.0 ? smoothstep(0.08, 0.0, abs(r - 0.78)) * 0.85 * vHighlight : 0.0;
    float light = core + halo + cross;
    vec3 rgb = vColor * light + vec3(0.62, 0.8, 1.0) * ring;
    if (light + ring < 0.01) discard;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

export const HALO_VERTEX = /* glsl */ `
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = uv * 2.0 - 1.0;
    // Camera-facing billboard.
    vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 mv = center + vec4(position.xy * uSize, 0.0, 0.0);
    gl_Position = projectionMatrix * mv;
  }
`;

/** Diffuse intracluster light: exponential falloff, very faint, warm. */
export const HALO_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uOutline;
  uniform float uDashed;
  varying vec2 vUv;
  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    float icl = exp(-r * 4.2) * (1.0 - smoothstep(0.75, 1.0, r));
    float edge = smoothstep(0.012, 0.0, abs(r - 0.97)) * uOutline;
    if (uDashed > 0.5) {
      float angle = atan(vUv.y, vUv.x);
      edge *= step(0.5, fract(angle * 12.0));
    }
    vec3 rgb = uColor * icl * uIntensity + vec3(0.7, 0.8, 1.0) * edge * 0.55;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

export const ACCRETION_VERTEX = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Thin accretion disc seen at an angle: temperature T(r) ~ r^(-3/4)
 * (Shakura-Sunyaev far from the inner edge) mapped to a blackbody-like colour
 * ramp, with relativistic beaming brightening the approaching side.
 */
export const ACCRETION_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vPos;

  vec3 blackbody(float t) {
    // t in [0,1]: cool (orange) to hot (blue-white).
    return mix(vec3(1.0, 0.42, 0.12), mix(vec3(1.0, 0.86, 0.66), vec3(0.72, 0.84, 1.0), smoothstep(0.55, 1.0, t)), smoothstep(0.0, 0.6, t));
  }

  void main() {
    float r = length(vPos);
    float inner = 0.28;
    if (r < inner || r > 1.0) discard;
    float temperature = pow(inner / r, 0.75);
    float phi = atan(vPos.y, vPos.x) + uTime * 0.25 / (r * sqrt(r));
    float beaming = 1.0 + 0.55 * cos(atan(vPos.y, vPos.x));
    float turbulence = 0.82 + 0.18 * sin(phi * 9.0 + r * 30.0);
    float falloff = smoothstep(1.0, 0.7, r) * smoothstep(inner, inner + 0.05, r);
    vec3 rgb = blackbody(temperature) * temperature * temperature * beaming * turbulence * falloff * uIntensity;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

export const FILAMENT_VERTEX = /* glsl */ `
  attribute vec3 color;
  attribute float alpha;
  attribute float lineDistance;
  attribute float dashed;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDistance;
  varying float vDashed;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vDistance = lineDistance;
    vDashed = dashed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const FILAMENT_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDistance;
  varying float vDashed;
  void main() {
    if (vDashed > 0.5 && fract(vDistance * 5.0) > 0.55) discard;
    gl_FragColor = vec4(vColor * vAlpha * uOpacity, 1.0);
  }
`;
