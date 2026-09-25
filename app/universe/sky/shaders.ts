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
  uniform float uSpriteScale;
  uniform float uFocalPixels;
  uniform float uGain;
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

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Soft sprites sized by each point's smoothing length (Blender export:
    // radius = size * sizeScale in galaxy units). uSpriteScale also grows the
    // sprites when fewer points are drawn, so surface brightness is conserved
    // at every level of detail. Sub-pixel sprites keep a one-pixel footprint
    // and dim by the lost area, conserving flux at a distance.
    float diameter = 2.0 * size * uSpriteScale * uFocalPixels / max(0.001, -mv.z);
    float coverage = 1.0;
    if (diameter < 1.0) {
      coverage = max(diameter * diameter, 0.002);
      diameter = 1.0;
    }
    gl_PointSize = min(diameter, 48.0);
    vColor = isDust ? vec3(1.0) - color : color;
    vAlpha = isDust ? 0.45 * coverage : coverage * uGain * uBrightness;
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
    float profile = exp(-r2 * 3.0) - 0.0498;
    // Emitters add light; dust multiplies the frame by its transmission.
    gl_FragColor = vec4(vColor * vAlpha * profile, 1.0);
  }
`;

export const DEEP_FIELD_VERTEX = /* glsl */ `
  attribute vec3 color;
  attribute float size;
  attribute float population;
  attribute float extra;

  uniform float uSpriteScale;
  uniform float uFocalPixels;

  varying vec3 vColor;
  varying float vKind;
  varying float vAxis;
  varying float vAngle;
  varying float vAlpha;

  void main() {
    vec3 direction = normalize(position);
    vec4 mv = modelViewMatrix * vec4(direction * 900.0, 1.0);
    gl_Position = projectionMatrix * mv;
    // Angular sizes are fixed on the sky: radius (radians) = size * sizeScale.
    float diameter = 2.0 * size * uSpriteScale * uFocalPixels;
    float kind = 0.0;
    if (population > 6.5) {
      bool spikes = mod(extra, 2.0) > 0.5;
      kind = spikes ? 1.0 : 0.0;
      diameter = max(diameter, 1.5) * (spikes ? 9.0 : 2.2);
    } else {
      float subtype = mod(extra, 4.0);
      float axisClass = mod(floor(extra / 4.0), 4.0);
      kind = subtype > 0.5 && subtype < 2.5 ? 3.0 : 2.0;
      vAxis = 0.3 + 0.2 * axisClass;
      vAngle = floor(extra / 16.0) * 3.14159265 / 16.0;
      diameter *= 2.4;
    }
    float coverage = 1.0;
    if (diameter < 1.0) {
      coverage = max(diameter * diameter, 0.05);
      diameter = 1.0;
    }
    gl_PointSize = min(diameter, 72.0);
    vKind = kind;
    vColor = color;
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
      light = exp(-dot(q, q) * 7.0);
    } else if (vKind < 1.5) {
      // Bright foreground star with six diffraction spikes (segmented
      // hexagonal primary) and a faint horizontal spike (secondary support).
      float r = length(q);
      float core = exp(-r * r * 160.0) + 0.2 * exp(-r * r * 30.0);
      float spikes = 0.0;
      for (int k = 0; k < 3; k++) {
        float a = float(k) * 1.0471976 + 1.5707963;
        vec2 d = vec2(cos(a), sin(a));
        float along = abs(dot(q, d));
        float across = abs(dot(q, vec2(-d.y, d.x)));
        spikes += exp(-across * 90.0) * pow(1.0 - min(1.0, along), 3.0);
      }
      float horizontal = exp(-abs(q.y) * 120.0) * pow(1.0 - min(1.0, abs(q.x) * 1.4), 3.0) * 0.4;
      light = core + 0.6 * spikes + horizontal;
    } else {
      // Distant galaxy: inclined disc (exponential) or spheroid (Sersic-like).
      float c = cos(vAngle);
      float s = sin(vAngle);
      vec2 p = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
      p.y /= vAxis;
      float r = length(p);
      light = vKind > 2.5 ? exp(-pow(r * 3.0, 0.5) * 3.2) * 1.5 : exp(-r * 4.5);
    }
    if (light < 0.003) discard;
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
    float pixels = (20.0 + size * 14.0 + highlight * 14.0) * uPixelRatio;
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
    // A thin marker ring keeps every paper identifiable against bright
    // galaxy light; it brightens when hovered or selected.
    float ring = smoothstep(0.07, 0.0, abs(r - 0.78)) * (0.3 + 0.7 * vHighlight);
    float light = core + halo + cross;
    vec3 rgb = vColor * light + mix(vColor, vec3(0.62, 0.8, 1.0), vHighlight) * ring;
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
