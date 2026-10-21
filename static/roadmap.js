const API_ROADMAP = '/api/roadmap';
const GROUP_COLORS = ['#eceefb', '#fff6d5', '#e5f6ec', '#fdeeee', '#e8f4fd', '#f3eafd'];

let roadmap = { title: '研发进度规划', startDate: '', endDate: '', lanes: [] };
let zoom = localStorage.getItem('roadmap_zoom') || 'week'; // day | week | month
let timelineStart = null;
let timelineEnd = null;
let segments = [];   // [{ date, days, label, weekend }]
let totalDays = 0;
let hasGroup = false;
let suppressRowClick = false;
let collapsedGroups = new Set(JSON.parse(localStorage.getItem('roadmap_collapsed') || '[]'));
const history = []; // 撤销栈：roadmap 的 JSON 快照
let linkedProjects = [];
let loaded = false;

const els = {
  gantt: document.getElementById('gantt'),
  pageTitle: document.getElementById('page-title'),
  saveStatus: document.getElementById('save-status'),
  zoomSwitch: document.getElementById('zoom-switch'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modal-title'),
  itemForm: document.getElementById('item-form'),
  itemLaneIdx: document.getElementById('item-lane-idx'),
  itemIdx: document.getElementById('item-idx'),
  itemName: document.getElementById('item-name'),
  itemTaskLink: document.getElementById('item-task-link'),
  itemStart: document.getElementById('item-start'),
  itemEnd: document.getElementById('item-end'),
  itemProgress: document.getElementById('item-progress'),
  itemProgressVal: document.getElementById('item-progress-val'),
  itemMilestones: document.getElementById('item-milestones'),
  btnDeleteItem: document.getElementById('btn-delete-item'),
  btnModalCancel: document.getElementById('btn-modal-cancel'),
  btnUndo: document.getElementById('btn-undo'),
  btnToday: document.getElementById('btn-today'),
  btnExport: document.getElementById('btn-export'),
  btnBackup: document.getElementById('btn-backup'),
  saveNotice: document.getElementById('save-notice'),
  saveMessage: document.getElementById('save-message'),
  btnRetry: document.getElementById('btn-retry'),
  btnDraft: document.getElementById('btn-draft'),
  btnReload: document.getElementById('btn-reload'),
  ganttWrap: document.querySelector('.gantt-wrap'),
};

// ---------- API ----------

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `请求失败 ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

const saveQueue = new SaveQueue(body => api('PUT', API_ROADMAP, body), queue => {
  els.saveStatus.textContent = queue.error ? '尚未保存' : queue.dirty ? '正在保存…' : '已保存';
  els.saveStatus.classList.toggle('error', Boolean(queue.error));
  els.saveNotice.classList.toggle('hidden', !queue.error);
  els.btnRetry.classList.toggle('hidden', !queue.error || queue.error.status === 409);
  els.btnReload.disabled = queue.running;
  if (queue.error) els.saveMessage.textContent = queue.error.message + ' 本页修改仍保留。';
});

async function loadRoadmap() {
  const data = await api('GET', API_ROADMAP);
  saveQueue.reset(data.revision);
  roadmap = data;
  loaded = true;
  els.btnDraft.disabled = false;
  history.length = 0;
  updateUndoBtn();
  render();
}

function saveRoadmap() {
  return saveQueue.enqueue(roadmap);
}

function downloadJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showLoadError(error) {
  els.saveStatus.textContent = '加载失败';
  els.saveStatus.classList.add('error');
  els.saveNotice.classList.remove('hidden');
  els.saveMessage.textContent = error.message;
  els.btnRetry.classList.add('hidden');
  els.btnDraft.disabled = !loaded;
}

// ---------- Undo ----------

function pushHistory() {
  history.push(JSON.stringify(roadmap));
  if (history.length > 50) history.shift();
  updateUndoBtn();
}

function undo() {
  if (!history.length) return;
  roadmap = JSON.parse(history.pop());
  render();
  saveRoadmap();
  updateUndoBtn();
}

function updateUndoBtn() {
  els.btnUndo.disabled = history.length === 0;
}

// ---------- Date helpers ----------

function parseDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  const value = new Date(0);
  value.setFullYear(y, m - 1, d);
  value.setHours(0, 0, 0, 0);
  return value.getFullYear() === y && value.getMonth() === m - 1 && value.getDate() === d ? value : null;
}

function toISODate(d) {
  if (!d) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayStr() {
  return toISODate(new Date());
}

function addDays(d, n) {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

function getMonday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
}

function getSunday(d) {
  return addDays(getMonday(d), 6);
}

function daysDiff(d1, d2) {
  const calendarDay = d => {
    const utc = new Date(0);
    utc.setUTCFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    utc.setUTCHours(0, 0, 0, 0);
    return utc.getTime();
  };
  return (calendarDay(d2) - calendarDay(d1)) / 86400000;
}

function uuid() {
  return 'id-' + Math.random().toString(36).slice(2, 9);
}

function clampNumber(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function itemProgress(item) {
  const p = parseInt(item.progress, 10);
  return isNaN(p) ? 0 : clampNumber(p, 0, 100);
}

function isOverdue(item) {
  return item.end && item.end < todayStr() && itemProgress(item) < 100;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Timeline computation ----------

function dayPx() {
  if (zoom === 'day') return 34;
  if (zoom === 'month') return 2.4;
  return 64 / 7; // week
}

function computeTimeline() {
  let min = parseDate(roadmap.startDate);
  let max = parseDate(roadmap.endDate);

  roadmap.lanes.forEach(lane => {
    lane.items.forEach(item => {
      const s = parseDate(item.start);
      const e = parseDate(item.end);
      if (s && (!min || s < min)) min = s;
      if (e && (!max || e > max)) max = e;
    });
  });

  if (!min) min = getMonday(new Date());
  if (!max) max = addDays(min, 83); // +12 weeks

  segments = [];

  if (zoom === 'month') {
    timelineStart = new Date(min.getFullYear(), min.getMonth(), 1);
    timelineEnd = new Date(max.getFullYear(), max.getMonth() + 1, 0); // 月末
    let cur = new Date(timelineStart);
    while (cur <= timelineEnd) {
      const y = cur.getFullYear();
      const m = cur.getMonth();
      const days = new Date(y, m + 1, 0).getDate();
      segments.push({
        date: new Date(cur),
        days,
        label: m === 0 ? `${y}年1月` : `${m + 1}月`,
      });
      cur = new Date(y, m + 1, 1);
    }
  } else {
    timelineStart = getMonday(min);
    timelineEnd = getSunday(max);
    let cur = new Date(timelineStart);
    while (cur <= timelineEnd) {
      if (zoom === 'day') {
        const wd = cur.getDay();
        segments.push({
          date: new Date(cur),
          days: 1,
          label: `${cur.getMonth() + 1}/${cur.getDate()}`,
          weekend: wd === 0 || wd === 6,
        });
        cur = addDays(cur, 1);
      } else {
        segments.push({
          date: new Date(cur),
          days: 7,
          label: `${String(cur.getMonth() + 1).padStart(2, '0')}/${String(cur.getDate()).padStart(2, '0')}`,
        });
        cur = addDays(cur, 7);
      }
    }
  }

  totalDays = segments.reduce((sum, s) => sum + s.days, 0);
}

function gridCols() {
  const px = dayPx();
  return segments.map(s => `${(s.days * px).toFixed(2)}px`).join(' ');
}

function leftPaddingPx() {
  const rootStyle = getComputedStyle(document.documentElement);
  const nameW = parseFloat(rootStyle.getPropertyValue('--lane-name-width')) || 190;
  const groupW = hasGroup ? (parseFloat(rootStyle.getPropertyValue('--group-width')) || 110) : 0;
  return { nameW, groupW };
}

// ---------- Track assignment to avoid overlapping ----------

function assignTracks(items) {
  if (!items || !items.length) return { assignments: [], trackCount: 0 };

  const indexed = items.map((item, idx) => ({ idx, start: item.start, end: item.end }));
  indexed.sort((a, b) => a.start.localeCompare(b.start));

  const endTimes = [];
  const assignments = new Array(items.length).fill(0);

  indexed.forEach(entry => {
    const { idx, start, end } = entry;
    let placed = false;
    for (let t = 0; t < endTimes.length; t++) {
      if (start > endTimes[t]) {
        assignments[idx] = t;
        endTimes[t] = end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      assignments[idx] = endTimes.length;
      endTimes.push(end);
    }
  });

  return { assignments, trackCount: endTimes.length };
}

// ---------- Rendering ----------

function render() {
  hasGroup = roadmap.lanes.some(l => l.group);
  computeTimeline();
  els.pageTitle.textContent = roadmap.title || '研发进度规划';
  els.gantt.innerHTML = '';
  els.gantt.style.gridTemplateColumns = hasGroup
    ? 'var(--group-width) var(--lane-name-width) 1fr'
    : 'var(--lane-name-width) 1fr';

  // 分组色带：连续相同 group 的工作行合并为一个分组格
  const groupColorMap = Object.create(null);
  let colorIdx = 0;
  const groupOf = lane => {
    const g = lane.group || '';
    if (g && !(g in groupColorMap)) {
      groupColorMap[g] = GROUP_COLORS[colorIdx % GROUP_COLORS.length];
      colorIdx++;
    }
    return g ? groupColorMap[g] : '';
  };

  let i = 0;
  while (i < roadmap.lanes.length) {
    const g = roadmap.lanes[i].group || '';
    let j = i;
    while (j < roadmap.lanes.length && (roadmap.lanes[j].group || '') === g) j++;
    const runLen = j - i;

    if (hasGroup) {
      if (g) {
        const collapsed = collapsedGroups.has(g);
        const taskCount = roadmap.lanes.slice(i, j)
          .reduce((sum, l) => sum + l.items.length, 0);
        const gc = document.createElement('div');
        gc.className = 'group-cell' + (collapsed ? ' collapsed' : '');
        gc.style.gridColumn = '1';
        gc.style.gridRow = `span ${collapsed ? 1 : runLen}`;
        gc.style.background = groupOf(roadmap.lanes[i]);
        gc.title = `${g}（双击重命名分组）`;

        const toggle = document.createElement('span');
        toggle.className = 'group-toggle';
        toggle.textContent = collapsed ? '▸' : '▾';
        toggle.title = collapsed ? '展开分组' : '收起分组';
        toggle.onclick = e => {
          e.stopPropagation();
          if (collapsed) collapsedGroups.delete(g);
          else collapsedGroups.add(g);
          localStorage.setItem('roadmap_collapsed', JSON.stringify([...collapsedGroups]));
          render();
        };
        gc.appendChild(toggle);

        const label = document.createElement('span');
        label.className = 'group-label';
        label.textContent = collapsed ? `${g}（${taskCount}）` : g;
        gc.appendChild(label);

        gc.ondblclick = () => startGroupRename(gc, g);
        els.gantt.appendChild(gc);

        if (collapsed) {
          const strip = document.createElement('div');
          strip.className = 'group-collapsed-strip';
          strip.style.gridColumn = '2 / -1';
          strip.style.background = groupOf(roadmap.lanes[i]);
          els.gantt.appendChild(strip);
          i = j;
          continue;
        }
      } else {
        const filler = document.createElement('div');
        filler.className = 'group-cell empty';
        filler.style.gridColumn = '1';
        filler.style.gridRow = `span ${runLen}`;
        els.gantt.appendChild(filler);
      }
    }

    for (let k = i; k < j; k++) {
      els.gantt.appendChild(renderLaneName(roadmap.lanes[k], k));
      els.gantt.appendChild(renderLaneRow(roadmap.lanes[k], k, groupOf(roadmap.lanes[k])));
    }
    i = j;
  }

  const addLaneBtn = document.createElement('div');
  addLaneBtn.className = 'add-lane-btn';
  addLaneBtn.textContent = '+ 添加工作行';
  addLaneBtn.onclick = addLane;
  els.gantt.appendChild(addLaneBtn);

  renderAxis();
  renderTodayLine();
  fixupLabels();
}

function renderAxis() {
  if (hasGroup) {
    const cornerG = document.createElement('div');
    cornerG.className = 'axis-corner';
    els.gantt.appendChild(cornerG);
  }
  const corner = document.createElement('div');
  corner.className = 'axis-corner';
  els.gantt.appendChild(corner);

  const axis = document.createElement('div');
  axis.className = 'axis';
  axis.style.gridTemplateColumns = gridCols();
  segments.forEach(seg => {
    const tick = document.createElement('span');
    tick.className = 'axis-tick' + (seg.weekend ? ' weekend' : '');
    tick.textContent = seg.label;
    axis.appendChild(tick);
  });
  els.gantt.appendChild(axis);
}

function renderLaneName(lane, laneIdx) {
  const el = document.createElement('div');
  el.className = 'lane-name';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'lane-name-text';
  nameSpan.textContent = lane.name;
  nameSpan.title = `${lane.name}（双击重命名）`;
  nameSpan.ondblclick = () => startLaneRename(el, lane);
  el.appendChild(nameSpan);

  const controls = document.createElement('span');
  controls.className = 'lane-controls';
  controls.innerHTML = `
    <button type="button" class="lane-btn" data-act="group" title="设置分组">组</button>
    <button type="button" class="lane-btn" data-act="rename" title="重命名">✎</button>
    <button type="button" class="lane-btn" data-act="up" title="上移">↑</button>
    <button type="button" class="lane-btn" data-act="down" title="下移">↓</button>
    <button type="button" class="lane-btn danger" data-act="del" title="删除该行">✕</button>`;
  controls.querySelector('[data-act="group"]').onclick = () => setLaneGroup(lane);
  controls.querySelector('[data-act="rename"]').onclick = () => startLaneRename(el, lane);
  controls.querySelector('[data-act="up"]').onclick = () => moveLane(laneIdx, -1);
  controls.querySelector('[data-act="down"]').onclick = () => moveLane(laneIdx, 1);
  controls.querySelector('[data-act="del"]').onclick = () => deleteLane(laneIdx);
  el.appendChild(controls);

  return el;
}

function startLaneRename(el, lane) {
  const old = el.querySelector('.lane-name-text');
  if (!old) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lane-name-input';
  input.value = lane.name;
  el.replaceChild(input, old);
  input.focus();
  input.select();
  const commit = () => {
    pushHistory();
    lane.name = input.value.trim() || lane.name;
    render();
    saveRoadmap();
  };
  input.onblur = commit;
  input.onkeydown = e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.onblur = null; render(); }
  };
}

function startGroupRename(cell, oldName) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lane-name-input group-rename-input';
  input.value = oldName;
  cell.textContent = '';
  cell.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim() || oldName;
    pushHistory();
    roadmap.lanes.forEach(l => { if (l.group === oldName) l.group = v; });
    render();
    saveRoadmap();
  };
  input.onblur = commit;
  input.onkeydown = e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.onblur = null; render(); }
  };
}

function setLaneGroup(lane) {
  const v = prompt('设置所属分组（相邻且同名的工作行会合并显示色带；留空取消分组）', lane.group || '');
  if (v === null) return;
  pushHistory();
  lane.group = v.trim();
  render();
  saveRoadmap();
}

function renderLaneRow(lane, laneIdx, bandColor) {
  const row = document.createElement('div');
  row.className = 'lane-row';
  row.dataset.laneIdx = laneIdx;
  row.style.gridTemplateColumns = gridCols();
  if (bandColor) {
    row.style.background = bandColor;
  } else if (laneIdx % 2 === 1) {
    row.classList.add('band');
  }

  segments.forEach(seg => {
    const cell = document.createElement('div');
    cell.className = 'week-cell' + (seg.weekend ? ' weekend' : '');
    row.appendChild(cell);
  });

  const { assignments, trackCount } = assignTracks(lane.items);
  const itemH = 26;
  const gap = 6;
  const baseTop = 8;
  row.style.height = Math.max(46, baseTop + trackCount * (itemH + gap) + 6) + 'px';

  lane.items.forEach((item, itemIdx) => {
    row.appendChild(renderItem(item, laneIdx, itemIdx, assignments[itemIdx]));
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'add-item-btn';
  addBtn.textContent = '+ 任务';
  addBtn.title = '添加任务';
  addBtn.onclick = e => { e.stopPropagation(); openItemModal(laneIdx); };
  row.appendChild(addBtn);

  // 空白处点击：在该日期位置新建任务
  row.addEventListener('click', e => {
    if (suppressRowClick) return;
    if (e.target.closest('.gantt-item') || e.target.closest('.add-item-btn')) return;
    const rect = row.getBoundingClientRect();
    const x = clampNumber(e.clientX - rect.left, 0, rect.width - 1);
    const dayIdx = Math.floor(x / dayPx());
    const date = addDays(timelineStart, clampNumber(dayIdx, 0, totalDays - 1));
    openItemModal(laneIdx, -1, toISODate(date));
  });

  return row;
}

function renderItem(item, laneIdx, itemIdx, trackIdx) {
  const startDay = clampNumber(daysDiff(timelineStart, parseDate(item.start)), 0, totalDays - 1);
  const endDay = clampNumber(daysDiff(timelineStart, parseDate(item.end)), 0, totalDays - 1);
  const sd = Math.min(startDay, endDay);
  const ed = Math.max(startDay, endDay);
  const startPct = (sd / totalDays) * 100;
  const widthPct = ((ed - sd + 1) / totalDays) * 100;

  const bar = document.createElement('div');
  bar.className = 'gantt-item';
  bar.style.left = startPct + '%';
  bar.style.width = widthPct + '%';
  bar.style.top = (8 + (trackIdx || 0) * 32) + 'px';

  const progress = itemProgress(item);
  // 状态着色：完成深紫 / 逾期红 / 未开始空心 / 进行中紫
  if (progress >= 100) {
    bar.classList.add('done');
  } else if (isOverdue(item)) {
    bar.classList.add('overdue');
  } else if (progress === 0) {
    bar.classList.add('not-started');
  }

  if (progress > 0 && progress < 100) {
    const fill = document.createElement('div');
    fill.className = 'gantt-item-progress';
    fill.style.width = progress + '%';
    bar.appendChild(fill);
  }

  const labelText = (progress > 0 && progress < 100) ? `${item.name} ${progress}%` : item.name;

  if (progress >= 100 || startPct + widthPct > 68) {
    // 已完成或条形靠右：标签放条内（白字）
    const label = document.createElement('span');
    label.className = 'gantt-item-label';
    label.textContent = labelText;
    bar.appendChild(label);
  } else {
    // 标签放条形右侧（与参考图一致）
    const label = document.createElement('span');
    label.className = 'item-label-out';
    label.textContent = labelText;
    bar.appendChild(label);
    bar.dataset.labelText = labelText;
  }

  bar.title = `${item.name}: ${item.start} ~ ${item.end} · 进度 ${progress}%\n拖动平移，上下拖到其他工作行，拖两端改起止，点击打开编辑`;

  (item.milestones || []).forEach(ms => {
    const msDay = clampNumber(daysDiff(timelineStart, parseDate(ms.date)), 0, totalDays - 1);
    if (msDay < sd || msDay > ed) return;
    const diamond = document.createElement('div');
    diamond.className = 'milestone';
    diamond.title = `${ms.date} ${ms.name}`;
    diamond.style.left = ((msDay - sd) / (ed - sd + 1)) * 100 + '%';
    bar.appendChild(diamond);
  });

  // 拖拽手柄（左右边缘改起止日期）
  ['l', 'r'].forEach(side => {
    const h = document.createElement('div');
    h.className = 'drag-' + side;
    bar.appendChild(h);
  });

  enableBarDrag(bar, laneIdx, itemIdx);
  return bar;
}

// ---------- Drag editing ----------

function enableBarDrag(bar, laneIdx, itemIdx) {
  bar.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const item = (roadmap.lanes[laneIdx] || {}).items?.[itemIdx];
    if (!item) return;

    const mode = e.target.classList.contains('drag-l') ? 'l'
      : e.target.classList.contains('drag-r') ? 'r' : 'move';
    const startX = e.clientX;
    const pxDay = dayPx();
    const s0 = parseDate(item.start);
    const e0 = parseDate(item.end);
    if (!s0 || !e0) return;

    let moved = false;
    let ns = s0;
    let ne = e0;
    let targetLaneIdx = laneIdx;
    const rows = Array.from(els.gantt.querySelectorAll('.lane-row'));
    bar.classList.add('dragging');
    document.body.classList.add('no-select');

    const tip = document.createElement('div');
    tip.className = 'drag-tip';
    bar.appendChild(tip);

    const fmt = d => toISODate(d).slice(5).replace('-', '/');

    function applyPreview() {
      const sd = clampNumber(daysDiff(timelineStart, ns), 0, totalDays - 1);
      const ed = clampNumber(daysDiff(timelineStart, ne), 0, totalDays - 1);
      bar.style.left = (sd / totalDays) * 100 + '%';
      bar.style.width = ((ed - sd + 1) / totalDays) * 100 + '%';
      const laneName = targetLaneIdx !== laneIdx
        ? ` → ${roadmap.lanes[targetLaneIdx].name}` : '';
      tip.textContent = `${fmt(ns)} ~ ${fmt(ne)}${laneName}`;
    }

    function onMove(ev) {
      const d = Math.round((ev.clientX - startX) / pxDay);
      // 垂直方向：移到其他泳道 = 调整任务归属
      if (mode === 'move') {
        const y = ev.clientY;
        rows.forEach(row => {
          const r = row.getBoundingClientRect();
          if (y >= r.top && y <= r.bottom) targetLaneIdx = parseInt(row.dataset.laneIdx, 10);
        });
      }
      if (!moved && Math.abs(ev.clientX - startX) <= 3 && targetLaneIdx === laneIdx) return;
      moved = true;
      rows.forEach(row => {
        row.classList.toggle('drop-target',
          mode === 'move' && parseInt(row.dataset.laneIdx, 10) === targetLaneIdx && targetLaneIdx !== laneIdx);
      });
      if (mode === 'move') {
        ns = addDays(s0, d);
        ne = addDays(e0, d);
      } else if (mode === 'l') {
        ns = new Date(Math.min(addDays(s0, d), e0));
      } else {
        ne = new Date(Math.max(addDays(e0, d), s0));
      }
      applyPreview();
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('no-select');
      bar.classList.remove('dragging');
      rows.forEach(row => row.classList.remove('drop-target'));
      tip.remove();
      if (!moved) {
        openItemModal(laneIdx, itemIdx);
        return;
      }
      // 阻止随后的 click 在行空白处误触发新建
      suppressRowClick = true;
      setTimeout(() => { suppressRowClick = false; }, 100);
      pushHistory();
      item.start = toISODate(ns);
      item.end = toISODate(ne);
      if (targetLaneIdx !== laneIdx) {
        roadmap.lanes[laneIdx].items.splice(itemIdx, 1);
        roadmap.lanes[targetLaneIdx].items.push(item);
      }
      render();
      saveRoadmap();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// 外侧标签若与其他任务条重叠，则改放回条内
function fixupLabels() {
  const bars = Array.from(els.gantt.querySelectorAll('.gantt-item'));
  const rects = bars.map(b => b.getBoundingClientRect());
  bars.forEach((bar, i) => {
    const label = bar.querySelector('.item-label-out');
    if (!label) return;
    const lr = label.getBoundingClientRect();
    const hit = rects.some((r, j) => j !== i
      && lr.left < r.right && lr.right > r.left
      && lr.top < r.bottom && lr.bottom > r.top);
    if (hit) {
      label.remove();
      const inside = document.createElement('span');
      inside.className = 'gantt-item-label';
      inside.textContent = bar.dataset.labelText;
      bar.appendChild(inside);
    }
  });
}

function renderTodayLine() {
  const today = parseDate(todayStr());
  if (today < timelineStart || today > timelineEnd) return;

  const { nameW, groupW } = leftPaddingPx();
  const offset = clampNumber(daysDiff(timelineStart, today), 0, totalDays);

  const line = document.createElement('div');
  line.className = 'today-line';
  line.style.left = (nameW + groupW + offset * dayPx()) + 'px';
  els.gantt.appendChild(line);
}

// ---------- Editing ----------

function addLane() {
  pushHistory();
  roadmap.lanes.push({ id: uuid(), name: '新工作行', items: [] });
  render();
  saveRoadmap();
  const names = els.gantt.querySelectorAll('.lane-name');
  const last = names[names.length - 1];
  if (last) startLaneRename(last, roadmap.lanes[roadmap.lanes.length - 1]);
}

function moveLane(laneIdx, dir) {
  const target = laneIdx + dir;
  if (target < 0 || target >= roadmap.lanes.length) return;
  pushHistory();
  const lanes = roadmap.lanes;
  [lanes[laneIdx], lanes[target]] = [lanes[target], lanes[laneIdx]];
  render();
  saveRoadmap();
}

function deleteLane(laneIdx) {
  const lane = roadmap.lanes[laneIdx];
  if (lane.items.length > 0 && !confirm(`工作行「${lane.name}」里有 ${lane.items.length} 个任务，确定删除整行吗？`)) return;
  pushHistory();
  roadmap.lanes.splice(laneIdx, 1);
  render();
  saveRoadmap();
}

async function openItemModal(laneIdx, itemIdx = -1, presetStart = '') {
  const lane = roadmap.lanes[laneIdx];
  const isNew = itemIdx === -1;
  const start = presetStart || todayStr();
  const item = isNew
    ? { id: uuid(), name: '', start, end: toISODate(addDays(parseDate(start), 13)), progress: 0, milestones: [] }
    : lane.items[itemIdx];

  els.modalTitle.textContent = isNew ? '添加任务' : '编辑任务';
  els.itemLaneIdx.value = laneIdx;
  els.itemIdx.value = itemIdx;
  els.itemName.value = item.name;
  els.itemStart.value = item.start;
  els.itemEnd.value = item.end;
  els.itemProgress.value = itemProgress(item);
  els.itemProgressVal.textContent = itemProgress(item);
  els.itemMilestones.value = (item.milestones || [])
    .map(ms => `${ms.date} ${ms.name}`)
    .join('\n');

  const currentLink = item.taskLink
    ? JSON.stringify({ projectId: item.taskLink.projectId, taskId: item.taskLink.taskId }) : '';
  els.itemTaskLink.replaceChildren(new Option('不关联', ''));
  if (currentLink) els.itemTaskLink.add(new Option('当前关联（正在加载…）', currentLink));
  els.itemTaskLink.value = currentLink;
  els.itemTaskLink.disabled = true;

  els.btnDeleteItem.classList.toggle('hidden', isNew);
  els.modal.classList.remove('hidden');
  els.modal.setAttribute('aria-hidden', 'false');
  els.itemName.focus();
  // Keep a failed lookup from silently removing an existing association.
  const token = {};
  openItemModal.token = token;
  try {
    const data = await api('GET', '/api/projects');
    if (openItemModal.token !== token || els.modal.classList.contains('hidden')) return;
    linkedProjects = data.projects;
    const used = new Set();
    roadmap.lanes.forEach((l, li) => l.items.forEach((it, ii) => {
      if (it.taskLink && !(li === laneIdx && ii === itemIdx)) {
        used.add(`${it.taskLink.projectId}/${it.taskLink.taskId}`);
      }
    }));
    els.itemTaskLink.replaceChildren(new Option('不关联', ''));
    linkedProjects.forEach(project => project.tasks.forEach(task => {
      if (used.has(`${project.id}/${task.id}`)) return;
      const link = JSON.stringify({ projectId: project.id, taskId: task.id });
      els.itemTaskLink.add(new Option(`${project.name} / ${task.title}${task.done ? '（已完成）' : ''}`, link));
    }));
    if (currentLink && !Array.from(els.itemTaskLink.options).some(o => o.value === currentLink)) {
      els.itemTaskLink.add(new Option('原关联任务已不存在（请选择不关联）', currentLink));
    }
    els.itemTaskLink.value = currentLink;
    els.itemTaskLink.disabled = false;
  } catch (error) {
    if (openItemModal.token === token) {
      els.itemTaskLink.options[els.itemTaskLink.selectedIndex].text += '（加载失败，重新打开可重试）';
    }
  }
}

function closeModal() {
  els.modal.classList.add('hidden');
  els.modal.setAttribute('aria-hidden', 'true');
}

function saveItemModal(e) {
  e.preventDefault();
  const laneIdx = parseInt(els.itemLaneIdx.value, 10);
  const itemIdx = parseInt(els.itemIdx.value, 10);
  const lane = roadmap.lanes[laneIdx];

  const start = els.itemStart.value;
  const end = els.itemEnd.value;
  if (!els.itemName.value.trim() || !parseDate(start) || !parseDate(end) || start > end) {
    alert('请填写任务名称和有效日期，开始日期不能晚于结束日期');
    return;
  }
  const progress = clampNumber(parseInt(els.itemProgress.value, 10) || 0, 0, 100);
  const milestones = [];
  for (const line of els.itemMilestones.value.split('\n').map(s => s.trim()).filter(Boolean)) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
    if (!match || !parseDate(match[1])) {
      alert(`里程碑格式或日期无效：${line}`);
      return;
    }
    milestones.push({ date: match[1], name: match[2] });
  }

  const item = {
    ...(itemIdx >= 0 ? lane.items[itemIdx] : {}),
    id: itemIdx >= 0 ? lane.items[itemIdx].id : uuid(),
    name: els.itemName.value.trim(),
    start: els.itemStart.value,
    end: els.itemEnd.value,
    progress,
    milestones,
  };
  if (els.itemTaskLink.value) item.taskLink = JSON.parse(els.itemTaskLink.value);
  else delete item.taskLink;

  pushHistory();
  if (itemIdx >= 0) {
    lane.items[itemIdx] = item;
  } else {
    lane.items.push(item);
  }

  closeModal();
  render();
  saveRoadmap();
}

function deleteItem() {
  const laneIdx = parseInt(els.itemLaneIdx.value, 10);
  const itemIdx = parseInt(els.itemIdx.value, 10);
  if (!confirm('确定删除这个任务吗？')) return;
  pushHistory();
  roadmap.lanes[laneIdx].items.splice(itemIdx, 1);
  closeModal();
  render();
  saveRoadmap();
}

// ---------- Events ----------

els.itemForm.addEventListener('submit', saveItemModal);
els.btnDeleteItem.addEventListener('click', deleteItem);
els.btnModalCancel.addEventListener('click', closeModal);
els.modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);
els.btnUndo.addEventListener('click', undo);
els.btnExport.addEventListener('click', () => window.print());
els.btnBackup.addEventListener('click', async () => {
  try {
    if (saveQueue.dirty) {
      alert('本页还有未保存修改，请等待保存完成，或使用“下载本页草稿”。');
      return;
    }
    downloadJSON(await api('GET', '/api/export'), `local-pm-${todayStr()}.json`);
  } catch (error) { alert('备份失败：' + error.message); }
});
els.btnRetry.addEventListener('click', () => saveQueue.retry());
els.btnDraft.addEventListener('click', () => {
  downloadJSON({ kind: 'roadmap-draft', roadmap }, `roadmap-draft-${todayStr()}.json`);
});
els.btnReload.addEventListener('click', async () => {
  if (saveQueue.dirty && !confirm('加载最新版本会丢弃本页未保存修改。请先下载草稿，确定继续吗？')) return;
  try { await loadRoadmap(); closeModal(); } catch (error) { showLoadError(error); }
});
els.itemTaskLink.addEventListener('change', () => {
  if (!els.itemTaskLink.value) return;
  const link = JSON.parse(els.itemTaskLink.value);
  const task = linkedProjects.find(p => p.id === link.projectId)?.tasks.find(t => t.id === link.taskId);
  if (!task) return;
  if (!els.itemName.value.trim()) els.itemName.value = task.title;
  els.itemProgress.value = task.done ? 100 : Number(els.itemProgress.value) === 100 ? 0 : els.itemProgress.value;
  els.itemProgressVal.textContent = els.itemProgress.value;
});
window.addEventListener('beforeunload', e => {
  if (!saveQueue.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});
els.itemProgress.addEventListener('input', () => {
  els.itemProgressVal.textContent = els.itemProgress.value;
});
els.btnToday.addEventListener('click', () => {
  const today = parseDate(todayStr());
  if (today < timelineStart || today > timelineEnd) return;
  const { nameW, groupW } = leftPaddingPx();
  const x = nameW + groupW + daysDiff(timelineStart, today) * dayPx();
  els.ganttWrap.scrollTo({ left: x - els.ganttWrap.clientWidth / 2, behavior: 'smooth' });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !els.modal.classList.contains('hidden')) {
    closeModal();
    return;
  }
  // Cmd/Ctrl+Z 撤销（弹窗打开时不拦截，让输入框自己处理）
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z'
    && els.modal.classList.contains('hidden')) {
    e.preventDefault();
    undo();
  }
});

els.zoomSwitch.querySelectorAll('button').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.zoom === zoom);
  btn.onclick = () => {
    zoom = btn.dataset.zoom;
    localStorage.setItem('roadmap_zoom', zoom);
    els.zoomSwitch.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    render();
  };
});

loadRoadmap().catch(showLoadError);
