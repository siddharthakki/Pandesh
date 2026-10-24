/**
 * Apex Shader Background — Animated WebGL "plasma waves" background.
 * Adapted from APEX-UI (https://github.com/RubenM1990/APEX-UI)
 * MIT License. See APEX_CREDITS.md for attribution.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.initApexShaderBackground = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const vsSource = `
    attribute vec4 aVertexPosition;
    void main() {
      gl_Position = aVertexPosition;
    }
  `;

  const fsSource = `
    precision highp float;
    uniform vec2 iResolution;
    uniform float iFlow;
    uniform float iVoiceIntensity;
    uniform float iGold;

    const float overallSpeed    = 0.08;
    const float gridSmoothWidth = 0.012;
    const float minLineWidth    = 0.004;
    const float maxLineWidth    = 0.024;
    const float lineSpeed       = 0.8 * overallSpeed;
    const float baseAmplitude   = 0.28;
    const float lineFrequency   = 0.12;
    const float warpSpeed       = 0.25 * overallSpeed;
    const float warpFrequency   = 0.35;
    const float warpAmplitude   = 0.75;
    const float offsetFrequency = 0.35;
    const float offsetSpeed     = 0.9 * overallSpeed;
    const float minOffsetSpread = 0.6;
    const float maxOffsetSpread = 1.8;
    const int   linesPerGroup   = 4;
    const float scale           = 4.5;

    #define drawCircle(pos, radius, coord) smoothstep(radius + gridSmoothWidth, radius, length(coord - (pos)))
    #define drawSmoothLine(pos, halfWidth, t) smoothstep(halfWidth, 0.0, abs(pos - (t)))
    #define drawCrispLine(pos, halfWidth, t) smoothstep(halfWidth + gridSmoothWidth, halfWidth, abs(pos - (t)))

    float random(float t) {
      return (cos(t) + cos(t * 1.3 + 1.3) + cos(t * 1.4 + 1.4)) / 3.0;
    }

    float getPlasmaY(float x, float horizontalFade, float offset, float amp) {
      return random(x * lineFrequency + iFlow * lineSpeed) * horizontalFade * amp + offset;
    }

    void main() {
      vec2 fragCoord = gl_FragCoord.xy;
      vec2 uv = fragCoord.xy / iResolution.xy;

      float voiceBoost = iVoiceIntensity;
      vec4 lineColorBase = mix(vec4(0.04, 0.36, 0.48, 1.0), vec4(0.48, 0.30, 0.05, 1.0), iGold);
      vec4 lineColorCool = mix(vec4(0.02, 0.20, 0.30, 1.0), vec4(0.32, 0.20, 0.03, 1.0), iGold);
      float lineAmplitude = baseAmplitude * (1.0 + voiceBoost * 1.4);
      float brightnessBoost = 0.65 + voiceBoost * 1.1;

      vec2 space = (fragCoord - iResolution.xy / 2.0) / iResolution.x * 2.0 * scale;

      float horizontalFade = 1.0 - (cos(uv.x * 6.28) * 0.5 + 0.5);
      float verticalFade   = 1.0 - (cos(uv.y * 6.28) * 0.5 + 0.5);

      space.y += random(space.x * warpFrequency + iFlow * warpSpeed) * warpAmplitude * (0.3 + horizontalFade * 0.7);
      space.x += random(space.y * warpFrequency + iFlow * warpSpeed + 2.0) * warpAmplitude * horizontalFade * 0.6;

      vec2 centerUv = uv - vec2(0.5, 0.5);
      float centerDist = length(centerUv * vec2(1.0, iResolution.x / iResolution.y));
      float edgeGlow   = smoothstep(0.18, 0.65, centerDist);
      float bottomGlow = smoothstep(0.65, 0.0, uv.y) * 0.25;

      // Deep cinematic navy to near-black background
      vec4 bgCenter = vec4(0.002, 0.007, 0.015, 1.0);
      vec4 bgEdge   = mix(vec4(0.005, 0.014, 0.028, 1.0), vec4(0.018, 0.010, 0.003, 1.0), iGold);
      vec4 fragColor = mix(bgCenter, bgEdge, edgeGlow * 0.55 + bottomGlow * 0.4);
      fragColor *= verticalFade * 0.9 + 0.1;
      fragColor.a = 1.0;

      // Mask out foreground wavy lines near the center so the core and Panda remain clean
      float centerMask = smoothstep(0.22, 0.48, centerDist);

      vec4 lines = vec4(0.0);
      for (int l = 0; l < linesPerGroup; l++) {
        float normalizedIdx = float(l) / float(linesPerGroup);
        float offsetTime    = iFlow * offsetSpeed;
        float offsetPos     = float(l) + space.x * offsetFrequency;
        float rand          = random(offsetPos + offsetTime) * 0.5 + 0.5;
        float halfWidth     = mix(minLineWidth, maxLineWidth, rand * horizontalFade) / 2.0;
        float offset        = random(offsetPos + offsetTime * (1.0 + normalizedIdx)) * mix(minOffsetSpread, maxOffsetSpread, horizontalFade);
        float linePos       = getPlasmaY(space.x, horizontalFade, offset, lineAmplitude);
        float line          = drawSmoothLine(linePos, halfWidth, space.y) * 0.4
                            + drawCrispLine(linePos, halfWidth * 0.2, space.y) * 0.6;

        float circleX = mod(float(l) + iFlow * lineSpeed, 25.0) - 12.0;
        vec2 circlePos = vec2(circleX, getPlasmaY(circleX, horizontalFade, offset, lineAmplitude));
        float circle = drawCircle(circlePos, 0.008, space) * 1.5;
        line += circle;

        float depthTint = uv.y * 0.4 + normalizedIdx * 0.3;
        vec4 lineColor = mix(lineColorCool, lineColorBase, depthTint);
        lines += line * lineColor * rand;
      }

      fragColor += lines * brightnessBoost * centerMask;
      gl_FragColor = fragColor;
    }
  `;

  function loadShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('Shader compile failed, falling back to CSS background');
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function initShaderProgram(gl, vs, fs) {
    const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vs);
    const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fs);
    if (!vertexShader || !fragmentShader) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('Shader program link failed');
      return null;
    }
    return program;
  }

  return function initApexShaderBackground(canvasId) {
    const canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;
    if (!canvas) return null;

    // Check for reduced motion
    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return null;

    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'low-power' });
    } catch {
      return null;
    }
    if (!gl) return null;

    const program = initShaderProgram(gl, vsSource, fsSource);
    if (!program) return null;

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const programInfo = {
      program,
      attribLocations: { vertexPosition: gl.getAttribLocation(program, 'aVertexPosition') },
      uniformLocations: {
        resolution: gl.getUniformLocation(program, 'iResolution'),
        time: gl.getUniformLocation(program, 'iFlow'),
        voiceIntensity: gl.getUniformLocation(program, 'iVoiceIntensity'),
        gold: gl.getUniformLocation(program, 'iGold'),
      },
    };

    let voiceTarget = 0;
    let voiceCurrent = 0;
    let goldTarget = 0;
    let goldCurrent = 0;
    let flow = 0;
    let lastTime = performance.now();
    let rafId = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    window.addEventListener('resize', resize);
    resize();

    function render(now) {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      voiceCurrent += (voiceTarget - voiceCurrent) * Math.min(dt * 5, 1);
      goldCurrent += (goldTarget - goldCurrent) * Math.min(dt * 3, 1);
      flow += dt * (1.0 + voiceCurrent * 1.5);

      gl.useProgram(programInfo.program);
      gl.uniform2f(programInfo.uniformLocations.resolution, canvas.width, canvas.height);
      gl.uniform1f(programInfo.uniformLocations.time, flow);
      gl.uniform1f(programInfo.uniformLocations.voiceIntensity, voiceCurrent);
      gl.uniform1f(programInfo.uniformLocations.gold, goldCurrent);

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(programInfo.attribLocations.vertexPosition, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafId = requestAnimationFrame(render);
    }

    rafId = requestAnimationFrame(render);

    return {
      setVoiceActive(active) {
        voiceTarget = active ? 1.0 : 0.0;
      },
      setGold(isGold) {
        goldTarget = isGold ? 1.0 : 0.0;
      },
      destroy() {
        cancelAnimationFrame(rafId);
        window.removeEventListener('resize', resize);
      },
    };
  };
});
