// State
let state = {
  firefighters: [],
  selectedFirefighter: null,
  equipment: [],
  itemStates: {},
  currentView: 'check'
};

// Helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonth(month) {
  const [year, m] = month.split('-');
  const date = new Date(year, parseInt(m) - 1);
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function formatDate(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getEquipmentTypeLabel(type) {
  const labels = {
    fire_tunic: 'Fire Tunic',
    rtc_tunic: 'RTC Tunic',
    fire_gloves: 'Fire Gloves',
    rtc_gloves: 'RTC Gloves',
    trousers: 'Trousers',
    boots: 'Boots',
    helmet: 'Helmet',
    hood: 'Fire Hood',
    half_mask: 'Half-Mask Respirator',
    ba_mask: 'BA Mask',
    other: 'Other'
  };
  return labels[type] || type;
}

// API calls
async function api(endpoint, options = {}) {
  const res = await fetch(`/api${endpoint}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  return res.json();
}

// Views
function showView(viewName) {
  state.currentView = viewName;
  $$('.view').forEach(v => {
    v.classList.remove('active');
    v.classList.add('hidden');
  });
  const targetView = $(`#view-${viewName}`);
  targetView.classList.add('active');
  targetView.classList.remove('hidden');
  $$('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  if (viewName === 'dashboard') loadDashboard();
  if (viewName === 'history') loadHistory();
}

// Monthly Check View
async function loadFirefighters() {
  state.firefighters = await api('/firefighters');
  renderFirefighterList();
}

function renderFirefighterList() {
  const container = $('#firefighter-list');
  container.innerHTML = state.firefighters.map(ff => `
    <button class="firefighter-btn" data-id="${ff.id}">
      ${ff.name}
    </button>
  `).join('');

  container.querySelectorAll('.firefighter-btn').forEach(btn => {
    btn.addEventListener('click', () => selectFirefighter(btn.dataset.id));
  });
}

async function selectFirefighter(id) {
  const ff = state.firefighters.find(f => f.id === id);
  state.selectedFirefighter = ff;

  // Update UI
  $$('.firefighter-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.id === id);
  });

  // Check if already completed this month
  const month = getCurrentMonth();
  const existing = await api(`/firefighters/${id}/checks/${month}`);

  if (existing.check) {
    alert(`You have already completed your check for ${formatMonth(month)}.`);
    return;
  }

  // Load equipment
  state.equipment = await api(`/firefighters/${id}/equipment`);
  state.itemStates = {};

  // Initialize all items as 'good'
  state.equipment.forEach(eq => {
    state.itemStates[eq.barcode] = { condition: 'good', notes: '', photo: null };
  });

  $('#selected-name').textContent = ff.name;
  $('#check-month').textContent = formatMonth(month);

  renderEquipmentList();

  $('#firefighter-select').classList.add('hidden');
  $('#equipment-check').classList.remove('hidden');
}

function renderEquipmentList() {
  const container = $('#equipment-list');

  // Group by type
  const grouped = {};
  state.equipment.forEach(eq => {
    if (!grouped[eq.type]) grouped[eq.type] = [];
    grouped[eq.type].push(eq);
  });

  let html = '';
  for (const [type, items] of Object.entries(grouped)) {
    items.forEach(eq => {
      const itemState = state.itemStates[eq.barcode];
      const isDefect = itemState.condition === 'defect';

      html += `
        <div class="equipment-item ${isDefect ? 'defect' : ''}" data-barcode="${eq.barcode}">
          <div class="equipment-header">
            <div class="equipment-info">
              <h4>${getEquipmentTypeLabel(eq.type)}</h4>
              <div class="meta">${eq.description}${eq.size ? ` | Size: ${eq.size}` : ''}</div>
              <div class="meta">Barcode: ${eq.barcode}</div>
            </div>
            <div class="condition-toggle">
              <button type="button" class="condition-btn good ${!isDefect ? 'selected' : ''}"
                      data-barcode="${eq.barcode}" data-condition="good">Good</button>
              <button type="button" class="condition-btn defect ${isDefect ? 'selected' : ''}"
                      data-barcode="${eq.barcode}" data-condition="defect">Defect</button>
            </div>
          </div>
          <div class="defect-details ${isDefect ? '' : 'hidden'}">
            <label>Defect Notes:</label>
            <textarea placeholder="Describe the defect..."
                      data-barcode="${eq.barcode}">${itemState.notes}</textarea>
            <div class="photo-upload">
              <label>Photo (optional):</label>
              <input type="file" accept="image/*" capture="environment"
                     data-barcode="${eq.barcode}">
            </div>
          </div>
        </div>
      `;
    });
  }

  container.innerHTML = html;

  // Attach event listeners
  container.querySelectorAll('.condition-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const barcode = btn.dataset.barcode;
      const condition = btn.dataset.condition;
      setItemCondition(barcode, condition);
    });
  });

  container.querySelectorAll('.defect-details textarea').forEach(textarea => {
    textarea.addEventListener('input', (e) => {
      const barcode = e.target.dataset.barcode;
      state.itemStates[barcode].notes = e.target.value;
    });
  });

  container.querySelectorAll('.defect-details input[type="file"]').forEach(input => {
    input.addEventListener('change', (e) => {
      const barcode = e.target.dataset.barcode;
      state.itemStates[barcode].photo = e.target.files[0] || null;
    });
  });
}

function setItemCondition(barcode, condition) {
  state.itemStates[barcode].condition = condition;

  const item = $(`.equipment-item[data-barcode="${barcode}"]`);
  const goodBtn = item.querySelector('.condition-btn.good');
  const defectBtn = item.querySelector('.condition-btn.defect');
  const details = item.querySelector('.defect-details');

  item.classList.toggle('defect', condition === 'defect');
  goodBtn.classList.toggle('selected', condition === 'good');
  defectBtn.classList.toggle('selected', condition === 'defect');
  details.classList.toggle('hidden', condition === 'good');

  if (condition === 'good') {
    state.itemStates[barcode].notes = '';
    state.itemStates[barcode].photo = null;
  }
}

async function submitCheck(e) {
  e.preventDefault();

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const formData = new FormData();
    formData.append('firefighter_id', state.selectedFirefighter.id);
    formData.append('month', getCurrentMonth());

    const items = state.equipment.map(eq => ({
      barcode: eq.barcode,
      condition: state.itemStates[eq.barcode].condition,
      notes: state.itemStates[eq.barcode].notes,
      description: eq.description
    }));
    formData.append('items', JSON.stringify(items));

    // Add photos
    for (const eq of state.equipment) {
      const photo = state.itemStates[eq.barcode].photo;
      if (photo) {
        formData.append(`photo_${eq.barcode}`, photo);
      }
    }

    const res = await fetch('/api/checks', {
      method: 'POST',
      body: formData
    });

    const result = await res.json();

    if (result.error) {
      throw new Error(result.error);
    }

    // Show success
    $('#equipment-check').classList.add('hidden');
    $('#check-complete').classList.remove('hidden');
  } catch (err) {
    alert('Error submitting check: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Submit Check';
  }
}

// Dashboard View
async function loadDashboard() {
  const monthInput = $('#dashboard-month');
  if (!monthInput.value) {
    monthInput.value = getCurrentMonth();
  }

  const month = monthInput.value;
  const data = await api(`/dashboard?month=${month}`);

  // Summary cards
  $('#dashboard-summary').innerHTML = `
    <div class="summary-card">
      <div class="number">${data.total}</div>
      <div class="label">Total</div>
    </div>
    <div class="summary-card complete">
      <div class="number">${data.complete}</div>
      <div class="label">Complete</div>
    </div>
    <div class="summary-card incomplete">
      <div class="number">${data.incomplete}</div>
      <div class="label">Incomplete</div>
    </div>
  `;

  // Table
  $('#dashboard-table').innerHTML = data.firefighters.map(ff => `
    <tr>
      <td>${ff.name}</td>
      <td><span class="status-badge ${ff.status}">${ff.status}</span></td>
      <td>${ff.last_check ? formatDate(ff.last_check) : '-'}</td>
      <td>${ff.open_defects || 0}</td>
    </tr>
  `).join('');

  // Populate quarter selector
  populateQuarterSelector();
}

function populateQuarterSelector() {
  const select = $('#audit-quarter');
  const currentYear = new Date().getFullYear();
  const currentQuarter = Math.ceil((new Date().getMonth() + 1) / 3);

  let options = '';
  for (let year = currentYear; year >= currentYear - 1; year--) {
    for (let q = 4; q >= 1; q--) {
      if (year === currentYear && q > currentQuarter) continue;
      options += `<option value="${year}-Q${q}">${year} Q${q}</option>`;
    }
  }

  select.innerHTML = options;
}

async function loadQuarterlyAudit() {
  const quarter = $('#audit-quarter').value;
  const data = await api(`/audits/quarterly/${quarter}`);

  let tableHtml = `
    <div class="quarterly-grid">
      <table>
        <thead>
          <tr>
            <th>Firefighter</th>
            ${data.months.map(m => `<th>${formatMonth(m)}</th>`).join('')}
            <th>Complete</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (const ff of data.firefighters) {
    tableHtml += `
      <tr>
        <td>${ff.name}</td>
        ${data.months.map(m =>
          `<td>${ff.months[m] ? '<span class="check">&#10003;</span>' : '<span class="cross">&#10007;</span>'}</td>`
        ).join('')}
        <td>${ff.complete ? '<span class="check">&#10003;</span>' : '<span class="cross">&#10007;</span>'}</td>
      </tr>
    `;
  }

  tableHtml += '</tbody></table></div>';

  // Audit form
  if (data.audit) {
    tableHtml += `
      <div class="audit-form">
        <p><strong>Audited by:</strong> ${data.audit.audited_by}</p>
        <p><strong>Date:</strong> ${formatDate(data.audit.audited_at)}</p>
        ${data.audit.notes ? `<p><strong>Notes:</strong> ${data.audit.notes}</p>` : ''}
      </div>
    `;
  } else {
    tableHtml += `
      <form class="audit-form" id="audit-form">
        <input type="text" name="audited_by" placeholder="Audited by (your name)" required>
        <textarea name="notes" placeholder="Notes (optional)"></textarea>
        <button type="submit" class="btn btn-primary">Sign Off Quarterly Audit</button>
      </form>
    `;
  }

  $('#quarterly-data').innerHTML = tableHtml;

  // Attach audit form handler
  const auditForm = $('#audit-form');
  if (auditForm) {
    auditForm.addEventListener('submit', submitAudit);
  }
}

async function submitAudit(e) {
  e.preventDefault();
  const form = e.target;
  const quarter = $('#audit-quarter').value;

  const res = await api('/audits', {
    method: 'POST',
    body: JSON.stringify({
      quarter,
      audited_by: form.audited_by.value,
      notes: form.notes.value
    })
  });

  if (res.success) {
    loadQuarterlyAudit();
  } else {
    alert('Error: ' + (res.error || 'Unknown error'));
  }
}

// History View
async function loadHistory() {
  const monthInput = $('#history-month');
  if (!monthInput.value) {
    monthInput.value = getCurrentMonth();
  }

  const month = monthInput.value;
  const checks = await api(`/history/${month}`);

  if (checks.length === 0) {
    $('#history-list').innerHTML = '<p class="loading">No checks recorded for this month.</p>';
    return;
  }

  $('#history-list').innerHTML = checks.map(check => `
    <div class="history-item">
      <div class="history-item-header">
        <h4>${check.firefighter_name}</h4>
        ${check.defects > 0 ? `<span class="defect-tag">${check.defects} defect${check.defects > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="meta">
        Completed: ${formatDate(check.completed_at)} |
        Items checked: ${check.items_checked}
      </div>
    </div>
  `).join('');
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  // Navigation
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // Month inputs
  $('#dashboard-month').addEventListener('change', loadDashboard);
  $('#history-month').addEventListener('change', loadHistory);
  $('#load-quarter-btn').addEventListener('click', loadQuarterlyAudit);

  // Check form
  $('#check-form').addEventListener('submit', submitCheck);

  // Load initial data
  loadFirefighters();
});
