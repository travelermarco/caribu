'use strict';

/**
 * MiniChart — SVG real-time line chart, zero dependencies.
 *
 * Options:
 *   container  {string|Element}  — selector or DOM element
 *   maxPoints  {number}          — rolling window size (default 60)
 *   height     {number}          — viewBox height in px (default 100)
 *   colorFn    {Function}        — (value) => cssColor for the line/fill
 *   dualColor  {boolean}         — true → green above zero, amber below (power charts)
 *   yLabel     {string}          — unit shown on Y axis (e.g. 'W', '%')
 *   yMin       {number|null}     — fixed min (null = dynamic)
 *   yMax       {number|null}     — fixed max (null = dynamic)
 *   gridLines  {number}          — number of horizontal grid lines (default 3)
 */
export class MiniChart {
  constructor(options = {}) {
    this.maxPoints = options.maxPoints ?? 60;
    this.height    = options.height    ?? 100;
    this.colorFn   = options.colorFn   ?? (() => '#4ADE80');
    this.dualColor = options.dualColor ?? false;
    this.yLabel    = options.yLabel    ?? '';
    this.fixedMin  = options.yMin      ?? null;
    this.fixedMax  = options.yMax      ?? null;
    this.gridLines = options.gridLines ?? 3;

    this.data = [];   // array of raw values

    // Resolve container
    if (typeof options.container === 'string') {
      this.container = document.querySelector(options.container);
    } else {
      this.container = options.container ?? null;
    }

    this._blinkHandle = null;
    this._blinkState  = true;

    if (this.container) this._build();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Attach to a new DOM container (called when the screen re-renders). */
  mount(containerOrSelector) {
    if (typeof containerOrSelector === 'string') {
      this.container = document.querySelector(containerOrSelector);
    } else {
      this.container = containerOrSelector;
    }
    if (this.container) {
      this.container.innerHTML = '';
      this._build();
      this._render();
    }
  }

  /** Push a new value and redraw. */
  push(value) {
    const v = parseFloat(value);
    if (isNaN(v)) return;
    this.data.push(v);
    if (this.data.length > this.maxPoints) this.data.shift();
    if (this.container && this.container.isConnected) {
      this._render();
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _build() {
    // Outer wrapper (provides the dark card background)
    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap';

    // SVG — wide viewBox, exact height
    const W = 600; // virtual width units
    const H = this.height;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'width:100%;height:' + H + 'px;display:block;overflow:visible';

    // Defs — clip + gradient
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

    const clipId = 'cc-clip-' + Math.random().toString(36).slice(2);
    const clip   = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    clip.setAttribute('id', clipId);
    const clipRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    clipRect.setAttribute('x', '0'); clipRect.setAttribute('y', '0');
    clipRect.setAttribute('width', W); clipRect.setAttribute('height', H);
    clip.appendChild(clipRect);

    defs.appendChild(clip);
    svg.appendChild(defs);

    // Grid group
    const gridG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gridG.setAttribute('class', 'chart-grid');

    // Area fill path (will be split per segment in dual-color mode)
    const areaPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    areaPath.setAttribute('clip-path', `url(#${clipId})`);
    areaPath.setAttribute('class', 'chart-area');

    // Line path
    const linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    linePath.setAttribute('clip-path', `url(#${clipId})`);
    linePath.setAttribute('class', 'chart-line');
    linePath.setAttribute('fill', 'none');
    linePath.setAttribute('stroke-width', '2.2');
    linePath.setAttribute('stroke-linecap', 'round');
    linePath.setAttribute('stroke-linejoin', 'round');

    // In dual-color mode we draw two overlay paths (positive/negative)
    let linePosPath = null, lineNegPath = null;
    let areaPosPath = null, areaNegPath = null;
    if (this.dualColor) {
      areaPosPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      areaPosPath.setAttribute('clip-path', `url(#${clipId})`);
      areaPosPath.setAttribute('fill', 'rgba(74,222,128,0.18)');

      areaNegPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      areaNegPath.setAttribute('clip-path', `url(#${clipId})`);
      areaNegPath.setAttribute('fill', 'rgba(245,158,11,0.18)');

      linePosPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      linePosPath.setAttribute('clip-path', `url(#${clipId})`);
      linePosPath.setAttribute('fill', 'none');
      linePosPath.setAttribute('stroke', '#4ADE80');
      linePosPath.setAttribute('stroke-width', '2.2');
      linePosPath.setAttribute('stroke-linecap', 'round');
      linePosPath.setAttribute('stroke-linejoin', 'round');

      lineNegPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      lineNegPath.setAttribute('clip-path', `url(#${clipId})`);
      lineNegPath.setAttribute('fill', 'none');
      lineNegPath.setAttribute('stroke', '#F59E0B');
      lineNegPath.setAttribute('stroke-width', '2.2');
      lineNegPath.setAttribute('stroke-linecap', 'round');
      lineNegPath.setAttribute('stroke-linejoin', 'round');
    }

    // Live dot
    const liveDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    liveDot.setAttribute('r', '4');
    liveDot.setAttribute('class', 'chart-live-dot');

    // Y-axis labels group
    const yLabelsG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    yLabelsG.setAttribute('class', 'chart-ylabels');

    svg.appendChild(gridG);
    if (this.dualColor) {
      svg.appendChild(areaPosPath);
      svg.appendChild(areaNegPath);
      svg.appendChild(lineNegPath);
      svg.appendChild(linePosPath);
    } else {
      svg.appendChild(areaPath);
      svg.appendChild(linePath);
    }
    svg.appendChild(yLabelsG);
    svg.appendChild(liveDot);

    wrap.appendChild(svg);
    this.container.appendChild(wrap);

    // Store refs
    this._svg       = svg;
    this._gridG     = gridG;
    this._areaPath  = areaPath;
    this._linePath  = linePath;
    this._areaPosPath = areaPosPath;
    this._areaNegPath = areaNegPath;
    this._linePosPath = linePosPath;
    this._lineNegPath = lineNegPath;
    this._liveDot   = liveDot;
    this._yLabelsG  = yLabelsG;
    this._W         = W;
    this._H         = H;
    this._clipId    = clipId;

    // Start blink animation for live dot
    this._startBlink();
  }

  _startBlink() {
    if (this._blinkHandle) clearInterval(this._blinkHandle);
    this._blinkHandle = setInterval(() => {
      this._blinkState = !this._blinkState;
      if (this._liveDot) {
        this._liveDot.setAttribute('opacity', this._blinkState ? '1' : '0.2');
      }
    }, 600);
  }

  _computeRange(data) {
    if (data.length === 0) return { min: 0, max: 100 };
    let min = this.fixedMin !== null ? this.fixedMin : Math.min(...data);
    let max = this.fixedMax !== null ? this.fixedMax : Math.max(...data);

    // In dual-color mode always include zero
    if (this.dualColor) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }

    if (min === max) { min -= 1; max += 1; }

    // Add 8% padding
    const pad = (max - min) * 0.08;
    if (this.fixedMin === null) min -= pad;
    if (this.fixedMax === null) max += pad;

    return { min, max };
  }

  /** Map value → SVG Y coordinate */
  _vy(value, min, max) {
    const H = this._H;
    return H - ((value - min) / (max - min)) * H;
  }

  /** Map index → SVG X coordinate */
  _vx(idx, total) {
    const W = this._W;
    if (total <= 1) return W;
    return (idx / (total - 1)) * W;
  }

  /** Build a smooth cubic-bezier path string from an array of {x,y} points */
  _smoothPath(pts) {
    if (pts.length === 0) return '';
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const cx = (p0.x + p1.x) / 2;
      d += ` C ${cx.toFixed(2)} ${p0.y.toFixed(2)}, ${cx.toFixed(2)} ${p1.y.toFixed(2)}, ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
    }
    return d;
  }

  /** Build closed area path (line path + down to baseline + back) */
  _areaPathStr(pts, baselineY) {
    if (pts.length === 0) return '';
    const linePart = this._smoothPath(pts);
    const last = pts[pts.length - 1];
    const first = pts[0];
    return `${linePart} L ${last.x.toFixed(2)} ${baselineY.toFixed(2)} L ${first.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;
  }

  _render() {
    const data = this.data;
    const W = this._W;
    const H = this._H;
    const n = data.length;

    if (n === 0) {
      this._clearAll();
      return;
    }

    const { min, max } = this._computeRange(data);

    // Build point array
    const pts = data.map((v, i) => ({
      x: this._vx(i, n),
      y: this._vy(v, min, max),
      v,
    }));

    // ── Grid lines
    this._gridG.innerHTML = '';
    const glCount = this.gridLines;
    for (let g = 0; g <= glCount; g++) {
      const yv = min + (max - min) * (g / glCount);
      const yp = this._vy(yv, min, max);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', W);
      line.setAttribute('y1', yp.toFixed(2)); line.setAttribute('y2', yp.toFixed(2));
      line.setAttribute('stroke', 'rgba(255,255,255,0.07)');
      line.setAttribute('stroke-width', '1');
      this._gridG.appendChild(line);
    }

    // Zero line for dual-color mode
    if (this.dualColor) {
      const yZero = this._vy(0, min, max);
      if (yZero > 0 && yZero < H) {
        const zl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        zl.setAttribute('x1', '0'); zl.setAttribute('x2', W);
        zl.setAttribute('y1', yZero.toFixed(2)); zl.setAttribute('y2', yZero.toFixed(2));
        zl.setAttribute('stroke', 'rgba(255,255,255,0.2)');
        zl.setAttribute('stroke-width', '1');
        zl.setAttribute('stroke-dasharray', '4 3');
        this._gridG.appendChild(zl);
      }
    }

    // ── Y-axis labels
    this._yLabelsG.innerHTML = '';
    const yMaxLabel = this._makeYLabel(max, 4, W - 2);
    const yMinLabel = this._makeYLabel(min, H - 4, W - 2);
    this._yLabelsG.appendChild(yMaxLabel);
    this._yLabelsG.appendChild(yMinLabel);

    if (this.dualColor) {
      // Split points into positive and negative segments
      const posPts = pts.map(p => ({ ...p, y: Math.min(p.y, this._vy(0, min, max)) }));
      const negPts = pts.map(p => ({ ...p, y: Math.max(p.y, this._vy(0, min, max)) }));
      const yZero  = this._vy(0, min, max);

      // Positive area (charge): only segments where value > 0
      const posSegPts = pts.filter(p => p.v > 0).map(p => ({ x: p.x, y: p.y }));
      const negSegPts = pts.filter(p => p.v < 0).map(p => ({ x: p.x, y: p.y }));

      // We draw full-width smooth paths but use the clamped y for fill
      this._areaPosPath.setAttribute('d', this._areaPathStr(posPts, yZero));
      this._areaNegPath.setAttribute('d', this._areaPathStr(negPts, yZero));

      // Line: draw the full path, color-coded
      const fullLine = this._smoothPath(pts.map(p => ({ x: p.x, y: p.y })));
      this._linePosPath.setAttribute('d', fullLine);
      this._lineNegPath.setAttribute('d', fullLine);

      // Mask positive line to only show when v > 0 — use clipPath trick via opacity on dots
      // (Simpler: just draw full path in both colors, the area indicates which region is which)
      // For a cleaner look, set opacity based on majority
      const posCount = data.filter(v => v >= 0).length;
      const negCount = data.length - posCount;
      if (posCount >= negCount) {
        this._linePosPath.setAttribute('opacity', '1');
        this._lineNegPath.setAttribute('opacity', '0.35');
        this._liveDot.setAttribute('fill', data[data.length-1] >= 0 ? '#4ADE80' : '#F59E0B');
      } else {
        this._linePosPath.setAttribute('opacity', '0.35');
        this._lineNegPath.setAttribute('opacity', '1');
        this._liveDot.setAttribute('fill', data[data.length-1] >= 0 ? '#4ADE80' : '#F59E0B');
      }
      // Always show the line in the correct color for the latest value
      this._liveDot.setAttribute('fill', data[data.length-1] >= 0 ? '#4ADE80' : '#F59E0B');

    } else {
      // Single-color mode
      const color = this.colorFn(data[data.length - 1]);
      const linePts = pts.map(p => ({ x: p.x, y: p.y }));
      const lineD   = this._smoothPath(linePts);
      const areaD   = this._areaPathStr(linePts, H);

      this._linePath.setAttribute('d', lineD);
      this._linePath.setAttribute('stroke', color);

      // Parse color for fill rgba
      const fillColor = this._colorToRgba(color, 0.2);
      this._areaPath.setAttribute('d', areaD);
      this._areaPath.setAttribute('fill', fillColor);

      this._liveDot.setAttribute('fill', color);
    }

    // ── Live dot position (last point)
    const last = pts[pts.length - 1];
    this._liveDot.setAttribute('cx', last.x.toFixed(2));
    this._liveDot.setAttribute('cy', last.y.toFixed(2));
    this._liveDot.setAttribute('stroke', '#0D1117');
    this._liveDot.setAttribute('stroke-width', '1.5');
  }

  _makeYLabel(value, y, x) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    t.setAttribute('text-anchor', 'end');
    t.setAttribute('font-size', '9');
    t.setAttribute('fill', 'rgba(255,255,255,0.35)');
    t.setAttribute('font-family', '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif');
    const formatted = Math.abs(value) >= 1000
      ? (value / 1000).toFixed(1) + 'k'
      : value.toFixed(Math.abs(value) < 10 ? 1 : 0);
    t.textContent = formatted + (this.yLabel ? ' ' + this.yLabel : '');
    return t;
  }

  _colorToRgba(hex, alpha) {
    // Handle CSS var references or named colors — fallback to semi-transparent white
    if (!hex || hex.startsWith('var(') || hex.startsWith('rgb')) {
      return `rgba(74,222,128,${alpha})`;
    }
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (isNaN(r)) return `rgba(74,222,128,${alpha})`;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  _clearAll() {
    if (this._gridG)    this._gridG.innerHTML = '';
    if (this._yLabelsG) this._yLabelsG.innerHTML = '';
    if (this._areaPath)    this._areaPath.setAttribute('d', '');
    if (this._linePath)    this._linePath.setAttribute('d', '');
    if (this._areaPosPath) this._areaPosPath.setAttribute('d', '');
    if (this._areaNegPath) this._areaNegPath.setAttribute('d', '');
    if (this._linePosPath) this._linePosPath.setAttribute('d', '');
    if (this._lineNegPath) this._lineNegPath.setAttribute('d', '');
    if (this._liveDot) {
      this._liveDot.setAttribute('cx', '-999');
      this._liveDot.setAttribute('cy', '-999');
    }
  }

  /** Call when the containing screen is destroyed (e.g. before innerHTML reset). */
  destroy() {
    if (this._blinkHandle) clearInterval(this._blinkHandle);
    this._blinkHandle = null;
    this.container = null;
    this._svg = null;
  }
}
