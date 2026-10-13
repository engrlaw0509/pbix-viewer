// A virtual-scrolling data grid: only the visible rows are in the DOM.
import { display } from './format.js';

const ROW_H = 28;
const OVERSCAN = 8;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Grid {
  // opts: { columns: [{name, fmt, sub}], rowCount, getValue(viewRow, col),
  //         filters?: string[], onFilter?(col, text), sort?, onSort?(col),
  //         totals?: [{text, kind, title, negative}], totalsLabel?,
  //         onSelect?(info), onCopy?({row, col}) }
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.sel = null;
    el.classList.add('grid');
    el.innerHTML = '';
    this.scroll = document.createElement('div');
    this.scroll.className = 'grid-scroll';
    this.scroll.tabIndex = 0;
    el.appendChild(this.scroll);
    this.inner = document.createElement('div');
    this.inner.className = 'grid-inner';
    this.scroll.appendChild(this.inner);
    this.head = document.createElement('div');
    this.head.className = 'grid-head';
    this.body = document.createElement('div');
    this.body.className = 'grid-body';
    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'grid-rows';
    this.body.appendChild(this.rowsEl);
    this.foot = document.createElement('div');
    this.foot.className = 'grid-foot';
    this.inner.append(this.head, this.body, this.foot);

    this.widths = this.measure();
    const gutter = Math.max(44, String(opts.rowCount).length * 8 + 20);
    this.template = `${gutter}px ` + this.widths.map(w => w + 'px').join(' ');
    this.inner.style.setProperty('--cols', this.template);
    this.inner.style.width = gutter + this.widths.reduce((a, b) => a + b, 0) + 'px';
    this.renderHead();
    this.update({});

    let raf = 0;
    this.scroll.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.renderRows(); });
    });
    this.rowsEl.addEventListener('click', e => {
      const cell = e.target.closest('[data-c]');
      if (!cell) return;
      this.select(Number(cell.parentNode.dataset.r), Number(cell.dataset.c));
    });
    this.scroll.addEventListener('keydown', e => this.onKey(e));
    this.ro = new ResizeObserver(() => this.renderRows());
    this.ro.observe(this.scroll);
  }

  measure() {
    const { columns, rowCount, getValue } = this.opts;
    const sample = Math.min(rowCount, 300);
    return columns.map((c, ci) => {
      let len = Math.max(c.name.length + 3, (c.sub || '').length);
      for (let r = 0; r < sample; r++) {
        const s = display(getValue(r, ci), c.fmt);
        if (s.length > len) len = s.length;
      }
      return Math.round(Math.min(360, Math.max(76, len * 7.4 + 22)));
    });
  }

  renderHead() {
    const { columns, filters, onFilter, onSort } = this.opts;
    let h = '<div class="grid-row grid-titles"><div class="gc gutter">#</div>';
    columns.forEach((c, i) => {
      const right = c.fmt.kind === 'int' || c.fmt.kind === 'number';
      h += `<div class="gc th${right ? ' num' : ''}${onSort ? ' sortable' : ''}" data-c="${i}" title="${esc(c.name)}${c.sub ? ' · ' + esc(c.sub) : ''}">` +
        `<span class="th-name">${esc(c.name)}</span><span class="sort-mark"></span>` +
        (c.sub ? `<span class="th-sub">${esc(c.sub)}</span>` : '') + '</div>';
    });
    h += '</div>';
    if (onFilter) {
      h += '<div class="grid-row grid-filters"><div class="gc gutter"></div>';
      columns.forEach((c, i) => {
        h += `<div class="gc"><input type="search" data-c="${i}" placeholder="filter" aria-label="Filter ${esc(c.name)}" value="${esc((filters && filters[i]) || '')}"></div>`;
      });
      h += '</div>';
    }
    this.head.innerHTML = h;
    if (onSort) {
      this.head.querySelectorAll('.th').forEach(th => th.addEventListener('click', () => onSort(Number(th.dataset.c))));
    }
    if (onFilter) {
      let t = 0;
      this.head.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => onFilter(Number(inp.dataset.c), inp.value), 220);
      }));
    }
  }

  // Re-render after the row set, sort or totals change.
  update({ rowCount, totals, totalsLabel, sort }) {
    if (rowCount != null) this.opts.rowCount = rowCount;
    if (totals !== undefined) this.opts.totals = totals;
    if (totalsLabel !== undefined) this.opts.totalsLabel = totalsLabel;
    if (sort !== undefined) this.opts.sort = sort;
    this.head.querySelectorAll('.th').forEach(th => {
      const s = this.opts.sort;
      const on = s && s.col === Number(th.dataset.c);
      th.classList.toggle('sorted', !!on);
      th.querySelector('.sort-mark').textContent = on ? (s.dir > 0 ? '▲' : '▼') : '';
    });
    this.body.style.height = this.opts.rowCount * ROW_H + 'px';
    if (this.sel && this.sel.row >= this.opts.rowCount) this.sel = null;
    this.renderFoot();
    this.renderRows(true);
  }

  renderFoot() {
    const { totals, columns, totalsLabel } = this.opts;
    if (!totals) { this.foot.innerHTML = ''; this.foot.hidden = true; return; }
    this.foot.hidden = false;
    let h = `<div class="grid-row"><div class="gc gutter" title="${esc(totalsLabel || 'Totals')}">Σ</div>`;
    columns.forEach((c, i) => {
      // totals[i]: { text, kind: 'sum' | 'count', title, negative } or null
      const t = totals[i];
      const right = c.fmt.kind === 'int' || c.fmt.kind === 'number';
      let cls = 'gc';
      if (right || (t && t.kind === 'count')) cls += ' num';
      if (t && t.kind === 'count') cls += ' count';
      if (t && t.negative) cls += ' neg';
      const tag = t && t.kind === 'count' ? '<span class="foot-tag">count</span>' : '';
      h += `<div class="${cls}" title="${t ? esc(t.title || '') : ''}">${tag}${t ? esc(t.text) : ''}</div>`;
    });
    this.foot.innerHTML = h + '</div>';
  }

  renderRows(force) {
    const { columns, rowCount, getValue } = this.opts;
    const top = this.scroll.scrollTop;
    const height = this.scroll.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(rowCount, Math.ceil((top + height) / ROW_H) + OVERSCAN);
    if (!force && start === this.start && end === this.end) return;
    this.start = start;
    this.end = end;
    let h = '';
    for (let r = start; r < end; r++) {
      h += `<div class="grid-row${r & 1 ? ' odd' : ''}" data-r="${r}"><div class="gc gutter">${r + 1}</div>`;
      for (let c = 0; c < columns.length; c++) {
        const v = getValue(r, c);
        const fmt = columns[c].fmt;
        const num = fmt.kind === 'int' || fmt.kind === 'number';
        const s = display(v, fmt);
        let cls = 'gc';
        if (num) cls += ' num';
        if (num && typeof v === 'number' && v < 0) cls += ' neg';
        if (v == null) cls += ' blank';
        if (this.sel && this.sel.row === r && this.sel.col === c) cls += ' sel';
        h += `<div class="${cls}" data-c="${c}">${v == null ? '' : esc(s)}</div>`;
      }
      h += '</div>';
    }
    this.rowsEl.style.transform = `translateY(${start * ROW_H}px)`;
    this.rowsEl.innerHTML = h;
  }

  select(row, col) {
    const { columns, getValue, onSelect } = this.opts;
    if (row < 0 || col < 0 || row >= this.opts.rowCount || col >= columns.length) return;
    this.sel = { row, col };
    this.renderRows(true);
    this.scroll.focus({ preventScroll: true });
    if (onSelect) onSelect({ row, col, column: columns[col], value: getValue(row, col) });
  }

  onKey(e) {
    if (!this.sel) return;
    const { row, col } = this.sel;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && this.opts.onCopy) {
      if (window.getSelection && String(window.getSelection())) return; // let a text selection copy normally
      e.preventDefault();
      this.opts.onCopy(this.sel);
      return;
    }
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dr, dc] = moves[e.key];
      this.select(row + dr, col + dc);
      const y = (row + dr) * ROW_H;
      const headH = this.head.offsetHeight;
      if (y < this.scroll.scrollTop) this.scroll.scrollTop = y;
      else if (y + ROW_H > this.scroll.scrollTop + this.scroll.clientHeight - headH - this.foot.offsetHeight) {
        this.scroll.scrollTop = y + ROW_H - this.scroll.clientHeight + headH + this.foot.offsetHeight;
      }
    }
  }

  destroy() { this.ro.disconnect(); this.el.innerHTML = ''; }
}
