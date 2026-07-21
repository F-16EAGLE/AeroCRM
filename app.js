/**
 * app.js
 * Dexie (IndexedDB) persistence, in-memory state, search/filtering,
 * contact CRUD, vCard import, reports/export, and sync orchestration.
 *
 * Design note on local storage: every record persisted to IndexedDB is
 * stored as an opaque AES-GCM envelope (see crypto.js). Only `id` and
 * `updatedAt` are kept in the clear locally, purely so records can be
 * listed/sorted before the vault is unlocked. All contact content lives
 * decrypted in memory (state.contacts) only after a successful unlock.
 */

// ---------------------------------------------------------------------------
// Dexie setup
// ---------------------------------------------------------------------------
const db = new Dexie('RolodexDB');
db.version(1).stores({
  records: 'id, updatedAt',
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  contacts: [],          // decrypted Contact[]
  fuse: null,
  activeView: 'directory',
  tagFilter: '',
  relationFilter: '',
  overdueOnly: false,
  searchQuery: '',
  semanticEnabled: false,
  semanticWorker: null,
  semanticReqId: 0,
  semanticIndexReady: false,
  semanticResultIds: null, // Set of ids matching current semantic query
  pendingPfpBase64: null,
  handleRowsDraft: [],
  relationRowsDraft: [],
  interactionsDraft: [],
  lastSyncAt: null,
};

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
  return v.toString(16);
}));

function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------------------------------------------------------------------------
// Vault lifecycle / lock screen
// ---------------------------------------------------------------------------
const els = {}; // lazily populated cache of DOM refs, filled in init()

function cacheEls() {
  const ids = [
    'lockScreen','appShell','stepGoogle','stepPassword','googleSignInBtn','skipGoogleBtn',
    'googleStatus','masterPasswordInput','masterPasswordConfirm','unlockBtn','unlockError',
    'passwordHint','globalSearch','semanticToggle','syncBtn','settingsBtn','contactGrid',
    'emptyState','tagFilter','overdueFilterBtn','relationFilter','resultCount','addContactBtn',
    'reportOverdue','reportTags','exportRawBtn','exportEncryptedBtn','exportCsvBtn',
    'dropZone','vcfInput','importQueue','contactModal','contactModalTitle','contactForm',
    'contactId','pfpPreview','pfpInitial','pfpImg','pfpInput','fullNameInput','tagsInput',
    'frequencyInput','handleRows','addHandleBtn','relationRows','relationTargetSelect',
    'relationLabelInput','addRelationBtn','notesInput','addInteractionBtn','interactionList',
    'deleteContactBtn','saveContactBtn','interactionModal','quickInteractionContactId',
    'quickChannelInput','quickSummaryInput','saveQuickInteractionBtn','settingsModal',
    'settingsGoogleStatus','settingsGoogleBtn','settingsLastSync','lockNowBtn','wipeLocalBtn',
  ];
  ids.forEach((id) => { els[id] = document.getElementById(id); });
}

async function initLockScreen() {
  const hasVault = CryptoEngine.hasExistingVault();
  els.masterPasswordConfirm.hidden = hasVault;
  els.passwordHint.textContent = hasVault
    ? "This unlocks your data. It never leaves your device, and it's never stored — if you lose it, your encrypted backup can't be recovered."
    : "Choose a strong master password. It never leaves your device and is never stored anywhere — write it down somewhere safe, because it cannot be reset.";
  els.unlockBtn.textContent = hasVault ? 'Unlock' : 'Create vault & continue';

  updateGoogleStatusUI();

  els.googleSignInBtn.addEventListener('click', async () => {
    try {
      els.googleStatus.textContent = 'Opening Google sign-in…';
      await GoogleDrive.signIn();
      els.googleStatus.textContent = 'Connected to Google Drive.';
      advanceToPasswordStep();
    } catch (e) {
      els.googleStatus.textContent = e.message.includes('Client ID')
        ? 'Google sign-in not configured yet — see gdrive.js. You can continue offline.'
        : `Google sign-in failed: ${e.message}`;
    }
  });

  els.skipGoogleBtn.addEventListener('click', () => advanceToPasswordStep());

  els.unlockBtn.addEventListener('click', () => handleUnlockSubmit(hasVault));
  els.masterPasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleUnlockSubmit(hasVault); });
  els.masterPasswordConfirm.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleUnlockSubmit(hasVault); });
}

function advanceToPasswordStep() {
  els.stepGoogle.hidden = true;
  els.stepPassword.hidden = false;
  els.masterPasswordInput.focus();
}

function updateGoogleStatusUI() {
  const connected = GoogleDrive.isSignedIn();
  els.googleStatus.textContent = connected ? 'Connected to Google Drive.' : '';
}

async function handleUnlockSubmit(hasVault) {
  const pw = els.masterPasswordInput.value;
  els.unlockError.hidden = true;
  if (!pw || pw.length < 6) {
    els.unlockError.textContent = 'Password must be at least 6 characters.';
    els.unlockError.hidden = false;
    return;
  }
  if (!hasVault) {
    const confirm = els.masterPasswordConfirm.value;
    if (pw !== confirm) {
      els.unlockError.textContent = "Passwords don't match.";
      els.unlockError.hidden = false;
      return;
    }
    await CryptoEngine.initializeVault(pw);
    await enterApp();
    return;
  }

  els.unlockBtn.disabled = true;
  els.unlockBtn.textContent = 'Unlocking…';
  const ok = await CryptoEngine.unlockVault(pw);
  els.unlockBtn.disabled = false;
  els.unlockBtn.textContent = 'Unlock';
  if (!ok) {
    els.unlockError.textContent = 'Incorrect password.';
    els.unlockError.hidden = false;
    return;
  }
  await enterApp();
}

async function enterApp() {
  els.masterPasswordInput.value = '';
  els.masterPasswordConfirm.value = '';
  await loadAllFromDb();
  els.lockScreen.hidden = true;
  els.appShell.hidden = false;
  rebuildSearchIndex();
  renderDirectory();
  renderReports();
  populateTagFilterOptions();
  updateSettingsPanel();
}

function lockNow() {
  CryptoEngine.lock();
  state.contacts = [];
  state.fuse = null;
  els.appShell.hidden = true;
  els.lockScreen.hidden = false;
  els.stepGoogle.hidden = false;
  els.stepPassword.hidden = true;
  updateGoogleStatusUI();
}

// ---------------------------------------------------------------------------
// Persistence (encrypt/decrypt <-> Dexie)
// ---------------------------------------------------------------------------
async function loadAllFromDb() {
  const rows = await db.records.toArray();
  const decrypted = [];
  for (const row of rows) {
    try {
      const contact = await CryptoEngine.decrypt(row.envelope);
      decrypted.push(contact);
    } catch (e) {
      console.error('Failed to decrypt record', row.id, e);
    }
  }
  state.contacts = decrypted;
}

async function persistContact(contact) {
  const envelope = await CryptoEngine.encrypt(contact);
  await db.records.put({ id: contact.id, updatedAt: contact.updatedAt, envelope });
}

async function persistAll() {
  for (const c of state.contacts) await persistContact(c);
}

// ---------------------------------------------------------------------------
// Search index (Fuse.js keyword search)
// ---------------------------------------------------------------------------
function rebuildSearchIndex() {
  const searchable = state.contacts
    .filter((c) => !c.isDeleted)
    .map((c) => ({
      id: c.id,
      fullName: c.fullName,
      notes: c.notes || '',
      tags: (c.tags || []).join(' '),
      handles: (c.contactMethods || []).map((h) => h.value).join(' '),
      relationLabels: (c.relationships || []).map((r) => r.label).join(' '),
    }));
  state.fuse = new Fuse(searchable, {
    keys: ['fullName', 'notes', 'tags', 'handles', 'relationLabels'],
    threshold: 0.32,
    ignoreLocation: true,
  });
}

// ---------------------------------------------------------------------------
// Semantic search (Transformers.js Web Worker, lazy-loaded)
// ---------------------------------------------------------------------------
function getSemanticWorker() {
  if (!state.semanticWorker) {
    state.semanticWorker = new Worker('./semantic-worker.js', { type: 'module' });
  }
  return state.semanticWorker;
}

function indexSemanticCorpus() {
  return new Promise((resolve, reject) => {
    const worker = getSemanticWorker();
    const reqId = ++state.semanticReqId;
    const payload = state.contacts
      .filter((c) => !c.isDeleted)
      .map((c) => ({ id: c.id, text: `${c.fullName}. ${c.notes || ''}` }));

    const handler = (e) => {
      if (e.data.requestId !== reqId) return;
      if (e.data.type === 'index-complete') {
        worker.removeEventListener('message', handler);
        state.semanticIndexReady = true;
        resolve();
      } else if (e.data.type === 'error') {
        worker.removeEventListener('message', handler);
        reject(new Error(e.data.message));
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'index', payload, requestId: reqId });
  });
}

function querySemanticCorpus(text) {
  return new Promise((resolve, reject) => {
    const worker = getSemanticWorker();
    const reqId = ++state.semanticReqId;
    const handler = (e) => {
      if (e.data.requestId !== reqId) return;
      if (e.data.type === 'query-result') {
        worker.removeEventListener('message', handler);
        resolve(e.data.results);
      } else if (e.data.type === 'error') {
        worker.removeEventListener('message', handler);
        reject(new Error(e.data.message));
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'query', payload: { text, topK: 50 }, requestId: reqId });
  });
}

async function onSemanticToggle(enabled) {
  state.semanticEnabled = enabled;
  state.semanticResultIds = null;
  if (!enabled) { renderDirectory(); return; }
  try {
    toast('Loading AI search model (first time only)…', 4000);
    await indexSemanticCorpus();
    toast('AI search ready.');
    if (state.searchQuery) await runSemanticQuery(state.searchQuery);
    renderDirectory();
  } catch (e) {
    console.error(e);
    toast('AI search unavailable — falling back to keyword search.');
    els.semanticToggle.checked = false;
    state.semanticEnabled = false;
  }
}

async function runSemanticQuery(text) {
  if (!text) { state.semanticResultIds = null; return; }
  const results = await querySemanticCorpus(text);
  state.semanticResultIds = new Set(results.filter((r) => r.score > 0.35).map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Filtering / rendering — Directory
// ---------------------------------------------------------------------------
function isOverdue(contact) {
  if (!contact.frequencyGoalDays || !contact.lastContactedAt) return false;
  const days = (Date.now() - contact.lastContactedAt) / (1000 * 60 * 60 * 24);
  return days > contact.frequencyGoalDays;
}

function overdueLevel(contact) {
  if (!isOverdue(contact)) return 'ok';
  const days = (Date.now() - contact.lastContactedAt) / (1000 * 60 * 60 * 24);
  return days > contact.frequencyGoalDays * 2 ? 'red' : 'amber';
}

function getFilteredContacts() {
  let list = state.contacts.filter((c) => !c.isDeleted);

  if (state.searchQuery) {
    if (state.semanticEnabled && state.semanticResultIds) {
      list = list.filter((c) => state.semanticResultIds.has(c.id));
    } else if (state.fuse) {
      const ids = new Set(state.fuse.search(state.searchQuery).map((r) => r.item.id));
      list = list.filter((c) => ids.has(c.id));
    }
  }

  if (state.tagFilter) list = list.filter((c) => (c.tags || []).includes(state.tagFilter));
  if (state.overdueOnly) list = list.filter(isOverdue);
  if (state.relationFilter) {
    list = list.filter((c) => (c.relationships || []).some((r) => r.targetContactId === state.relationFilter));
  }

  return list.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

function formatLastContacted(contact) {
  if (!contact.lastContactedAt) return 'Never logged';
  const days = Math.floor((Date.now() - contact.lastContactedAt) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function renderDirectory() {
  const list = getFilteredContacts();
  els.resultCount.textContent = `${list.length} ${list.length === 1 ? 'contact' : 'contacts'}`;
  els.contactGrid.innerHTML = '';
  els.emptyState.hidden = list.length > 0;

  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'contact-card';
    card.dataset.id = c.id;

    const level = overdueLevel(c);
    const badgeClass = level === 'red' ? 'overdue-red' : level === 'amber' ? 'overdue-amber' : '';
    const primaryHandle = (c.contactMethods || [])[0];

    card.innerHTML = `
      <div class="card-top">
        <div class="card-pfp">${c.pfpBase64 ? `<img src="${c.pfpBase64}" alt="">` : initials(c.fullName)}</div>
        <div>
          <div class="card-name">${escapeHtml(c.fullName)}</div>
          <div class="card-handles">${primaryHandle ? escapeHtml(primaryHandle.value) : ''}</div>
        </div>
      </div>
      <div class="card-tags">${(c.tags || []).slice(0, 4).map((t) => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="card-bottom">
        <span class="last-contact-badge ${badgeClass}">${formatLastContacted(c)}</span>
        <button class="btn btn-secondary log-btn" data-log-id="${c.id}">Log interaction</button>
      </div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-log-id]')) return;
      openContactModal(c.id);
    });
    card.querySelector('[data-log-id]').addEventListener('click', () => openInteractionModal(c.id));
    els.contactGrid.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function populateTagFilterOptions() {
  const tags = new Set();
  state.contacts.filter((c) => !c.isDeleted).forEach((c) => (c.tags || []).forEach((t) => tags.add(t)));
  els.tagFilter.innerHTML = '<option value="">All tags</option>' + [...tags].sort().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  els.tagFilter.value = state.tagFilter;

  els.relationFilter.innerHTML = '<option value="">All relationships</option>' + state.contacts.filter((c) => !c.isDeleted)
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((c) => `<option value="${c.id}">${escapeHtml(c.fullName)}</option>`).join('');
  els.relationFilter.value = state.relationFilter;
}

// ---------------------------------------------------------------------------
// Contact modal (add/edit)
// ---------------------------------------------------------------------------
function openContactModal(id) {
  const isEdit = !!id;
  const contact = isEdit ? state.contacts.find((c) => c.id === id) : null;

  els.contactModalTitle.textContent = isEdit ? 'Edit contact' : 'New contact';
  els.contactId.value = id || '';
  els.fullNameInput.value = contact?.fullName || '';
  els.tagsInput.value = (contact?.tags || []).join(', ');
  els.frequencyInput.value = contact?.frequencyGoalDays ?? '';
  els.notesInput.value = contact?.notes || '';
  els.deleteContactBtn.hidden = !isEdit;

  state.pendingPfpBase64 = contact?.pfpBase64 || null;
  updatePfpPreview(contact?.fullName || '');

  state.handleRowsDraft = contact ? contact.contactMethods.map((h) => ({ ...h })) : [];
  state.relationRowsDraft = contact ? contact.relationships.map((r) => ({ ...r })) : [];
  state.interactionsDraft = contact ? contact.interactions.map((i) => ({ ...i })) : [];

  renderHandleRows();
  renderRelationRows();
  renderInteractionList();
  populateRelationTargetSelect(id);

  els.contactModal.hidden = false;
}

function updatePfpPreview(name) {
  if (state.pendingPfpBase64) {
    els.pfpImg.src = state.pendingPfpBase64;
    els.pfpImg.hidden = false;
    els.pfpInitial.hidden = true;
  } else {
    els.pfpImg.hidden = true;
    els.pfpInitial.hidden = false;
    els.pfpInitial.textContent = initials(name || els.fullNameInput.value);
  }
}

function renderHandleRows() {
  els.handleRows.innerHTML = '';
  state.handleRowsDraft.forEach((h, idx) => {
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <select class="select" data-idx="${idx}" data-field="platform">
        ${['phone','email','whatsapp','discord','instagram','snapchat','other'].map((p) => `<option value="${p}" ${p === h.platform ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
      <input class="input" data-idx="${idx}" data-field="value" value="${escapeHtml(h.value)}" placeholder="Value">
      <button type="button" class="row-remove" data-remove="${idx}" aria-label="Remove">&times;</button>
    `;
    els.handleRows.appendChild(row);
  });
  els.handleRows.querySelectorAll('select, input').forEach((el) => {
    el.addEventListener('input', (e) => {
      const idx = +e.target.dataset.idx, field = e.target.dataset.field;
      state.handleRowsDraft[idx][field] = e.target.value;
    });
  });
  els.handleRows.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.handleRowsDraft.splice(+btn.dataset.remove, 1);
      renderHandleRows();
    });
  });
}

function renderRelationRows() {
  els.relationRows.innerHTML = '';
  state.relationRowsDraft.forEach((r, idx) => {
    const target = state.contacts.find((c) => c.id === r.targetContactId);
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <span style="flex:1; font-size:13px;">${escapeHtml(r.label)} — <strong>${escapeHtml(target?.fullName || 'Unknown')}</strong></span>
      <button type="button" class="row-remove" data-remove="${idx}" aria-label="Remove">&times;</button>
    `;
    els.relationRows.appendChild(row);
  });
  els.relationRows.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.relationRowsDraft.splice(+btn.dataset.remove, 1);
      renderRelationRows();
    });
  });
}

function populateRelationTargetSelect(excludeId) {
  els.relationTargetSelect.innerHTML = state.contacts
    .filter((c) => !c.isDeleted && c.id !== excludeId)
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((c) => `<option value="${c.id}">${escapeHtml(c.fullName)}</option>`).join('');
}

function renderInteractionList() {
  const sorted = [...state.interactionsDraft].sort((a, b) => b.date - a.date);
  els.interactionList.innerHTML = sorted.map((i) => `
    <div class="interaction-item">
      <div class="interaction-meta"><span>${escapeHtml(i.channel)}</span><span>${new Date(i.date).toLocaleDateString()}</span></div>
      <div class="interaction-summary">${escapeHtml(i.summary)}</div>
    </div>
  `).join('') || '<p class="empty-sub">No interactions logged yet.</p>';
}

function closeModal(id) {
  document.getElementById(id).hidden = true;
}

async function saveContactFromModal() {
  const id = els.contactId.value || uuid();
  const existing = state.contacts.find((c) => c.id === id);
  const fullName = els.fullNameInput.value.trim();
  if (!fullName) { toast('Name is required.'); return; }

  const lastContactedAt = state.interactionsDraft.length
    ? Math.max(...state.interactionsDraft.map((i) => i.date))
    : existing?.lastContactedAt;

  const contact = {
    id,
    fullName,
    pfpBase64: state.pendingPfpBase64 || undefined,
    frequencyGoalDays: els.frequencyInput.value ? Number(els.frequencyInput.value) : undefined,
    lastContactedAt,
    contactMethods: state.handleRowsDraft.filter((h) => h.value && h.value.trim()),
    relationships: state.relationRowsDraft,
    tags: els.tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
    notes: els.notesInput.value,
    interactions: state.interactionsDraft,
    updatedAt: Date.now(),
    isDeleted: false,
  };

  const idx = state.contacts.findIndex((c) => c.id === id);
  if (idx >= 0) state.contacts[idx] = contact; else state.contacts.push(contact);

  await persistContact(contact);
  rebuildSearchIndex();
  populateTagFilterOptions();
  renderDirectory();
  renderReports();
  closeModal('contactModal');
  toast('Contact saved.');
}

async function deleteCurrentContact() {
  const id = els.contactId.value;
  if (!id) return;
  if (!confirm('Delete this contact? This can be undone by restoring from a backup.')) return;
  const contact = state.contacts.find((c) => c.id === id);
  if (!contact) return;
  contact.isDeleted = true;
  contact.updatedAt = Date.now();
  await persistContact(contact);
  rebuildSearchIndex();
  populateTagFilterOptions();
  renderDirectory();
  renderReports();
  closeModal('contactModal');
  toast('Contact deleted.');
}

// ---------------------------------------------------------------------------
// PFP upload (client-side canvas resize, <=300x300, compressed)
// ---------------------------------------------------------------------------
function handlePfpFile(file) {
  const img = new Image();
  const reader = new FileReader();
  reader.onload = (e) => {
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 300;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);

      let quality = 0.85;
      let dataUrl = canvas.toDataURL('image/webp', quality);
      while (dataUrl.length * 0.75 > 30 * 1024 && quality > 0.3) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL('image/webp', quality);
      }
      state.pendingPfpBase64 = dataUrl;
      updatePfpPreview();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ---------------------------------------------------------------------------
// Quick interaction modal
// ---------------------------------------------------------------------------
function openInteractionModal(contactId) {
  els.quickInteractionContactId.value = contactId;
  els.quickChannelInput.value = '';
  els.quickSummaryInput.value = '';
  els.interactionModal.hidden = false;
}

async function saveQuickInteraction() {
  const id = els.quickInteractionContactId.value;
  const contact = state.contacts.find((c) => c.id === id);
  if (!contact) return;
  const channel = els.quickChannelInput.value.trim() || 'Touchpoint';
  const summary = els.quickSummaryInput.value.trim();
  const now = Date.now();
  contact.interactions.push({ id: uuid(), date: now, channel, summary });
  contact.lastContactedAt = now;
  contact.updatedAt = now;
  await persistContact(contact);
  renderDirectory();
  renderReports();
  closeModal('interactionModal');
  toast('Interaction logged.');
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function renderReports() {
  const active = state.contacts.filter((c) => !c.isDeleted);
  const overdue = active.filter(isOverdue).sort((a, b) => b.lastContactedAt - a.lastContactedAt);
  els.reportOverdue.innerHTML = overdue.length
    ? overdue.map((c) => `<div class="report-row"><span>${escapeHtml(c.fullName)}</span><span>${formatLastContacted(c)}</span></div>`).join('')
    : '<p class="empty-sub">Nothing overdue — nice work.</p>';

  const tagCounts = {};
  active.forEach((c) => (c.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  els.reportTags.innerHTML = sortedTags.length
    ? sortedTags.map(([tag, count]) => `<div class="report-row"><span>${escapeHtml(tag)}</span><span>${count}</span></div>`).join('')
    : '<p class="empty-sub">No tags yet.</p>';
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportRawJson() {
  const active = state.contacts.filter((c) => !c.isDeleted);
  downloadFile('rolodex-backup-raw.json', JSON.stringify(active, null, 2), 'application/json');
  toast('Raw backup downloaded — keep this file somewhere safe and private.');
}

async function exportEncryptedJson() {
  const active = state.contacts.filter((c) => !c.isDeleted);
  const envelope = await CryptoEngine.encrypt({ contacts: active });
  downloadFile('rolodex-backup-encrypted.json', JSON.stringify(envelope), 'application/json');
  toast('Encrypted backup downloaded.');
}

function exportCsv() {
  const active = state.contacts.filter((c) => !c.isDeleted);
  const headers = ['Full Name', 'Tags', 'Contact Methods', 'Last Contacted', 'Reconnect Goal (days)', 'Notes'];
  const rows = active.map((c) => [
    c.fullName,
    (c.tags || []).join('; '),
    (c.contactMethods || []).map((h) => `${h.platform}:${h.value}`).join('; '),
    c.lastContactedAt ? new Date(c.lastContactedAt).toISOString() : '',
    c.frequencyGoalDays ?? '',
    (c.notes || '').replace(/\n/g, ' '),
  ]);
  const csv = [headers, ...rows].map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadFile('rolodex-contacts.csv', csv, 'text/csv');
  toast('CSV exported.');
}

// ---------------------------------------------------------------------------
// vCard import
// ---------------------------------------------------------------------------
let importQueue = [];

async function handleVcfFiles(files) {
  for (const file of files) {
    const text = await file.text();
    const parsed = VCardParser.parse(text);
    importQueue.push(...parsed);
  }
  renderImportQueue();
}

function renderImportQueue() {
  els.importQueue.innerHTML = importQueue.map((c, idx) => `
    <div class="import-item">
      <span>${escapeHtml(c.fullName)} <span class="empty-sub">(${(c.contactMethods || []).length} handle${(c.contactMethods || []).length === 1 ? '' : 's'})</span></span>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-secondary btn-small" data-review="${idx}">Review</button>
        <button class="btn btn-primary btn-small" data-accept="${idx}">Add</button>
      </div>
    </div>
  `).join('');

  els.importQueue.querySelectorAll('[data-accept]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = +btn.dataset.accept;
      await acceptImportedContact(importQueue[idx]);
      importQueue.splice(idx, 1);
      renderImportQueue();
    });
  });
  els.importQueue.querySelectorAll('[data-review]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = +btn.dataset.review;
      openContactModal(null);
      prefillModalFromParsed(importQueue[idx]);
    });
  });
}

function prefillModalFromParsed(parsed) {
  els.fullNameInput.value = parsed.fullName || '';
  els.notesInput.value = parsed.notes || '';
  els.tagsInput.value = (parsed.tags || []).join(', ');
  state.handleRowsDraft = (parsed.contactMethods || []).map((h) => ({ ...h }));
  renderHandleRows();
}

async function acceptImportedContact(parsed) {
  const contact = {
    id: uuid(),
    fullName: parsed.fullName,
    contactMethods: parsed.contactMethods || [],
    relationships: [],
    tags: parsed.tags || [],
    notes: parsed.notes || '',
    interactions: [],
    updatedAt: Date.now(),
    isDeleted: false,
  };
  state.contacts.push(contact);
  await persistContact(contact);
  rebuildSearchIndex();
  populateTagFilterOptions();
  renderDirectory();
  renderReports();
  toast(`${contact.fullName} added.`);
}

// ---------------------------------------------------------------------------
// Sync (merge local + remote by updatedAt, last-write-wins)
// ---------------------------------------------------------------------------
async function syncNow() {
  if (!GoogleDrive.isConfigured()) {
    toast('Google Drive is not configured yet — see gdrive.js.');
    return;
  }
  els.syncBtn.disabled = true;
  try {
    if (!GoogleDrive.isSignedIn()) await GoogleDrive.signIn();
    toast('Syncing…');

    const remoteEnvelope = await GoogleDrive.downloadBackup();
    let remoteContacts = [];
    if (remoteEnvelope) {
      const remotePayload = await CryptoEngine.decrypt(remoteEnvelope);
      remoteContacts = remotePayload.contacts || [];
    }

    const byId = new Map();
    for (const c of state.contacts) byId.set(c.id, c);
    for (const rc of remoteContacts) {
      const local = byId.get(rc.id);
      if (!local || rc.updatedAt > local.updatedAt) byId.set(rc.id, rc);
    }
    state.contacts = [...byId.values()];
    await persistAll();

    const envelope = await CryptoEngine.encrypt({ contacts: state.contacts.filter((c) => !c.isDeleted || c) });
    await GoogleDrive.uploadBackup(envelope);

    state.lastSyncAt = Date.now();
    rebuildSearchIndex();
    populateTagFilterOptions();
    renderDirectory();
    renderReports();
    updateSettingsPanel();
    toast('Synced with Google Drive.');
  } catch (e) {
    console.error(e);
    toast(`Sync failed: ${e.message}`);
  } finally {
    els.syncBtn.disabled = false;
  }
}

function updateSettingsPanel() {
  els.settingsGoogleStatus.textContent = GoogleDrive.isSignedIn() ? 'Connected.' : 'Not connected.';
  els.settingsLastSync.textContent = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : 'Never.';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function init() {
  cacheEls();
  initLockScreen();

  // Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`view-${tab.dataset.view}`).classList.add('active');
    });
  });

  // Search
  let searchDebounce;
  els.globalSearch.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      if (state.semanticEnabled && state.searchQuery) {
        try { await runSemanticQuery(state.searchQuery); } catch (err) { console.error(err); }
      }
      renderDirectory();
    }, 200);
  });
  els.semanticToggle.addEventListener('change', (e) => onSemanticToggle(e.target.checked));

  // Filters
  els.tagFilter.addEventListener('change', (e) => { state.tagFilter = e.target.value; renderDirectory(); });
  els.relationFilter.addEventListener('change', (e) => { state.relationFilter = e.target.value; renderDirectory(); });
  els.overdueFilterBtn.addEventListener('click', () => {
    state.overdueOnly = !state.overdueOnly;
    els.overdueFilterBtn.dataset.active = String(state.overdueOnly);
    renderDirectory();
  });

  // Contact modal
  els.addContactBtn.addEventListener('click', () => openContactModal(null));
  els.saveContactBtn.addEventListener('click', saveContactFromModal);
  els.deleteContactBtn.addEventListener('click', deleteCurrentContact);
  els.pfpInput.addEventListener('change', (e) => { if (e.target.files[0]) handlePfpFile(e.target.files[0]); });
  els.addHandleBtn.addEventListener('click', () => { state.handleRowsDraft.push({ platform: 'phone', value: '' }); renderHandleRows(); });
  els.addRelationBtn.addEventListener('click', () => {
    const targetId = els.relationTargetSelect.value;
    const label = els.relationLabelInput.value.trim();
    if (!targetId || !label) { toast('Pick a person and a relationship label.'); return; }
    state.relationRowsDraft.push({ targetContactId: targetId, label });
    els.relationLabelInput.value = '';
    renderRelationRows();
  });
  els.addInteractionBtn.addEventListener('click', () => {
    const channel = prompt('Channel (e.g. Coffee, Call, Discord):');
    if (channel === null) return;
    const summary = prompt('Summary:') || '';
    state.interactionsDraft.push({ id: uuid(), date: Date.now(), channel: channel || 'Touchpoint', summary });
    renderInteractionList();
  });

  // Quick interaction modal
  els.saveQuickInteractionBtn.addEventListener('click', saveQuickInteraction);

  // Modal close buttons / backdrop
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.hidden = true; });
  });

  // Sync & settings
  els.syncBtn.addEventListener('click', syncNow);
  els.settingsBtn.addEventListener('click', () => { updateSettingsPanel(); els.settingsModal.hidden = false; });
  els.settingsGoogleBtn.addEventListener('click', async () => {
    try { await GoogleDrive.signIn(); updateSettingsPanel(); toast('Connected to Google Drive.'); }
    catch (e) { toast(e.message); }
  });
  els.lockNowBtn.addEventListener('click', () => { closeModal('settingsModal'); lockNow(); });
  els.wipeLocalBtn.addEventListener('click', async () => {
    if (!confirm('This permanently deletes all local data on this device. Continue?')) return;
    await db.records.clear();
    localStorage.removeItem('rolodex_kdf_salt_v1');
    localStorage.removeItem('rolodex_verifier_v1');
    location.reload();
  });

  // Reports/export
  els.exportRawBtn.addEventListener('click', exportRawJson);
  els.exportEncryptedBtn.addEventListener('click', exportEncryptedJson);
  els.exportCsvBtn.addEventListener('click', exportCsv);

  // Import (drag & drop + file picker)
  els.vcfInput.addEventListener('change', (e) => handleVcfFiles([...e.target.files]));
  els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('drag-over'); });
  els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag-over'));
  els.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('drag-over');
    handleVcfFiles([...e.dataTransfer.files].filter((f) => f.name.endsWith('.vcf')));
  });

  // Service worker (best-effort; ignored if unsupported/blocked)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
