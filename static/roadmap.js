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
  itemColor: document.getElementById('item-color'),
  itemMilestones: document.getElementById('item-milestones'),
  btnDeleteItem: document.getElementById('btn-delete-item'),
  btnModalCancel: document.getElementById('btn-modal-cancel'),
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

function clampDate(d, min, max) {
  if (d < min) return new Date(min);
  if (d > max) return new Date(max);
  return d;
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

function weekIndex(date) {
  const d = parseDate(date);
  if (!d) return 0;
  return Math.max(0, Math.min(weekCount - 1, Math.floor(daysDiff(timelineStart, d) / 7)));
}

function dayOffsetInTimeline(date) {
  const d = parseDate(date);
  if (!d) return 0;
  return Math.max(0, Math.min(weekCount * 7 - 1, daysDiff(timelineStart, d)));
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

  const laneNameWidth = 200;

  function moveToDate(date) {
    const totalDays = weekCount * 7;
    const offsetDays = daysDiff(timelineStart, date);
    const ratio = Math.max(0, Math.min(1, offsetDays / totalDays));
    const leftPct = ratio * 100;
    line.style.left = `calc(${laneNameWidth}px + ${leftPct} * (100% - ${laneNameWidth}px) / 100)`;
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
    const timelineWidth = rect.width - laneNameWidth;
    let ratio = (x - laneNameWidth) / timelineWidth;
    ratio = Math.max(0, Math.min(1, ratio));
    const totalDays = weekCount * 7;
    const offsetDays = Math.round(ratio * totalDays);
    const date = new Date(timelineStart);
    date.setDate(date.getDate() + offsetDays);
    moveToDate(date);
  });
}

function renderHeaderMonths(container) {
  let currentMonth = -1;
  let span = 0;
  let startIdx = 0;

  weeks.forEach((week, idx) => {
    const month = week.getMonth();
    if (month !== currentMonth) {
      if (span > 0) appendMonthCell(container, currentMonth, weeks[startIdx].getFullYear(), span);
      currentMonth = month;
      startIdx = idx;
      span = 0;
    }
    span++;
  });
  if (span > 0) appendMonthCell(container, currentMonth, weeks[startIdx].getFullYear(), span);
}

function appendMonthCell(container, month, year, span) {
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const cell = document.createElement('div');
  cell.className = 'header-month';
  cell.textContent = `${year}年${monthNames[month]}`;
  cell.style.gridColumn = `span ${span}`;
  container.appendChild(cell);
}

function renderHeaderWeeks(container) {
  weeks.forEach((week, idx) => {
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
    el.innerHTML = `<input type="text" value="${escapeHtml(lane.name)}" data-lane-idx="${laneIdx}" class="lane-name-input">`;
    const input = el.querySelector('input');
    input.onchange = () => {
      lane.name = input.value.trim() || lane.name;
    };
  } else {
    el.textContent = lane.name;
  }
  return el;
}

function renderLaneRow(lane, laneIdx) {
  const row = document.createElement('div');
  row.className = 'lane-row';
  if (isEditing) row.classList.add('editable');

  weeks.forEach((week, idx) => {
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

  lane.items.forEach((item, itemIdx) => {
    const bar = renderItem(item, laneIdx, itemIdx);
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

function renderItem(item, laneIdx, itemIdx) {
  const startIdx = weekIndex(item.start);
  const endIdx = weekIndex(item.end);
  const bar = document.createElement('div');
  bar.className = 'gantt-item';
  bar.style.gridColumn = `${startIdx + 1} / ${endIdx + 2}`;
  bar.style.backgroundColor = item.color || '#e5e7eb';
  bar.title = `${item.name}: ${item.start} ~ ${item.end}`;
  bar.textContent = item.name;
  bar.dataset.laneIdx = laneIdx;
  bar.dataset.itemIdx = itemIdx;

  if (isEditing) {
    bar.onclick = () => openItemModal(laneIdx, itemIdx);
  }

  (item.milestones || []).forEach(ms => {
    const milestone = document.createElement('div');
    milestone.className = 'milestone';
    milestone.dataset.name = ms.name;
    const itemStartDay = startIdx * 7;
    const itemEndDay = (endIdx + 1) * 7;
    const totalDays = Math.max(1, itemEndDay - itemStartDay);
    let offsetDays = dayOffsetInTimeline(ms.date) - itemStartDay;
    offsetDays = Math.max(0, Math.min(totalDays, offsetDays));
    const leftPct = (offsetDays / totalDays) * 100;
    milestone.style.left = `${leftPct}%`;
    bar.appendChild(milestone);
  });

  return bar;
}

function renderTodayLine(body) {
  const today = new Date();
  if (today < timelineStart || today > new Date(timelineEnd.getTime() + 6 * 24 * 60 * 60 * 1000)) return;

  const totalDays = weekCount * 7;
  const offsetDays = daysDiff(timelineStart, today);
  const leftPct = (offsetDays / totalDays) * 100;

  const line = document.createElement('div');
  line.className = 'today-line';
  line.style.left = `calc(200px + ${leftPct} * (100% - 200px) / 100)`;
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
}

function cancelEdit() {
  isEditing = false;
  updateToolbar();
  loadRoadmap();
}

function addLane() {
  const name = prompt('新工作行名称');
  if (!name || !name.trim()) return;
  roadmap.lanes.push({ id: uuid(), name: name.trim(), items: [] });
  render();
}

function openItemModal(laneIdx, itemIdx = -1) {
  const lane = roadmap.lanes[laneIdx];
  const isNew = itemIdx === -1;
  const item = isNew
    ? { id: uuid(), name: '', start: toISODate(new Date()), end: toISODate(new Date()), color: '#e5e7eb', milestones: [] }
    : lane.items[itemIdx];

  els.modalTitle.textContent = isNew ? '添加任务' : '编辑任务';
  els.itemLaneIdx.value = laneIdx;
  els.itemIdx.value = itemIdx;
  els.itemName.value = item.name;
  els.itemStart.value = item.start;
  els.itemEnd.value = item.end;
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
}

function deleteItem() {
  const laneIdx = parseInt(els.itemLaneIdx.value, 10);
  const itemIdx = parseInt(els.itemIdx.value, 10);
  if (!confirm('确定删除这个任务吗？')) return;
  roadmap.lanes[laneIdx].items.splice(itemIdx, 1);
  closeModal();
  render();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Events ----------

els.btnEdit.addEventListener('click', startEdit);
els.btnSave.addEventListener('click', saveRoadmap);
els.btnCancel.addEventListener('click', cancelEdit);
els.itemForm.addEventListener('submit', saveItemModal);
els.btnModalCancel.addEventListener('click', closeModal);
els.btnDeleteItem.addEventListener('click', deleteItem);
els.modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !els.modal.classList.contains('hidden')) {
    closeModal();
  }
});

loadRoadmap().catch(err => {
  console.error(err);
  els.gantt.innerHTML = `<p class="empty-state">加载失败：${escapeHtml(err.message)}</p>`;
});
