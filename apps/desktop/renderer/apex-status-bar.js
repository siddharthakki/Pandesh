/**
 * Apex Status Bar — Adapted from APEX-UI (https://github.com/RubenM1990/APEX-UI)
 * MIT License. See APEX_CREDITS.md for attribution.
 *
 * Implements SVG equalizer waveform, glowing status pip, activity label,
 * and command discoverability hints.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.initApexStatusBar = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const GOLD = '#f5a623';
  const GOLD_BRIGHT = '#ffd080';
  const CYAN = '#00e5ff';
  const NS = 'http://www.w3.org/2000/svg';

  return function initApexStatusBar(containerId) {
    const container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    if (!container) return null;

    const W = 540;
    const H = 100;
    const cx = W / 2;
    const cy = 36;

    container.innerHTML = '';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';

    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = `
      <filter id="sbGlow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="3.5" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    `;
    svg.appendChild(defs);

    // Extension dotted lines
    const lineLeft = document.createElementNS(NS, 'line');
    lineLeft.setAttribute('x1', cx - 210);
    lineLeft.setAttribute('y1', cy);
    lineLeft.setAttribute('x2', cx - 34);
    lineLeft.setAttribute('y2', cy);
    lineLeft.setAttribute('stroke', GOLD);
    lineLeft.setAttribute('stroke-width', '1');
    lineLeft.setAttribute('stroke-opacity', '0.22');
    lineLeft.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(lineLeft);

    const lineRight = document.createElementNS(NS, 'line');
    lineRight.setAttribute('x1', cx + 34);
    lineRight.setAttribute('y1', cy);
    lineRight.setAttribute('x2', cx + 210);
    lineRight.setAttribute('y2', cy);
    lineRight.setAttribute('stroke', GOLD);
    lineRight.setAttribute('stroke-width', '1');
    lineRight.setAttribute('stroke-opacity', '0.22');
    lineRight.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(lineRight);

    // Equalizer bars
    const barCount = 28;
    const barW = 3;
    const width = 220;
    const gap = (width - barCount * barW) / (barCount - 1);
    const bars = [];

    const barsGroup = document.createElementNS(NS, 'g');
    for (let i = 0; i < barCount; i++) {
      const bx = cx - width / 2 + i * (barW + gap);
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', bx);
      rect.setAttribute('y', cy - 3);
      rect.setAttribute('width', barW);
      rect.setAttribute('height', '6');
      rect.setAttribute('rx', '1.5');
      rect.setAttribute('fill', GOLD);
      rect.setAttribute('opacity', '0.35');
      barsGroup.appendChild(rect);
      bars.push({ el: rect, x: bx, idx: i });
    }
    svg.appendChild(barsGroup);

    // Center circular glowing ring and core ball
    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', cx);
    ring.setAttribute('cy', cy);
    ring.setAttribute('r', '18');
    ring.setAttribute('stroke', GOLD);
    ring.setAttribute('stroke-width', '1.5');
    ring.setAttribute('stroke-opacity', '0.75');
    ring.setAttribute('fill', '#050a14');
    ring.setAttribute('filter', 'url(#sbGlow)');
    svg.appendChild(ring);

    const coreBall = document.createElementNS(NS, 'circle');
    coreBall.setAttribute('cx', cx);
    coreBall.setAttribute('cy', cy);
    coreBall.setAttribute('r', '5.5');
    coreBall.setAttribute('fill', GOLD_BRIGHT);
    coreBall.setAttribute('opacity', '0.95');
    coreBall.setAttribute('filter', 'url(#sbGlow)');
    svg.appendChild(coreBall);

    // Dynamic State Label
    const stateLabel = document.createElementNS(NS, 'text');
    stateLabel.setAttribute('x', cx);
    stateLabel.setAttribute('y', cy + 32);
    stateLabel.setAttribute('text-anchor', 'middle');
    stateLabel.setAttribute('fill', GOLD);
    stateLabel.setAttribute('font-size', '12');
    stateLabel.setAttribute('font-family', "'Share Tech Mono', monospace, sans-serif");
    stateLabel.setAttribute('letter-spacing', '0.32em');
    stateLabel.setAttribute('font-weight', '600');
    stateLabel.textContent = 'STANDBY';
    svg.appendChild(stateLabel);

    // Subtext
    const subText = document.createElementNS(NS, 'text');
    subText.setAttribute('x', cx);
    subText.setAttribute('y', cy + 48);
    subText.setAttribute('text-anchor', 'middle');
    subText.setAttribute('fill', '#6a8ea8');
    subText.setAttribute('font-size', '8.5');
    subText.setAttribute('font-family', "'Share Tech Mono', monospace, sans-serif");
    subText.setAttribute('letter-spacing', '0.18em');
    subText.textContent = 'ASK · PLAN · RESEARCH · CREATE · EXECUTE · TOGETHER';
    svg.appendChild(subText);

    // Blinking dots
    const dots = [];
    for (let i = 0; i < 3; i++) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', cx + (i - 1) * 12);
      dot.setAttribute('cy', cy + 60);
      dot.setAttribute('r', '2');
      dot.setAttribute('fill', GOLD);
      dot.setAttribute('opacity', '0.5');
      svg.appendChild(dot);
      dots.push(dot);
    }

    container.appendChild(svg);

    let activeState = false;
    let currentColor = GOLD;
    let rafId = 0;
    let phase = 0;

    function animate(now) {
      phase += 0.05;

      bars.forEach((b) => {
        let h = 4 + Math.abs(Math.sin(phase * 0.8 + b.idx * 0.4)) * 5;
        if (activeState) {
          h = 7 + Math.abs(Math.sin(phase * 1.6 + b.idx * 0.7)) * 22;
        }
        b.el.setAttribute('y', cy - h / 2);
        b.el.setAttribute('height', h);
        b.el.setAttribute('opacity', activeState ? '0.85' : '0.32');
      });

      // Blink dots
      dots.forEach((dot, idx) => {
        const dotOpacity = 0.2 + 0.6 * ((Math.sin(phase * 1.5 + idx * 1.2) + 1) / 2);
        dot.setAttribute('opacity', dotOpacity.toFixed(2));
      });

      // Animate only while real work is active; idle renders one static frame
      // so the app costs ~nothing when nothing is happening.
      rafId = activeState ? requestAnimationFrame(animate) : 0;
    }

    rafId = requestAnimationFrame(animate);

    return {
      setStatus(text, options = {}) {
        stateLabel.textContent = text ? text.toUpperCase() : 'STANDBY';
        const wasActive = activeState;
        activeState = Boolean(options.active);
        if (activeState !== wasActive && !rafId) rafId = requestAnimationFrame(animate);
        const col = options.color || (activeState ? CYAN : GOLD);
        if (col !== currentColor) {
          currentColor = col;
          ring.setAttribute('stroke', col);
          coreBall.setAttribute('fill', col === CYAN ? '#ffffff' : GOLD_BRIGHT);
          stateLabel.setAttribute('fill', col);
          bars.forEach((b) => b.el.setAttribute('fill', col));
          dots.forEach((d) => d.setAttribute('fill', col));
        }
      },
      destroy() {
        cancelAnimationFrame(rafId);
        container.innerHTML = '';
      },
    };
  };
});
