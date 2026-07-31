const API_ROADMAP = '/api/roadmap';

let roadmap = { title: '研发进度规划', startDate: '', endDate: '', lanes: [] };
let isEditing = false;
let timelineStart = null;
let timelineEnd = null;
let weekCount = 0;
let weeks = [];

const els = {
  gantt: document.getElementById('gantt'),
  pageTitle: document.getElementById('page-title'),
  btnEdit: document.getElementById('btn-edit'),
  btnSave: document.getElementById('btn-save'),
  btnCancel: document.getElementById('btn-cancel'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modal-title'),
  itemForm: document.getElementById('item-form'),
  itemLaneIdx: document.getElementById('item-lane-idx'),
  itemIdx: document.getElementById('item-idx'),
  itemName: document.getElementById('item-name'),
  itemStart: document.getElementById('item-start'),
  itemEnd: document.getElementById('item-end'),
  itemProgress: document.getElementById('item-progress'),
  itemColor: document.getElementById('item-color'),
  itemMilestones: document.getElementById('item-milestones'),
  btnDeleteItem: document.getElementById('btn-delete-item'),
  btnModalCancel: document.getElementById('btn-modal-cancel'),
  btnOkrEdit: document.getElementById('btn-okr-edit'),
  okrModal: document.getElementById('okr-modal'),
  okrJson: document.getElementById('okr-json'),
  btnOkrClear: document.getElementById('btn-okr-clear'),
  btnOkrCancel: document.getElementById('btn-okr-cancel'),
  btnOkrSave: document.getElementById('btn-okr-save'),
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
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

async function loadRoadmap() {
  roadmap = await api('GET', API_ROADMAP);
  render();
  renderOkr();
}

async function saveRoadmap() {
  // Sync any pending lane name edits before saving
  document.querySelectorAll('.lane-name-input').forEach(input => {
    const idx = parseInt(input.dataset.laneIdx, 10);
    if (roadmap.lanes[idx]) {
      roadmap.lanes[idx].name = input.value.trim() || roadmap.lanes[idx].name;
    }
  });
  await api('PUT', API_ROADMAP, roadmap);
  isEditing = false;
  updateToolbar();
  render();
  renderOkr();
}

// ---------- Date helpers ----------

function parseDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
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

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
}

function daysDiff(d1, d2) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((d2 - d1) / msPerDay);
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

function laneProgress(lane) {
  let totalW = 0;
  let sum = 0;
  lane.items.forEach(item => {
    const s = parseDate(item.start);
    const e = parseDate(item.end);
    const w = (s && e) ? Math.max(1, daysDiff(s, e) + 1) : 1;
    totalW += w;
    sum += itemProgress(item) * w;
  });
  return totalW ? Math.round(sum / totalW) : 0;
}

function laneProgressHtml(pct) {
  return '<span class="lane-progress" title="按工期加权的平均进度">'
    + '<span class="lane-progress-track"><span class="lane-progress-fill" style="width:' + pct + '%"></span></span>'
    + pct + '%</span>';
}

function laneNameWidth() {
  const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lane-name-width'));
  return isNaN(w) ? 200 : w;
}

// ---------- Timeline computation ----------

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
  if (!max) max = new Date(min.getTime() + 84 * 24 * 60 * 60 * 1000); // +12 weeks

  timelineStart = getMonday(min);
  timelineEnd = getMonday(new Date(max.getTime() + 6 * 24 * 60 * 60 * 1000));

  weeks = [];
  let cur = new Date(timelineStart);
  while (cur <= timelineEnd) {
    weeks.push(new Date(cur));
    cur.setDate(cur.getDate() + 7);
  }
  weekCount = weeks.length;
}

function dayOffsetInTimeline(date) {
  const d = parseDate(date);
  if (!d) return 0;
  return clampNumber(daysDiff(timelineStart, d), 0, weekCount * 7 - 1);
}

// ---------- Rendering ----------

function render() {
  computeTimeline();
  document.documentElement.style.setProperty('--week-count', weekCount);
  els.pageTitle.textContent = roadmap.title || '研发进度规划';
  els.gantt.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'gantt-header';
  header.innerHTML = `
    <div class="header-corner">工作内容</div>
    <div class="header-months" id="header-months"></div>
    <div class="header-corner"></div>
    <div class="header-weeks" id="header-weeks"></div>
  `;
  els.gantt.appendChild(header);

  renderHeaderMonths(header.querySelector('#header-months'));
  renderHeaderWeeks(header.querySelector('#header-weeks'));

  const body = document.createElement('div');
  body.className = 'gantt-body';
  els.gantt.appendChild(body);

  roadmap.lanes.forEach((lane, laneIdx) => {
    body.appendChild(renderLaneName(lane, laneIdx));
    body.appendChild(renderLaneRow(lane, laneIdx));
  });

  if (isEditing) {
    const addLaneRow = document.createElement('div');
    addLaneRow.className = 'add-lane-btn';
    addLaneRow.style.gridColumn = '1 / -1';
    addLaneRow.textContent = '+ 添加工作行';
    addLaneRow.onclick = addLane;
    body.appendChild(addLaneRow);
  }

  renderTodayLine(body);
  setupCursorLine(body);
}

function setupCursorLine(body) {
  const line = document.createElement('div');
  line.className = 'cursor-line';
  body.appendChild(line);

  const nameWidth = laneNameWidth();

  function moveToDate(date) {
    const totalDays = weekCount * 7;
    const offsetDays = daysDiff(timelineStart, date);
    const ratio = clampNumber(offsetDays / totalDays, 0, 1);
    line.style.left = `calc(${nameWidth}px + ${ratio * 100} * (100% - ${nameWidth}px) / 100)`;
    line.dataset.date = toISODate(date);
  }

  const today = new Date();
  const defaultDate = (today >= timelineStart && today <= new Date(timelineEnd.getTime() + 6 * 24 * 60 * 60 * 1000))
    ? today
    : timelineStart;
  moveToDate(defaultDate);
  line.style.display = 'none';

  body.addEventListener('mouseenter', () => { line.style.display = 'block'; });
  body.addEventListener('mouseleave', () => {
    line.style.display = 'none';
    moveToDate(defaultDate);
  });
  body.addEventListener('mousemove', e => {
    const rect = body.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const timelineWidth = rect.width - nameWidth;
    let ratio = clampNumber((x - nameWidth) / timelineWidth, 0, 1);
    const totalDays = weekCount * 7;
    const offsetDays = Math.round(ratio * totalDays);
    const date = new Date(timelineStart);
    date.setDate(date.getDate() + offsetDays);
    moveToDate(date);
  });
}

function renderHeaderMonths(container) {
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const totalDays = weekCount * 7;
  const endExclusive = new Date(timelineStart.getTime() + totalDays * 24 * 60 * 60 * 1000);

  // Day-precise month segments: a month boundary mid-week lands exactly on the 1st
  let cur = new Date(timelineStart.getFullYear(), timelineStart.getMonth(), 1);
  while (cur < endExclusive) {
    const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    const segStart = cur < timelineStart ? timelineStart : cur;
    const segEnd = next > endExclusive ? endExclusive : next;
    const widthPct = (daysDiff(segStart, segEnd) / totalDays) * 100;
    const cell = document.createElement('div');
    cell.className = 'header-month';
    // Segment too narrow to show a label (e.g. 1-2 trailing days of a month)
    if (widthPct >= 5) {
      cell.textContent = `${cur.getFullYear()}年${monthNames[cur.getMonth()]}`;
    }
    cell.style.left = (daysDiff(timelineStart, segStart) / totalDays) * 100 + '%';
    cell.style.width = widthPct + '%';
    container.appendChild(cell);
    cur = next;
  }
}

function renderHeaderWeeks(container) {
  weeks.forEach((week) => {
    const cell = document.createElement('div');
    cell.className = 'header-week';
    const weekNum = getWeekNumber(week);
    cell.textContent = `${weekNum}周`;
    container.appendChild(cell);
  });
}

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function renderLaneName(lane, laneIdx) {
  const el = document.createElement('div');
  el.className = 'lane-name';
  if (isEditing) {
    el.innerHTML = `<input type="text" value="${escapeHtml(lane.name)}" data-lane-idx="${laneIdx}" class="lane-name-input">
      <div class="lane-controls">
        <button type="button" class="lane-btn" data-act="up" title="上移">↑</button>
        <button type="button" class="lane-btn" data-act="down" title="下移">↓</button>
        <button type="button" class="lane-btn danger" data-act="del" title="删除该行">✕</button>
      </div>`;
    const input = el.querySelector('input');
    input.onchange = () => {
      lane.name = input.value.trim() || lane.name;
    };
    el.querySelector('[data-act="up"]').onclick = () => moveLane(laneIdx, -1);
    el.querySelector('[data-act="down"]').onclick = () => moveLane(laneIdx, 1);
    el.querySelector('[data-act="del"]').onclick = () => deleteLane(laneIdx);
  } else {
    const nameSpan = document.createElement('span');
    nameSpan.className = 'lane-name-text';
    nameSpan.textContent = lane.name;
    el.appendChild(nameSpan);
    el.insertAdjacentHTML('beforeend', laneProgressHtml(laneProgress(lane)));
  }
  return el;
}


// ---------- Track assignment to avoid overlapping ----------

function assignTracks(items) {
  if (!items || !items.length) return { assignments: [], trackCount: 0 };

  var indexed = items.map(function(item, idx) {
    return { idx: idx, start: item.start, end: item.end };
  });
  indexed.sort(function(a, b) { return a.start.localeCompare(b.start); });

  var endTimes = [];
  var assignments = new Array(items.length).fill(0);

  indexed.forEach(function(entry) {
    var idx = entry.idx;
    var start = entry.start;
    var end = entry.end;
    var placed = false;
    for (var t = 0; t < endTimes.length; t++) {
      if (start >= endTimes[t]) {
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

  return { assignments: assignments, trackCount: endTimes.length };
}

function renderLaneRow(lane, laneIdx) {
  const row = document.createElement('div');
  row.className = 'lane-row';
  if (isEditing) row.classList.add('editable');

  weeks.forEach(() => {
    const cell = document.createElement('div');
    cell.className = 'week-cell';
    row.appendChild(cell);
  });

  if (lane.items.length === 0 && !isEditing) {
    const empty = document.createElement('div');
    empty.className = 'lane-empty';
    empty.textContent = '—';
    row.appendChild(empty);
  }

  var _trk = assignTracks(lane.items);
  var _trackCount = _trk.trackCount;
  var _assignments = _trk.assignments;
  var _itemH = 28;
  var _gap = 4;
  var _baseTop = 10;
  var _rowH = Math.max(68, _baseTop + _trackCount * (_itemH + _gap) + 8);
  row.style.height = _rowH + 'px';

  lane.items.forEach(function(item, itemIdx) {
    var _t = _assignments[itemIdx];
    var bar = renderItem(item, laneIdx, itemIdx, _t);
    row.appendChild(bar);
  });

  if (isEditing) {
    const addBtn = document.createElement('button');
    addBtn.className = 'add-item-btn';
    addBtn.textContent = '+';
    addBtn.title = '添加任务';
    addBtn.onclick = () => openItemModal(laneIdx);
    row.appendChild(addBtn);
  }

  return row;
}

function renderItem(item, laneIdx, itemIdx, trackIdx) {
  const totalDays = weekCount * 7;
  const startDay = dayOffsetInTimeline(item.start);
  const endDay = Math.max(startDay, dayOffsetInTimeline(item.end));
  const spanDays = endDay - startDay + 1;

  const bar = document.createElement('div');
  bar.className = 'gantt-item';
  bar.style.backgroundColor = item.color || '#e5e7eb';
  bar.dataset.laneIdx = laneIdx;
  bar.dataset.itemIdx = itemIdx;
  // Position: day-precise left and width as percentage of timeline
  bar.style.left = (startDay / totalDays) * 100 + '%';
  bar.style.width = (spanDays / totalDays) * 100 + '%';
  // Vertical stacking based on track
  var _tIdx = typeof trackIdx === 'number' ? trackIdx : 0;
  bar.style.top = (10 + _tIdx * 32) + 'px';

  const progress = itemProgress(item);
  if (progress > 0) {
    const fill = document.createElement('div');
    fill.className = 'gantt-item-progress';
    fill.style.width = progress + '%';
    bar.appendChild(fill);
  }

  const label = document.createElement('span');
  label.className = 'gantt-item-label';
  label.textContent = progress > 0 ? `${item.name} ${progress}%` : item.name;
  bar.appendChild(label);

  if (isOverdue(item)) {
    bar.classList.add('overdue');
  }
  bar.title = `${item.name}: ${item.start} ~ ${item.end} · 进度 ${progress}%`;

  if (isEditing) {
    bar.onclick = () => openItemModal(laneIdx, itemIdx);
  }

  (item.milestones || []).forEach(ms => {
    const msDay = dayOffsetInTimeline(ms.date);
    if (msDay < startDay || msDay > endDay) return;
    const diamond = document.createElement('div');
    diamond.className = 'milestone';
    diamond.title = `${ms.date} ${ms.name}`;
    diamond.style.left = ((msDay - startDay) / spanDays) * 100 + '%';
    bar.appendChild(diamond);
  });

  return bar;
}

function renderTodayLine(body) {
  const today = new Date();
  if (today < timelineStart || today > new Date(timelineEnd.getTime() + 6 * 24 * 60 * 60 * 1000)) return;

  const totalDays = weekCount * 7;
  const offsetDays = daysDiff(timelineStart, today);
  const leftPct = (offsetDays / totalDays) * 100;
  const nameWidth = laneNameWidth();

  const line = document.createElement('div');
  line.className = 'today-line';
  line.style.left = `calc(${nameWidth}px + ${leftPct} * (100% - ${nameWidth}px) / 100)`;
  line.style.height = '100%';
  body.appendChild(line);
}

// ---------- Editing ----------

function updateToolbar() {
  els.btnEdit.classList.toggle('hidden', isEditing);
  els.btnSave.classList.toggle('hidden', !isEditing);
  els.btnCancel.classList.toggle('hidden', !isEditing);
}

function startEdit() {
  isEditing = true;
  updateToolbar();
  render();
  renderOkr();
}

function cancelEdit() {
  isEditing = false;
  updateToolbar();
  loadRoadmap();
}

function addLane() {
  roadmap.lanes.push({ id: uuid(), name: '新工作行', items: [] });
  render();
  const inputs = document.querySelectorAll('.lane-name-input');
  const last = inputs[inputs.length - 1];
  if (last) {
    last.focus();
    last.select();
  }
}

function moveLane(laneIdx, dir) {
  const target = laneIdx + dir;
  if (target < 0 || target >= roadmap.lanes.length) return;
  const lanes = roadmap.lanes;
  [lanes[laneIdx], lanes[target]] = [lanes[target], lanes[laneIdx]];
  render();
}

function deleteLane(laneIdx) {
  const lane = roadmap.lanes[laneIdx];
  if (lane.items.length > 0 && !confirm(`工作行「${lane.name}」里有 ${lane.items.length} 个任务，确定删除整行吗？`)) return;
  roadmap.lanes.splice(laneIdx, 1);
  render();
}

function openItemModal(laneIdx, itemIdx = -1) {
  const lane = roadmap.lanes[laneIdx];
  const isNew = itemIdx === -1;
  const item = isNew
    ? { id: uuid(), name: '', start: todayStr(), end: todayStr(), progress: 0, color: '#e5e7eb', milestones: [] }
    : lane.items[itemIdx];

  els.modalTitle.textContent = isNew ? '添加任务' : '编辑任务';
  els.itemLaneIdx.value = laneIdx;
  els.itemIdx.value = itemIdx;
  els.itemName.value = item.name;
  els.itemStart.value = item.start;
  els.itemEnd.value = item.end;
  els.itemProgress.value = itemProgress(item);
  els.itemColor.value = item.color || '#e5e7eb';
  els.itemMilestones.value = (item.milestones || [])
    .map(ms => `${ms.date} ${ms.name}`)
    .join('\n');

  els.btnDeleteItem.classList.toggle('hidden', isNew);
  els.modal.classList.remove('hidden');
  els.modal.setAttribute('aria-hidden', 'false');
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
  if (start && end && start > end) {
    alert('开始日期不能晚于结束日期');
    return;
  }
  const progress = clampNumber(parseInt(els.itemProgress.value, 10) || 0, 0, 100);
  const milestones = els.itemMilestones.value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
      if (match) return { date: match[1], name: match[2] };
      return null;
    })
    .filter(Boolean);

  const item = {
    id: itemIdx >= 0 ? lane.items[itemIdx].id : uuid(),
    name: els.itemName.value.trim(),
    start: els.itemStart.value,
    end: els.itemEnd.value,
    progress,
    color: els.itemColor.value,
    milestones,
  };

  if (itemIdx >= 0) {
    lane.items[itemIdx] = item;
  } else {
    lane.items.push(item);
  }

  closeModal();
  render();
  renderOkr();
}

function deleteItem() {
  const laneIdx = parseInt(els.itemLaneIdx.value, 10);
  const itemIdx = parseInt(els.itemIdx.value, 10);
  if (!confirm('确定删除这个任务吗？')) return;
  roadmap.lanes[laneIdx].items.splice(itemIdx, 1);
  closeModal();
  render();
  renderOkr();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- OKR rendering & editing ----------

function renderOkr() {
  var okr = roadmap.okr || roadmap.q3_okr;
  var section = document.getElementById('okr-section');
  if (!section) { console.warn('okr-section not found'); return; }
  var titleEl = document.getElementById('okr-title');
  var bodyEl = document.getElementById('okr-body');
  var iconEl = document.getElementById('okr-toggle-icon');

  els.btnOkrEdit.classList.toggle('hidden', !isEditing);

  if (!okr || !okr.objectives || !okr.objectives.length) {
    if (!isEditing) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    titleEl.textContent = (okr && okr.title) || 'OKR';
    bodyEl.innerHTML = '<p class="empty-state">暂无 OKR 内容，点击右上角「编辑 OKR」添加</p>';
    return;
  }
  section.style.display = '';

  titleEl.textContent = okr.title || 'OKR';

  var html = '';
  if (okr.summary) {
    html += '<p class="okr-summary">' + escapeHtml(okr.summary) + '</p>';
  }

  var tagColors = ['blue', 'green', 'purple', 'orange', 'rose'];

  okr.objectives.forEach(function(obj) {
    html += '<div class="okr-objective">';
    html += '<div class="okr-obj-header">';
    html += '<span class="okr-obj-id">' + escapeHtml(obj.id) + '</span>';
    html += '<span class="okr-obj-title">' + escapeHtml(obj.title) + '</span>';
    if (obj.owners && obj.owners.length) {
      html += '<span class="okr-obj-owners">';
      obj.owners.forEach(function(owner, i) {
        var c = tagColors[i % tagColors.length];
        html += '<span class="okr-tag ' + c + '">' + escapeHtml(owner) + '</span>';
      });
      html += '</span>';
    }
    html += '</div>';

    if (obj.positioning) {
      html += '<div class="okr-positioning">' + escapeHtml(obj.positioning) + '</div>';
    }

    if (obj.krs && obj.krs.length) {
      html += '<div class="okr-krs">';
      obj.krs.forEach(function(kr) {
        html += '<div class="okr-kr">';
        html += '<span class="okr-kr-id">' + escapeHtml(kr.id) + '</span>';
        html += '<span class="okr-kr-content">' + escapeHtml(kr.content);
        if (kr.acceptance) {
          html += '<span class="okr-kr-acceptance">' + escapeHtml(kr.acceptance) + '</span>';
        }
        html += '</span></div>';
      });
      html += '</div>';
    }

    if (obj.tracks && obj.tracks.length) {
      obj.tracks.forEach(function(track) {
        html += '<div class="okr-track">';
        html += '<div class="okr-track-header">' + escapeHtml(track.name);
        if (track.owners && track.owners.length) {
          track.owners.forEach(function(owner) {
            html += '<span class="okr-tag">' + escapeHtml(owner) + '</span>';
          });
        }
        html += '</div>';
        if (track.krs && track.krs.length) {
          html += '<div class="okr-krs">';
          track.krs.forEach(function(kr) {
            html += '<div class="okr-kr">';
            html += '<span class="okr-kr-id">' + escapeHtml(kr.id) + '</span>';
            html += '<span class="okr-kr-content">' + escapeHtml(kr.content);
            if (kr.acceptance) {
              html += '<span class="okr-kr-acceptance">' + escapeHtml(kr.acceptance) + '</span>';
            }
            html += '</span></div>';
          });
          html += '</div>';
        }
        html += '</div>';
      });
    }

    html += '</div>';
  });

  bodyEl.innerHTML = html;

  var collapsed = localStorage.getItem('okr_collapsed') === 'true';
  if (collapsed) {
    bodyEl.classList.add('collapsed');
    iconEl.classList.add('collapsed');
  }
}

function openOkrModal() {
  var okr = roadmap.okr || roadmap.q3_okr;
  els.okrJson.value = okr
    ? JSON.stringify(okr, null, 2)
    : JSON.stringify({ title: '', summary: '', objectives: [] }, null, 2);
  els.okrModal.classList.remove('hidden');
  els.okrModal.setAttribute('aria-hidden', 'false');
}

function closeOkrModal() {
  els.okrModal.classList.add('hidden');
  els.okrModal.setAttribute('aria-hidden', 'true');
}

function saveOkrModal() {
  const raw = els.okrJson.value.trim();
  if (!raw) {
    roadmap.okr = null;
    delete roadmap.q3_okr;
    closeOkrModal();
    renderOkr();
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    alert('JSON 格式错误：' + err.message);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.objectives)) {
    alert('OKR 数据必须是包含 objectives 数组的对象');
    return;
  }
  roadmap.okr = parsed;
  delete roadmap.q3_okr;
  closeOkrModal();
  renderOkr();
}

function clearOkr() {
  if (!confirm('确定清空全部 OKR 内容吗？（保存后生效）')) return;
  roadmap.okr = null;
  delete roadmap.q3_okr;
  closeOkrModal();
  renderOkr();
}

// ---------- Table views (biweekly & yearly) ----------

function getTimelineRange() {
  let start = parseDate(roadmap.startDate);
  let end = parseDate(roadmap.endDate);
  if (!start || !end) {
    roadmap.lanes.forEach(lane => {
      lane.items.forEach(item => {
        const s = parseDate(item.start);
        const e = parseDate(item.end);
        if (s && (!start || s < start)) start = s;
        if (e && (!end || e > end)) end = e;
      });
    });
  }
  if (!start || !end) {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 3, 0);
  }
  return { start, end };
}

function getBiweeklyPeriods() {
  const { start, end } = getTimelineRange();
  const startISO = toISODate(start);
  const endISO = toISODate(end);
  const periods = [];
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = cur.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    [
      { label: `${m + 1}/1-${m + 1}/15`, start: toISODate(new Date(y, m, 1)), end: toISODate(new Date(y, m, 15)) },
      { label: `${m + 1}/16-${m + 1}/${lastDay}`, start: toISODate(new Date(y, m, 16)), end: toISODate(new Date(y, m, lastDay)) },
    ].forEach(p => {
      if (p.end >= startISO && p.start <= endISO) periods.push(p);
    });
    cur = new Date(y, m + 1, 1);
  }
  return periods;
}

function isActiveInPeriod(item, periodStart, periodEnd) {
  return item.start <= periodEnd && item.end >= periodStart;
}

function milestonesInPeriod(milestones, periodStart, periodEnd) {
  if (!milestones || !milestones.length) return [];
  return milestones.filter(function(ms) {
    return ms.date >= periodStart && ms.date <= periodEnd;
  });
}

// ---------- Biweekly execution board ----------

let biweeklyIdx = -1; // -1 = auto (the period containing today)

function currentBiweeklyIndex(periods) {
  const t = todayStr();
  const hit = periods.findIndex(p => t >= p.start && t <= p.end);
  if (hit >= 0) return hit;
  const firstFuture = periods.findIndex(p => p.start > t);
  if (firstFuture === 0) return 0;
  if (firstFuture > 0) return firstFuture - 1;
  return periods.length - 1;
}

function bwProgressHtml(item) {
  const p = itemProgress(item);
  return '<span class="bw-progress"><span class="bw-progress-fill" style="width:' + p + '%"></span></span>'
    + '<span class="bw-progress-pct">' + p + '%</span>';
}

function bwItemRow(lane, item, extraHtml) {
  return '<div class="bw-item">'
    + '<span class="item-dot" style="background:' + (item.color || '#e5e7eb') + '"></span>'
    + '<span class="bw-item-name">' + escapeHtml(item.name) + '</span>'
    + '<span class="bw-item-lane">' + escapeHtml(lane.name) + '</span>'
    + (extraHtml || '')
    + bwProgressHtml(item)
    + '</div>';
}

function renderBiweeklyView() {
  const container = document.getElementById('biweekly-view');
  const periods = getBiweeklyPeriods();
  const lanes = roadmap.lanes;

  if (!lanes || !lanes.length) {
    container.innerHTML = '<p class="empty-state">无数据</p>';
    return;
  }

  if (biweeklyIdx < 0 || biweeklyIdx >= periods.length) {
    biweeklyIdx = currentBiweeklyIndex(periods);
  }
  const period = periods[biweeklyIdx];
  const t = todayStr();
  const isCurrent = t >= period.start && t <= period.end;
  const fullyPast = period.end < t;

  // Nav bar
  let html = '<div class="bw-nav">';
  html += '<button class="btn bw-nav-btn" data-act="prev"' + (biweeklyIdx === 0 ? ' disabled' : '') + '>← 上一期</button>';
  html += '<span class="bw-period-label">' + period.label + (isCurrent ? '<span class="bw-current">本期</span>' : '') + '</span>';
  html += '<button class="btn bw-nav-btn" data-act="next"' + (biweeklyIdx === periods.length - 1 ? ' disabled' : '') + '>下一期 →</button>';
  if (!isCurrent) html += '<button class="btn bw-nav-btn" data-act="today">回到本期</button>';
  html += '</div>';

  // Overdue items (cumulative up to the viewed period)
  const overdue = [];
  lanes.forEach(lane => lane.items.forEach(item => {
    const due = fullyPast ? item.end <= period.end : item.end < t;
    if (due && itemProgress(item) < 100) overdue.push({ lane, item });
  }));
  if (overdue.length) {
    overdue.sort((a, b) => a.item.end.localeCompare(b.item.end));
    html += '<div class="bw-card bw-overdue-card"><h3>逾期未完成（' + overdue.length + '）</h3>';
    overdue.forEach(({ lane, item }) => {
      html += bwItemRow(lane, item, '<span class="bw-item-date">应于 ' + item.end + ' 完成</span>');
    });
    html += '</div>';
  }

  // Deliverables due in this period: milestones + items ending here
  const deliverables = [];
  lanes.forEach(lane => lane.items.forEach(item => {
    milestonesInPeriod(item.milestones, period.start, period.end).forEach(ms => {
      deliverables.push({ lane, item, date: ms.date, text: ms.name, isMs: true });
    });
    if (item.end >= period.start && item.end <= period.end) {
      deliverables.push({ lane, item, date: item.end, text: '任务完成', isMs: false });
    }
  }));
  html += '<div class="bw-card"><h3>本期交付（' + period.label + '）</h3>';
  if (!deliverables.length) {
    html += '<p class="empty-state" style="padding:0.5rem">本期无计划交付</p>';
  } else {
    deliverables.sort((a, b) => a.date.localeCompare(b.date));
    deliverables.forEach(d => {
      html += bwItemRow(d.lane, d.item,
        '<span class="bw-ms-date">◆ ' + d.date + '</span><span class="bw-item-date">' + escapeHtml(d.text) + '</span>');
    });
  }
  html += '</div>';

  // In-progress items grouped by lane
  html += '<div class="bw-card"><h3>进行中</h3>';
  let anyActive = false;
  lanes.forEach(lane => {
    const active = lane.items.filter(item => isActiveInPeriod(item, period.start, period.end));
    if (!active.length) return;
    anyActive = true;
    html += '<div class="bw-lane-title">' + escapeHtml(lane.name) + '</div>';
    active.forEach(item => {
      html += bwItemRow(lane, item, '<span class="bw-item-date">' + item.start + ' ~ ' + item.end + '</span>');
    });
  });
  if (!anyActive) html += '<p class="empty-state" style="padding:0.5rem">本期无进行中的任务</p>';
  html += '</div>';

  container.innerHTML = html;

  container.querySelectorAll('.bw-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'prev' && biweeklyIdx > 0) biweeklyIdx--;
      else if (act === 'next' && biweeklyIdx < periods.length - 1) biweeklyIdx++;
      else if (act === 'today') biweeklyIdx = -1;
      renderBiweeklyView();
    });
  });
}

function renderYearlyView() {
  const container = document.getElementById('yearly-view');
  const lanes = roadmap.lanes;

  if (!lanes || !lanes.length) {
    container.innerHTML = '<p class="empty-state">无数据</p>';
    return;
  }

  const { start, end } = getTimelineRange();
  // Always cover at least the current year and next year, expanding to fit data
  const currentYear = new Date().getFullYear();
  const y0 = Math.min(start.getFullYear(), currentYear);
  const y1 = Math.max(end.getFullYear(), currentYear + 1);
  const months = [];
  for (let y = y0; y <= y1; y++) {
    for (let m = 0; m < 12; m++) months.push({ y, m });
  }
  const rangeStart = new Date(y0, 0, 1);
  const rangeEnd = new Date(y1, 11, 31);
  const totalDays = daysDiff(rangeStart, rangeEnd) + 1;
  const cols = 'repeat(' + months.length + ', minmax(28px, 1fr))';

  let html = '<div class="yg">';
  html += '<div class="yg-header"><div class="yg-corner">工作内容</div>';
  html += '<div class="yg-months" style="grid-template-columns:' + cols + '">';
  months.forEach(({ y, m }) => {
    html += '<div class="yg-month">' + (m === 0 ? y + '年1月' : (m + 1) + '月') + '</div>';
  });
  html += '</div></div>';

  const today = new Date();

  lanes.forEach(lane => {
    html += '<div class="yg-lane">';
    html += '<div class="yg-lane-name"><span class="lane-name-text">' + escapeHtml(lane.name) + '</span>'
      + laneProgressHtml(laneProgress(lane)) + '</div>';

    const trk = assignTracks(lane.items);
    const rowH = Math.max(30, 8 + trk.trackCount * 18);
    html += '<div class="yg-row" style="grid-template-columns:' + cols + ';height:' + rowH + 'px">';
    months.forEach(() => { html += '<div class="yg-cell"></div>'; });

    lane.items.forEach((item, i) => {
      const s = parseDate(item.start);
      const e = parseDate(item.end);
      if (!s || !e) return;
      const sd = clampNumber(daysDiff(rangeStart, s), 0, totalDays - 1);
      const ed = Math.max(sd, clampNumber(daysDiff(rangeStart, e), 0, totalDays - 1));
      const spanDays = ed - sd + 1;
      const left = (sd / totalDays) * 100;
      const w = (spanDays / totalDays) * 100;
      const top = 5 + trk.assignments[i] * 18;
      const p = itemProgress(item);

      html += '<div class="yg-bar' + (isOverdue(item) ? ' overdue' : '') + '"'
        + ' style="left:' + left + '%;width:' + w + '%;top:' + top + 'px;background:' + (item.color || '#e5e7eb') + '"'
        + ' title="' + escapeHtml(item.name + ': ' + item.start + ' ~ ' + item.end + ' · 进度 ' + p + '%') + '">';
      if (p > 0) {
        html += '<div class="gantt-item-progress" style="width:' + p + '%"></div>';
      }
      (item.milestones || []).forEach(ms => {
        const md = parseDate(ms.date);
        if (!md) return;
        const msd = daysDiff(rangeStart, md);
        if (msd < sd || msd > ed) return;
        html += '<div class="milestone yg-ms" style="left:' + ((msd - sd) / spanDays) * 100 + '%"'
          + ' title="' + escapeHtml(ms.date + ' ' + ms.name) + '"></div>';
      });
      html += '</div>';
    });

    if (today >= rangeStart && today <= rangeEnd) {
      const tl = (daysDiff(rangeStart, today) / totalDays) * 100;
      html += '<div class="yg-today" style="left:' + tl + '%"></div>';
    }

    html += '</div></div>';
  });

  html += '</div>';
  container.innerHTML = html;
}

// ---------- Events ----------

els.btnEdit.addEventListener('click', startEdit);
els.btnSave.addEventListener('click', saveRoadmap);
els.btnCancel.addEventListener('click', cancelEdit);
els.itemForm.addEventListener('submit', saveItemModal);
els.btnModalCancel.addEventListener('click', closeModal);
els.btnDeleteItem.addEventListener('click', deleteItem);
els.modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

els.btnOkrEdit.addEventListener('click', function(e) {
  e.stopPropagation();
  openOkrModal();
});
els.btnOkrSave.addEventListener('click', saveOkrModal);
els.btnOkrCancel.addEventListener('click', closeOkrModal);
els.btnOkrClear.addEventListener('click', clearOkr);
els.okrModal.querySelector('.modal-backdrop').addEventListener('click', closeOkrModal);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!els.modal.classList.contains('hidden')) closeModal();
  if (!els.okrModal.classList.contains('hidden')) closeOkrModal();
});


// Tab switching
var tabBtns = document.querySelectorAll('.tab-btn');
tabBtns.forEach(function(btn) {
  btn.addEventListener('click', function() {
    tabBtns.forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var tabId = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab-content').forEach(function(tc) {
      tc.classList.remove('active');
    });
    var tabEl = document.getElementById(tabId);
    if (tabEl) {
      tabEl.classList.add('active');
      // Always re-render so edits are reflected immediately
      if (tabId === 'tab-biweekly') renderBiweeklyView();
      if (tabId === 'tab-yearly') renderYearlyView();
    }
  });
});

// OKR toggle
document.getElementById('okr-toggle').addEventListener('click', function() {
  var body = document.getElementById('okr-body');
  var icon = document.getElementById('okr-toggle-icon');
  body.classList.toggle('collapsed');
  icon.classList.toggle('collapsed');
  localStorage.setItem('okr_collapsed', body.classList.contains('collapsed'));
});

loadRoadmap().catch(err => {
  console.error(err);
  els.gantt.innerHTML = `<p class="empty-state">加载失败：${escapeHtml(err.message)}</p>`;
});
