const API = '/api/projects';

let projects = [];
let filterText = '';
let searchTimer = null;
let filterStatus = 'all';
let collapsedProjects = new Set();

const els = {
  list: document.getElementById('project-list'),
  empty: document.getElementById('empty-state'),
  search: document.getElementById('search'),
  stats: document.getElementById('stats'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modal-title'),
  form: document.getElementById('project-form'),
  projectId: document.getElementById('project-id'),
  projectName: document.getElementById('project-name'),
  projectDesc: document.getElementById('project-description'),
  projectStatus: document.getElementById('project-status'),
  btnNew: document.getElementById('btn-new-project'),
  btnCancel: document.getElementById('btn-cancel'),
  btnExport: document.getElementById('btn-export'),
  btnImport: document.getElementById('btn-import'),
  importFile: document.getElementById('import-file'),
  filterRow: document.getElementById('filter-row'),
};

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败 ${res.status}`);
  }
  return data;
}

function handleAsync(fn) {
  return async (...args) => {
    try { await fn(...args); }
    catch (error) { alert('操作失败：' + error.message); }
  };
}

async function loadProjects() {
  const data = await api('GET', API);
  projects = data.projects || [];
  render();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusLabel(status) {
  return { active: '进行中', done: '已完成', archived: '已归档' }[status] || status;
}

function priorityLabel(priority) {
  return { high: '高', medium: '中', low: '低' }[priority] || priority;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

function matchesFilter(project, text) {
  if (!text) return true;
  const t = text.toLowerCase();
  if (project.name.toLowerCase().includes(t)) return true;
  if (project.description && project.description.toLowerCase().includes(t)) return true;
  return project.tasks.some(task => task.title.toLowerCase().includes(t));
}

function render() {
  let visible = projects;
  if (filterStatus !== 'all') {
    visible = visible.filter(p => p.status === filterStatus);
  }
  visible = visible
    .filter(p => matchesFilter(p, filterText))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  els.list.innerHTML = '';

  if (visible.length === 0) {
    els.list.classList.add('hidden');
    els.empty.classList.remove('hidden');
    if (projects.length === 0) {
      els.empty.innerHTML = '<p>还没有项目，点击右上角"新建项目"开始。</p>';
      els.empty.classList.remove('is-search');
    } else {
      const hasFilters = filterStatus !== 'all' || filterText !== '';
      const clearBtn = hasFilters ? '<button class="btn" id="btn-clear-filters" style="margin-top:0.75rem">清除筛选</button>' : '';
      els.empty.innerHTML = '<p>没有匹配的项目或任务。</p>' + clearBtn;
      els.empty.classList.add('is-search');
    }
  } else {
    els.list.classList.remove('hidden');
    els.empty.classList.add('hidden');
    visible.forEach(p => els.list.appendChild(projectCard(p)));
  }

  // Update active filter button
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === filterStatus);
  });

  const totalTasks = projects.reduce((sum, p) => sum + p.tasks.length, 0);
  const doneTasks = projects.reduce((sum, p) => sum + p.tasks.filter(t => t.done).length, 0);
  els.stats.textContent = `项目 ${visible.length}/${projects.length} · 任务 ${doneTasks}/${totalTasks}`;
}

function projectCard(project) {
  const card = document.createElement('article');
  card.className = 'card' + (project.status === 'done' ? ' status-done' : '') + (project.status === 'archived' ? ' status-archived' : '') + (project.pinned ? ' pinned' : '');
  card.dataset.id = project.id;

  const doneCount = project.tasks.filter(t => t.done).length;

  const sortedTasks = [...project.tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  const isCollapsed = collapsedProjects.has(project.id);
  const totalTasksCount = project.tasks.length;

  card.innerHTML = `
    <div class="card-header">
      <div>
        <h3 class="card-title">${escapeHtml(project.name)}</h3>
      </div>
      <div class="card-actions">
        <button class="icon-btn ${project.pinned ? 'pinned' : ''}" data-action="pin-project" title="${project.pinned ? '取消置顶' : '置顶'}">📌</button>
        <button class="icon-btn" data-action="edit-project" title="编辑">✎</button>
        <button class="icon-btn danger" data-action="delete-project" title="删除">🗑</button>
      </div>
    </div>
    ${project.description ? `<p class="card-desc">${escapeHtml(project.description)}</p>` : ''}
    <div class="card-meta">
      <span class="badge ${escapeHtml(project.status)}">${escapeHtml(statusLabel(project.status))}</span>
      <span class="card-updated" title="创建于 ${escapeHtml(formatDate(project.createdAt))} · 更新于 ${escapeHtml(formatDate(project.updatedAt))}">${escapeHtml(formatRelative(project.updatedAt))}更新</span>
    </div>
    <div class="task-section ${isCollapsed ? 'collapsed' : ''}">
      <div class="task-section-header">
        <span class="task-summary">${doneCount}/${totalTasksCount} 任务</span>
        <button class="icon-btn" data-action="toggle-tasks" title="${isCollapsed ? '展开' : '折叠'}">${isCollapsed ? '+' : '−'}</button>
      </div>
      <ul class="task-list">
        ${sortedTasks.map(t => taskHtml(t)).join('')}
      </ul>
      <div class="add-task">
        <input type="text" class="new-task-title" placeholder="+ 添加任务，回车确认">
      </div>
    </div>
  `;
  return card;
}

function taskHtml(task) {
  return `
    <li class="task-item ${task.done ? 'done' : ''}" data-task-id="${escapeHtml(task.id)}">
      <input type="checkbox" class="task-done" ${task.done ? 'checked' : ''}>
      <div class="task-main">
        <span class="task-title" contenteditable="true" title="点击编辑，Enter 保存">${escapeHtml(task.title)}</span>
        <div class="task-sub">
          <span class="badge priority-${escapeHtml(task.priority)}" data-action="cycle-priority" title="点击切换优先级">${escapeHtml(priorityLabel(task.priority))}</span>
          <span class="task-date">${escapeHtml(formatDate(task.createdAt))}</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="icon-btn danger" data-action="delete-task" title="删除">✕</button>
      </div>
    </li>
  `;
}

function openModal(project = null) {
  if (project) {
    els.modalTitle.textContent = '编辑项目';
    els.projectId.value = project.id;
    els.projectName.value = project.name;
    els.projectDesc.value = project.description || '';
    els.projectStatus.value = project.status || 'active';
  } else {
    els.modalTitle.textContent = '新建项目';
    els.form.reset();
    els.projectId.value = '';
    els.projectStatus.value = 'active';
  }
  els.modal.classList.remove('hidden');
  els.modal.setAttribute('aria-hidden', 'false');
  els.projectName.focus();
}

function closeModal() {
  els.modal.classList.add('hidden');
  els.modal.setAttribute('aria-hidden', 'true');
}

async function saveProject(e) {
  e.preventDefault();
  const button = els.form.querySelector('[type="submit"]');
  if (button.disabled) return;
  const id = els.projectId.value;
  const body = {
    name: els.projectName.value.trim(),
    description: els.projectDesc.value.trim(),
    status: els.projectStatus.value,
  };
  if (!body.name) return;
  button.disabled = true;
  try {
    if (id) {
      await api('PUT', `${API}/${id}`, body);
    } else {
      await api('POST', API, body);
    }
    closeModal();
    await loadProjects();
  } finally {
    button.disabled = false;
  }
}

async function deleteProject(id) {
  if (!confirm('确定删除这个项目及其所有任务吗？')) return;
  await api('DELETE', `${API}/${id}`);
  await loadProjects();
}

async function addTask(projectId, title, priority) {
  await api('POST', `${API}/${projectId}/tasks`, { title, priority });
  await loadProjects();
}

async function updateTask(projectId, taskId, changes) {
  await api('PUT', `${API}/${projectId}/tasks/${taskId}`, changes);
  await loadProjects();
}

async function deleteTask(projectId, taskId) {
  await api('DELETE', `${API}/${projectId}/tasks/${taskId}`);
  await loadProjects();
}

async function exportData() {
  const data = await api('GET', '/api/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `local-pm-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}


els.btnNew.addEventListener('click', () => openModal());
els.btnCancel.addEventListener('click', closeModal);
els.form.addEventListener('submit', handleAsync(saveProject));
els.modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

els.search.addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filterText = e.target.value.trim();
    render();
  }, 150);
});


// Status filter
els.filterRow.addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  filterStatus = btn.dataset.status;
  render();
});

els.btnExport.addEventListener('click', handleAsync(exportData));
els.btnImport.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  els.importFile.value = '';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const count = data.projects?.length || 0;
    const scope = Object.hasOwn(data, 'roadmap') ? '项目和甘特图' : '项目（甘特图内容保留，关联状态会同步）';
    if (!confirm(`确定导入 ${count} 个项目？将覆盖当前${scope}。覆盖前会自动备份旧数据。`)) return;
    const result = await api('POST', '/api/import', data);
    await loadProjects();
    alert(`导入成功。旧数据已备份到 data/${result.backup}`);
  } catch (err) {
    alert('导入失败：' + err.message);
  }
});

els.list.addEventListener('click', handleAsync(async e => {
  const target = e.target;
  const action = target.dataset.action;
  if (!action) return;

  const card = target.closest('.card');
  const projectId = card?.dataset.id;

  if (action === 'edit-project') {
    const project = projects.find(p => p.id === projectId);
    if (project) openModal(project);
    return;
  }

  if (action === 'pin-project') {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    const newPinned = !project.pinned;
    project.pinned = newPinned;
    render();
    try {
      await api('PUT', `${API}/${projectId}`, { pinned: newPinned });
    } catch (err) {
      project.pinned = !newPinned;
      render();
      alert('更新失败：' + err.message);
    }
    return;
  }

  if (action === 'delete-project') {
    await deleteProject(projectId);
    return;
  }

  if (action === 'delete-task') {
    const taskItem = target.closest('.task-item');
    const taskId = taskItem.dataset.taskId;
    if (!confirm('确定删除这个任务吗？')) return;
    await deleteTask(projectId, taskId);
    return;
  }

  if (action === 'cycle-priority') {
    const taskItem = target.closest('.task-item');
    const taskId = taskItem.dataset.taskId;
    const project = projects.find(p => p.id === projectId);
    const task = project?.tasks.find(t => t.id === taskId);
    if (!task) return;
    const cycle = { low: 'medium', medium: 'high', high: 'low' };
    const newPriority = cycle[task.priority] || 'medium';
    // Optimistic update
    task.priority = newPriority;
    project.updatedAt = new Date().toISOString();
    render();
    try {
      await api('PUT', `${API}/${projectId}/tasks/${taskId}`, { priority: newPriority });
    } catch (err) {
      const reverseCycle = { high: 'medium', medium: 'low', low: 'high' };
      task.priority = reverseCycle[newPriority] || 'medium';
      render();
      alert('更新失败：' + err.message);
    }
    return;
  }

  if (action === 'toggle-tasks') {
    if (collapsedProjects.has(projectId)) {
      collapsedProjects.delete(projectId);
    } else {
      collapsedProjects.add(projectId);
    }
    render();
  }
}));

els.list.addEventListener('change', async e => {
  const target = e.target;
  if (!target.classList.contains('task-done')) return;
  const taskItem = target.closest('.task-item');
  const card = target.closest('.card');
  const projectId = card.dataset.id;
  const taskId = taskItem.dataset.taskId;
  const done = target.checked;

  // Optimistic: update local state immediately
  const project = projects.find(p => p.id === projectId);
  const task = project?.tasks.find(t => t.id === taskId);
  if (task) {
    task.done = done;
    project.updatedAt = new Date().toISOString();
    render();
  }

  // Sync to server
  try {
    await api('PUT', `${API}/${projectId}/tasks/${taskId}`, { done });
  } catch (err) {
    // Revert on failure
    if (task) {
      task.done = !done;
      render();
    }
    alert('更新失败：' + err.message);
  }
});

els.list.addEventListener('blur', handleAsync(async e => {
  const target = e.target;
  if (!target.classList.contains('task-title')) return;
  const taskItem = target.closest('.task-item');
  const card = target.closest('.card');
  const projectId = card.dataset.id;
  const taskId = taskItem.dataset.taskId;
  const newTitle = target.textContent.trim();
  const task = projects
    .find(p => p.id === projectId)
    ?.tasks.find(t => t.id === taskId);
  if (!task || newTitle === task.title) return;
  if (!newTitle) {
    target.textContent = task.title;
    return;
  }
  await updateTask(projectId, taskId, { title: newTitle });
}), true);

els.list.addEventListener('keydown', handleAsync(async e => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.target.classList.contains('task-title') && e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
  if (e.target.classList.contains('new-task-title') && e.key === 'Enter') {
    e.preventDefault();
    const input = e.target;
    if (input.disabled) return;
    const card = input.closest('.card');
    const title = input.value.trim();
    if (!title) return;
    input.disabled = true;
    try { await addTask(card.dataset.id, title, 'medium'); }
    finally { input.disabled = false; }
  }
}));

// Clear filters button in empty state
els.empty.addEventListener('click', e => {
  if (e.target.id !== 'btn-clear-filters') return;
  filterStatus = 'all';
  filterText = '';
  els.search.value = '';
  render();
});

loadProjects().catch(err => {
  console.error(err);
  els.list.innerHTML = `<p class="empty-state">加载失败：${escapeHtml(err.message)}</p>`;
});
