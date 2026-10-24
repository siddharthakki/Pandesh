/**
 * Apex Reasoning Web — Adapted from APEX-UI (https://github.com/RubenM1990/APEX-UI)
 * MIT License. See APEX_CREDITS.md for attribution.
 *
 * Implements pure SVG + requestAnimationFrame neural constellation graph
 * surrounding the central futuristic Panda hero.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.initApexReasoningWeb = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const NS = 'http://www.w3.org/2000/svg';

  const COL = {
    cyan: '#00e5ff',
    gold: '#f5a623',
    blue: '#2e90fa',
    muted: '#527591',
    success: '#34d399',
    error: '#f87171',
  };

  // 10 Focused capability nodes per KKD specification
  // [id, label, subtitle, type, x, y, bend, radius, iconPath]
  const DEFAULT_ROSTER = [
    // Top
    ['planning', 'Planning', 'Strategy · Objectives', 'cyan', 600, 125, 0, 18, 'M3 13h4v8H3v-8zm6-8h4v16H9V5zm6 4h4v12h-4V9z'],
    // Top-Left / Left
    ['research', 'Research', 'Search · Synthesize', 'cyan', 380, 195, -16, 19, 'M11 4a7 7 0 1 0 5.2 11.7l4.5 4.6 1.4-1.4-4.6-4.5A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z'],
    ['files', 'Files', 'Workspace Explorer', 'cyan', 250, 370, -14, 19, 'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4l-7 4.5L5 8V6l7 4.5L19 6v2z'],
    // Bottom-Left / Bottom
    ['operations', 'Operations', 'Tools · Execution', 'gold', 320, 575, -10, 18, 'M19.1 13c.1-.3.1-.7.1-1s0-.7-.1-1l2.1-1.6c.2-.2.2-.4.1-.6l-2-3.5c-.1-.2-.4-.3-.6-.2l-2.5 1c-.5-.4-1.1-.7-1.7-1l-.4-2.7c0-.2-.2-.4-.5-.4h-4c-.2 0-.4.2-.5.4l-.4 2.7c-.6.2-1.2.6-1.7 1l-2.5-1c-.2-.1-.5 0-.6.2l-2 3.5c-.1.2-.1.4.1.6l2.1 1.6c0 .3-.1.7-.1 1s0 .7.1 1l-2.1 1.6c-.2.2-.2.4-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.7c0 .2.2.4.5.4h4c.2 0 .4-.2.5-.4l.4-2.7c.6-.2 1.2-.6 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5c.1-.2.1-.4-.1-.6L19.1 13z'],
    ['voice', 'Voice', 'Speech · Push-to-Talk', 'cyan', 470, 680, -6, 17, 'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z'],
    // Bottom-Right / Right
    ['design', 'Design', 'UI · Layout · Style', 'gold', 730, 680, 6, 17, 'M20.7 7l-3.7-3.7a1 1 0 0 0-1.4 0l-12 12a1 1 0 0 0-.3.5L2 21a1 1 0 0 0 1 1l5.2-1.3c.2 0 .4-.1.5-.3l12-12a1 1 0 0 0 0-1.4z'],
    ['engineering', 'Engineering', 'Build · Environment', 'gold', 880, 575, 10, 18, 'M8.7 15.9L4.8 12l3.9-3.9-1.4-1.4L2 12l5.3 5.3 1.4-1.4zm6.6 0l3.9-3.9-3.9-3.9 1.4-1.4 5.3 5.3-5.3 5.3-1.4-1.4z'],
    ['coding', 'Coding', 'Edits · Diffs · Verify', 'cyan', 950, 370, 14, 19, 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z'],
    // Top-Right
    ['memory', 'Memory', 'Context · Provenance', 'cyan', 820, 195, 16, 19, 'M12 3a9 9 0 0 0-9 9c0 3.6 2.1 6.7 5.2 8.1l.8-1.8C6.3 17.2 4.8 14.8 4.8 12a7.2 7.2 0 1 1 14.4 0c0 2.8-1.5 5.2-4.2 6.3l.8 1.8A9 9 0 0 0 12 3z'],
    ['calendar', 'Calendar', 'Schedule (Local only)', 'muted', 1010, 220, 20, 16, 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z'],
  ];

  return function initApexReasoningWeb(containerId, options = {}) {
    const container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    if (!container) return null;

    const roster = options.roster || DEFAULT_ROSTER;
    const AX = options.originX || 600;
    const AY = options.originY || 400;
    const onNodeClick = options.onNodeClick || null;

    container.innerHTML = '';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1200 800');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'apex-reasoning-svg');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.zIndex = '2';

    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = `
      <filter id="apex-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3.2" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="apex-glow-intense" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="6.0" result="b1" />
        <feGaussianBlur stdDeviation="2.5" result="b2" />
        <feMerge>
          <feMergeNode in="b1" />
          <feMergeNode in="b2" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <radialGradient id="halo-grad" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#00e5ff" stop-opacity="0.32" />
        <stop offset="70%" stop-color="#00e5ff" stop-opacity="0.08" />
        <stop offset="100%" stop-color="#00e5ff" stop-opacity="0" />
      </radialGradient>
    `;
    svg.appendChild(defs);

    const ringsGroup = document.createElementNS(NS, 'g');
    const pcbGroup = document.createElementNS(NS, 'g');
    const meshGroup = document.createElementNS(NS, 'g');
    const spokesGroup = document.createElementNS(NS, 'g');
    const particlesGroup = document.createElementNS(NS, 'g');
    const nodesGroup = document.createElementNS(NS, 'g');

    svg.append(ringsGroup, pcbGroup, meshGroup, spokesGroup, particlesGroup, nodesGroup);
    container.appendChild(svg);

    // Orbital concentric rings around Panda
    const orbitRadii = [140, 220, 310];
    orbitRadii.forEach((r, idx) => {
      const circ = document.createElementNS(NS, 'circle');
      circ.setAttribute('cx', AX);
      circ.setAttribute('cy', AY);
      circ.setAttribute('r', r);
      circ.setAttribute('fill', 'none');
      circ.setAttribute('stroke', '#1a4e6e');
      circ.setAttribute('stroke-width', '1');
      circ.setAttribute('stroke-opacity', idx === 0 ? '0.45' : '0.28');
      circ.setAttribute('stroke-dasharray', idx === 1 ? '4 8' : '2 6');
      ringsGroup.appendChild(circ);
    });

    // Fanning PCB traces out to lateral edges
    const pcbLines = [
      // Left side traces
      { sx: AX - 180, sy: AY - 90, mx: 120, my: AY - 90, ex: 40, ey: AY - 90 },
      { sx: AX - 210, sy: AY + 20, mx: 90, my: AY + 20, ex: 20, ey: AY + 50 },
      { sx: AX - 170, sy: AY + 130, mx: 140, my: AY + 130, ex: 60, ey: AY + 180 },
      // Right side traces
      { sx: AX + 180, sy: AY - 90, mx: 1080, my: AY - 90, ex: 1160, ey: AY - 90 },
      { sx: AX + 210, sy: AY + 20, mx: 1110, my: AY + 20, ex: 1180, ey: AY + 50 },
      { sx: AX + 170, sy: AY + 130, mx: 1060, my: AY + 130, ex: 1140, ey: AY + 180 },
    ];
    pcbLines.forEach((t) => {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M${t.sx} ${t.sy} H${t.mx} L${t.ex} ${t.ey}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#133a52');
      path.setAttribute('stroke-width', '1');
      path.setAttribute('stroke-opacity', '0.5');
      pcbGroup.appendChild(path);

      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', t.ex);
      dot.setAttribute('cy', t.ey);
      dot.setAttribute('r', '2.5');
      dot.setAttribute('fill', '#00e5ff');
      dot.setAttribute('opacity', '0.65');
      dot.setAttribute('filter', 'url(#apex-glow)');
      pcbGroup.appendChild(dot);
    });

    // Bezier path generator from center hub to node
    function getPathD(bx, by, bend) {
      const mx = (AX + bx) / 2;
      const my = (AY + by) / 2;
      const dx = bx - AX;
      const dy = by - AY;
      const l = Math.hypot(dx, dy) || 1;
      const qx = mx + (-dy / l) * bend;
      const qy = my + (dx / l) * bend;
      return `M${AX} ${AY} Q${qx} ${qy} ${bx} ${by}`;
    }

    const nodeMap = {};
    const nodesList = [];

    roster.forEach((r) => {
      const [id, label, sub, colName, x, y, bend, radius, iconPath] = r;
      const col = COL[colName] || COL.cyan;

      // Spoke path
      const spoke = document.createElementNS(NS, 'path');
      spoke.setAttribute('d', getPathD(x, y, bend));
      spoke.setAttribute('fill', 'none');
      spoke.setAttribute('stroke', '#1a4e6e');
      spoke.setAttribute('stroke-width', '1.2');
      spoke.setAttribute('stroke-opacity', '0.55');
      spokesGroup.appendChild(spoke);

      // Node Halo
      const halo = document.createElementNS(NS, 'circle');
      halo.setAttribute('cx', x);
      halo.setAttribute('cy', y);
      halo.setAttribute('r', radius + 10);
      halo.setAttribute('fill', col);
      halo.setAttribute('opacity', '0.12');
      halo.setAttribute('filter', 'url(#apex-glow)');
      nodesGroup.appendChild(halo);

      // Outer Ring
      const ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('cx', x);
      ring.setAttribute('cy', y);
      ring.setAttribute('r', radius);
      ring.setAttribute('fill', '#071626');
      ring.setAttribute('stroke', col);
      ring.setAttribute('stroke-width', '1.8');
      ring.setAttribute('filter', 'url(#apex-glow)');
      nodesGroup.appendChild(ring);

      // Pulse ring for activity
      const pulseRing = document.createElementNS(NS, 'circle');
      pulseRing.setAttribute('cx', x);
      pulseRing.setAttribute('cy', y);
      pulseRing.setAttribute('r', radius);
      pulseRing.setAttribute('fill', 'none');
      pulseRing.setAttribute('stroke', col);
      pulseRing.setAttribute('stroke-width', '2');
      pulseRing.setAttribute('opacity', '0');
      nodesGroup.appendChild(pulseRing);

      // Icon Glyph
      const iconGroup = document.createElementNS(NS, 'g');
      iconGroup.setAttribute('transform', `translate(${x - 8}, ${y - 8}) scale(0.66)`);
      const pathEl = document.createElementNS(NS, 'path');
      pathEl.setAttribute('d', iconPath);
      pathEl.setAttribute('fill', col);
      iconGroup.appendChild(pathEl);
      nodesGroup.appendChild(iconGroup);

      // Text Label & Subtitle
      const dx = x - AX;
      const dy = y - AY;
      const isTop = Math.abs(dx) < 60 && dy < 0;
      const isBottom = Math.abs(dx) < 60 && dy > 0;
      const isRight = dx >= 60;
      const textAnchor = isTop || isBottom ? 'middle' : (isRight ? 'start' : 'end');
      const textX = isTop || isBottom ? x : (isRight ? x + radius + 12 : x - radius - 12);
      const textY = isTop ? y - radius - 14 : (isBottom ? y + radius + 18 : y - 2);

      const titleText = document.createElementNS(NS, 'text');
      titleText.setAttribute('x', textX);
      titleText.setAttribute('y', textY);
      titleText.setAttribute('text-anchor', textAnchor);
      titleText.setAttribute('fill', '#e0f4ff');
      titleText.setAttribute('font-size', '13');
      titleText.setAttribute('font-weight', '600');
      titleText.setAttribute('letter-spacing', '0.04em');
      titleText.textContent = label;
      nodesGroup.appendChild(titleText);

      const subText = document.createElementNS(NS, 'text');
      subText.setAttribute('x', textX);
      subText.setAttribute('y', textY + 14);
      subText.setAttribute('text-anchor', textAnchor);
      subText.setAttribute('fill', '#6a8ea8');
      subText.setAttribute('font-size', '9.5');
      subText.setAttribute('letter-spacing', '0.03em');
      subText.textContent = sub;
      nodesGroup.appendChild(subText);

      // Active status text pill
      const actionGroup = document.createElementNS(NS, 'g');
      actionGroup.setAttribute('class', 'apex-action-callout');
      actionGroup.setAttribute('opacity', '0');
      actionGroup.style.transition = 'opacity 0.3s ease';

      const actionBg = document.createElementNS(NS, 'rect');
      actionBg.setAttribute('x', isRight ? x + radius + 10 : x - radius - 180);
      actionBg.setAttribute('y', y + 16);
      actionBg.setAttribute('width', '170');
      actionBg.setAttribute('height', '18');
      actionBg.setAttribute('rx', '4');
      actionBg.setAttribute('fill', 'rgba(0, 229, 255, 0.15)');
      actionBg.setAttribute('stroke', col);
      actionBg.setAttribute('stroke-width', '1');

      const actionText = document.createElementNS(NS, 'text');
      actionText.setAttribute('x', isRight ? x + radius + 16 : x - radius - 95);
      actionText.setAttribute('y', y + 29);
      actionText.setAttribute('text-anchor', isRight ? 'start' : 'middle');
      actionText.setAttribute('fill', col);
      actionText.setAttribute('font-size', '8.5');
      actionText.setAttribute('font-weight', '600');
      actionText.setAttribute('letter-spacing', '0.06em');
      actionText.textContent = 'ACTIVE';

      actionGroup.appendChild(actionBg);
      actionGroup.appendChild(actionText);
      nodesGroup.appendChild(actionGroup);

      // Interactive hit area
      const hit = document.createElementNS(NS, 'circle');
      hit.setAttribute('cx', x);
      hit.setAttribute('cy', y);
      hit.setAttribute('r', radius + 16);
      hit.setAttribute('fill', 'transparent');
      hit.style.pointerEvents = 'all';
      hit.style.cursor = 'pointer';

      hit.addEventListener('click', () => {
        if (onNodeClick) onNodeClick({ id, label, subtitle: sub, color: col });
      });
      nodesGroup.appendChild(hit);

      const nodeObj = {
        id, label, sub, col, x, y, radius,
        spoke, halo, ring, pulseRing, actionGroup, actionText, actionBg,
        active: false,
        pulsePhase: Math.random() * Math.PI * 2,
      };

      nodeMap[id] = nodeObj;
      nodesList.push(nodeObj);
    });

    // Connect some nearest neighbors for natural neural mesh look
    for (let i = 0; i < nodesList.length; i++) {
      const a = nodesList[i];
      let nearest = null;
      let minDist = 1e9;
      for (let j = 0; j < nodesList.length; j++) {
        if (i === j) continue;
        const b = nodesList[j];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < minDist && d < 180) {
          minDist = d;
          nearest = b;
        }
      }
      if (nearest && a.id < nearest.id) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', a.x);
        line.setAttribute('y1', a.y);
        line.setAttribute('x2', nearest.x);
        line.setAttribute('y2', nearest.y);
        line.setAttribute('stroke', '#164259');
        line.setAttribute('stroke-width', '1');
        line.setAttribute('stroke-opacity', '0.35');
        meshGroup.appendChild(line);
      }
    }

    // Particle system: cyan glowing packets flowing along active/idle spokes
    const liveParticles = [];

    function spawnPacket(spoke, isHot = false, customCol = null) {
      const el = document.createElementNS(NS, 'circle');
      el.setAttribute('r', isHot ? '2.4' : '1.3');
      el.setAttribute('fill', customCol || (isHot ? '#ffffff' : '#00e5ff'));
      el.setAttribute('filter', 'url(#apex-glow)');
      particlesGroup.appendChild(el);

      liveParticles.push({
        el,
        born: performance.now(),
        duration: isHot ? 650 : 1200,
        spoke,
        length: spoke.getTotalLength(),
        isHot,
      });
    }

    let rafId = 0;
    let lastMoteTime = performance.now();
    let globalPhase = 0;

    function loop(now) {
      globalPhase += 0.035;

      // Gentle ambient mote drift on random spokes when idle
      if (now - lastMoteTime > 600 && liveParticles.length < 12) {
        const randomNode = nodesList[Math.floor(Math.random() * nodesList.length)];
        if (randomNode && randomNode.spoke) {
          spawnPacket(randomNode.spoke, false);
        }
        lastMoteTime = now;
      }

      // Animate active nodes
      nodesList.forEach((n) => {
        if (n.active) {
          const k = (Math.sin(globalPhase * 2 + n.pulsePhase) + 1) / 2;
          n.pulseRing.setAttribute('r', n.radius + k * 12);
          n.pulseRing.setAttribute('opacity', (1 - k) * 0.85);
          n.halo.setAttribute('r', n.radius + 14 + k * 6);
          n.halo.setAttribute('opacity', 0.28 + k * 0.2);
        }
      });

      // Update particle positions along spokes
      for (let i = liveParticles.length - 1; i >= 0; i--) {
        const p = liveParticles[i];
        const progress = (now - p.born) / p.duration;
        if (progress >= 1) {
          p.el.remove();
          liveParticles.splice(i, 1);
          continue;
        }
        const pt = p.spoke.getPointAtLength(progress * p.length);
        p.el.setAttribute('cx', pt.x);
        p.el.setAttribute('cy', pt.y);
        const fade = Math.sin(progress * Math.PI);
        p.el.setAttribute('opacity', (p.isHot ? 1.0 : 0.6) * fade);
      }

      rafId = requestAnimationFrame(loop);
    }

    rafId = requestAnimationFrame(loop);

    return {
      setNodeState(nodeId, state, actionText = '') {
        const n = nodeMap[nodeId];
        if (!n) return;
        if (state === 'idle' || state === 'available') {
          this.deactivateNode(nodeId);
          return;
        }
        n.active = true;
        let strokeCol = '#00e5ff';
        let actionBgCol = 'rgba(0, 229, 255, 0.15)';
        let defaultLabel = 'ACTIVE';

        if (state === 'waiting_approval') {
          strokeCol = '#f59e0b';
          actionBgCol = 'rgba(245, 158, 11, 0.2)';
          defaultLabel = 'APPROVAL NEEDED';
        } else if (state === 'completed') {
          strokeCol = '#34d399';
          actionBgCol = 'rgba(52, 211, 153, 0.2)';
          defaultLabel = 'COMPLETED';
        } else if (state === 'failed') {
          strokeCol = '#f87171';
          actionBgCol = 'rgba(248, 113, 113, 0.2)';
          defaultLabel = 'FAILED';
        } else if (state === 'unavailable') {
          strokeCol = '#527591';
          actionBgCol = 'rgba(82, 117, 145, 0.15)';
          defaultLabel = 'NOT CONNECTED';
        }

        n.spoke.setAttribute('stroke', strokeCol);
        n.spoke.setAttribute('stroke-width', '2.0');
        n.spoke.setAttribute('stroke-opacity', '0.9');
        n.ring.setAttribute('filter', 'url(#apex-glow-intense)');
        n.ring.setAttribute('stroke', strokeCol);
        n.actionBg.setAttribute('stroke', strokeCol);
        n.actionBg.setAttribute('fill', actionBgCol);
        n.actionText.setAttribute('fill', strokeCol);
        n.actionText.textContent = actionText || defaultLabel;
        n.actionGroup.setAttribute('opacity', '1');

        if (state === 'active' || state === 'waiting_approval') {
          for (let i = 0; i < 3; i++) {
            setTimeout(() => {
              if (n.active) spawnPacket(n.spoke, true, strokeCol);
            }, i * 160);
          }
        }
      },
      activateNode(nodeId, actionText = 'ACTIVE') {
        this.setNodeState(nodeId, 'active', actionText);
      },
      deactivateNode(nodeId) {
        const n = nodeMap[nodeId];
        if (!n) return;
        n.active = false;
        n.spoke.setAttribute('stroke', '#1a4e6e');
        n.spoke.setAttribute('stroke-width', '1.2');
        n.spoke.setAttribute('stroke-opacity', '0.55');
        n.ring.setAttribute('filter', 'url(#apex-glow)');
        n.ring.setAttribute('stroke', n.col);
        n.ring.setAttribute('stroke-width', '1.8');
        n.pulseRing.setAttribute('opacity', '0');
        n.actionGroup.setAttribute('opacity', '0');
      },
      deactivateAll() {
        nodesList.forEach((n) => {
          this.deactivateNode(n.id);
        });
      },
      getNode(nodeId) {
        return nodeMap[nodeId] || null;
      },
      destroy() {
        cancelAnimationFrame(rafId);
        container.innerHTML = '';
      },
    };
  };
});
