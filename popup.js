/**
 * FormVault — Popup Script
 * Handles the extension popup UI: form list, search, settings, and actions.
 */

(() => {
  'use strict';

  // ==================== DOM REFERENCES ====================

  const elements = {
    mainView: document.getElementById('mainView'),
    settingsPanel: document.getElementById('settingsPanel'),
    formList: document.getElementById('formList'),
    emptyState: document.getElementById('emptyState'),
    searchInput: document.getElementById('searchInput'),
    formCount: document.getElementById('formCount'),
    footer: document.getElementById('footer'),
    storageWarning: document.getElementById('storageWarning'),
    // Buttons
    settingsBtn: document.getElementById('settingsBtn'),
    backBtn: document.getElementById('backBtn'),
    clearAllBtn: document.getElementById('clearAllBtn'),
    // Settings
    autoSaveToggle: document.getElementById('autoSaveToggle'),
    toastToggle: document.getElementById('toastToggle'),
    retentionSelect: document.getElementById('retentionSelect'),
    blocklistInput: document.getElementById('blocklistInput'),
    // Confirm modal
    confirmOverlay: document.getElementById('confirmOverlay'),
    confirmTitle: document.getElementById('confirmTitle'),
    confirmText: document.getElementById('confirmText'),
    confirmCancel: document.getElementById('confirmCancel'),
    confirmAction: document.getElementById('confirmAction')
  };

  let allForms = {};
  let confirmCallback = null;
  let searchTimer = null;

  // ==================== INITIALIZATION ====================

  async function init() {
    await loadForms();
    await loadSettings();
    await checkStorageUsage();
    setupEventListeners();
  }

  // ==================== FORM LIST ====================

  async function loadForms(query) {
    if (query) {
      allForms = await FormVaultStorage.searchForms(query);
    } else {
      allForms = await FormVaultStorage.getAllForms();
    }
    renderFormList();
  }

  function renderFormList() {
    const entries = Object.entries(allForms);

    // Sort newest first
    entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));

    // Clear list
    while (elements.formList.firstChild) {
      elements.formList.removeChild(elements.formList.firstChild);
    }

    if (entries.length === 0) {
      elements.emptyState.style.display = 'flex';
      elements.formList.style.display = 'none';
      updateFormCount(0);
      return;
    }

    elements.emptyState.style.display = 'none';
    elements.formList.style.display = 'block';

    entries.forEach(([key, form]) => {
      const entry = createFormEntry(key, form);
      elements.formList.appendChild(entry);
    });

    updateFormCount(entries.length);
  }

  function updateFormCount(count) {
    const query = elements.searchInput.value.trim();
    if (query) {
      elements.formCount.textContent = count + ' result' + (count !== 1 ? 's' : '');
    } else {
      elements.formCount.textContent = count + ' form' + (count !== 1 ? 's' : '') + ' saved';
    }
  }

  function createFormEntry(key, form) {
    const entry = document.createElement('div');
    entry.className = 'form-entry';

    // Summary row
    const summary = document.createElement('div');
    summary.className = 'form-summary';

    // Favicon
    let favicon;
    if (form.favicon) {
      favicon = document.createElement('img');
      favicon.className = 'form-favicon';
      favicon.alt = '';
      favicon.width = 20;
      favicon.height = 20;
      favicon.src = form.favicon;
      favicon.onerror = function() {
        const placeholder = document.createElement('div');
        placeholder.className = 'form-favicon-placeholder';
        placeholder.textContent = (form.title || '?')[0].toUpperCase();
        this.replaceWith(placeholder);
      };
    } else {
      favicon = document.createElement('div');
      favicon.className = 'form-favicon-placeholder';
      favicon.textContent = (form.title || '?')[0].toUpperCase();
    }

    // Info
    const info = document.createElement('div');
    info.className = 'form-info';

    const title = document.createElement('div');
    title.className = 'form-title';
    title.textContent = truncate(form.title || 'Untitled', 40);
    title.title = form.title || '';

    const meta = document.createElement('div');
    meta.className = 'form-meta';

    const url = document.createElement('span');
    url.className = 'form-url';
    url.textContent = truncateUrl(form.url || '');
    url.title = form.url || '';

    const dot = document.createElement('span');
    dot.className = 'form-meta-dot';
    dot.textContent = '\u00B7';

    const time = document.createElement('span');
    time.className = 'form-time';
    time.textContent = timeAgo(form.savedAt);

    meta.appendChild(url);
    meta.appendChild(dot);
    meta.appendChild(time);

    info.appendChild(title);
    info.appendChild(meta);

    // Field count badge
    const fieldCount = document.createElement('span');
    fieldCount.className = 'form-field-count';
    const count = form.fields ? form.fields.length : 0;
    fieldCount.textContent = count + ' field' + (count !== 1 ? 's' : '');

    summary.appendChild(favicon);
    summary.appendChild(info);
    summary.appendChild(fieldCount);

    // Details panel (hidden by default)
    const details = document.createElement('div');
    details.className = 'form-details';

    if (form.fields) {
      form.fields.forEach(field => {
        const item = document.createElement('div');
        item.className = 'field-item';

        const label = document.createElement('span');
        label.className = 'field-label';
        label.textContent = field.label || field.name || 'Field';
        label.title = field.label || field.name || '';

        const value = document.createElement('span');
        value.className = 'field-value';
        value.textContent = truncate(formatFieldValue(field.value), 50);
        value.title = formatFieldValue(field.value);

        item.appendChild(label);
        item.appendChild(value);
        details.appendChild(item);
      });
    }

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn btn-restore';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: form.url });
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-copy';
    copyBtn.textContent = 'Copy All';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const success = await copyFormData(form);
      copyBtn.textContent = success ? 'Copied!' : 'Failed';
      setTimeout(() => { copyBtn.textContent = 'Copy All'; }, 1500);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirm(
        'Delete this form?',
        'The saved data for this form will be permanently deleted.',
        async () => {
          await FormVaultStorage.deleteForm(key);
          await loadForms(elements.searchInput.value);
        }
      );
    });

    actions.appendChild(restoreBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(deleteBtn);
    details.appendChild(actions);

    entry.appendChild(summary);
    entry.appendChild(details);

    // Toggle expand on click
    summary.addEventListener('click', () => {
      entry.classList.toggle('expanded');
    });

    return entry;
  }

  // ==================== SETTINGS ====================

  async function loadSettings() {
    const settings = await FormVaultStorage.getSettings();

    elements.autoSaveToggle.checked = settings.autoSaveEnabled;
    elements.toastToggle.checked = settings.showRestoreToast;
    elements.retentionSelect.value = String(settings.retentionDays);
    elements.blocklistInput.value = settings.blocklist || '';
  }

  async function saveSetting(key, value) {
    await FormVaultStorage.saveSettings({ [key]: value });
  }

  // ==================== STORAGE CHECK ====================

  async function checkStorageUsage() {
    const info = await FormVaultStorage.getStorageInfo();
    if (info.nearQuota) {
      elements.storageWarning.classList.add('visible');
    } else {
      elements.storageWarning.classList.remove('visible');
    }
  }

  // ==================== CONFIRM MODAL ====================

  function showConfirm(title, text, callback) {
    elements.confirmTitle.textContent = title;
    elements.confirmText.textContent = text;
    confirmCallback = callback;
    elements.confirmOverlay.classList.add('visible');
  }

  function hideConfirm() {
    elements.confirmOverlay.classList.remove('visible');
    confirmCallback = null;
  }

  // ==================== EVENT LISTENERS ====================

  function setupEventListeners() {
    // Search (debounced)
    elements.searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        loadForms(elements.searchInput.value);
      }, 200);
    });

    // Settings toggle
    elements.settingsBtn.addEventListener('click', () => {
      elements.mainView.style.display = 'none';
      elements.settingsPanel.classList.add('visible');
    });

    elements.backBtn.addEventListener('click', () => {
      elements.settingsPanel.classList.remove('visible');
      elements.mainView.style.display = '';
      // Refresh list in case settings changed retention
      loadForms(elements.searchInput.value);
    });

    // Settings changes
    elements.autoSaveToggle.addEventListener('change', () => {
      saveSetting('autoSaveEnabled', elements.autoSaveToggle.checked);
    });

    elements.toastToggle.addEventListener('change', () => {
      saveSetting('showRestoreToast', elements.toastToggle.checked);
    });

    elements.retentionSelect.addEventListener('change', () => {
      saveSetting('retentionDays', parseInt(elements.retentionSelect.value, 10));
    });

    // Blocklist input with validation
    elements.blocklistInput.addEventListener('change', () => {
      const raw = elements.blocklistInput.value;
      const domains = raw.split(',')
        .map(d => d.trim().toLowerCase())
        .filter(d => d.length > 0 && /^[\w.-]+$/.test(d));
      const cleaned = [...new Set(domains)].join(', ');
      elements.blocklistInput.value = cleaned;
      saveSetting('blocklist', cleaned);
    });

    // Clear All
    elements.clearAllBtn.addEventListener('click', () => {
      showConfirm(
        'Clear all saved forms?',
        'All saved form data will be permanently deleted. This cannot be undone.',
        async () => {
          await FormVaultStorage.deleteAllForms();
          await loadForms();
        }
      );
    });

    // Confirm modal
    elements.confirmCancel.addEventListener('click', hideConfirm);
    elements.confirmAction.addEventListener('click', async () => {
      if (confirmCallback) {
        await confirmCallback();
      }
      hideConfirm();
    });
    elements.confirmOverlay.addEventListener('click', (e) => {
      if (e.target === elements.confirmOverlay) hideConfirm();
    });

    // Live-update the form list when storage changes (e.g. from another tab saving)
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.forms) {
        loadForms(elements.searchInput.value);
      }
    });
  }

  // ==================== UTILITIES ====================

  function truncate(str, maxLen) {
    if (!str) return '';
    return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
  }

  function truncateUrl(urlStr) {
    try {
      const url = new URL(urlStr);
      const path = url.pathname === '/' ? '' : url.pathname;
      return url.hostname + truncate(path, 30);
    } catch (e) {
      return truncate(urlStr, 40);
    }
  }

  function timeAgo(timestamp) {
    if (!timestamp) return 'unknown';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' min' + (minutes !== 1 ? 's' : '') + ' ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' hr' + (hours !== 1 ? 's' : '') + ' ago';
    const days = Math.floor(hours / 24);
    return days + ' day' + (days !== 1 ? 's' : '') + ' ago';
  }

  function formatFieldValue(value) {
    if (Array.isArray(value)) return value.join(', ');
    return value || '';
  }

  /**
   * Copy form data to clipboard. Returns true on success, false on failure.
   */
  async function copyFormData(form) {
    if (!form.fields || form.fields.length === 0) return false;

    const lines = [
      'FormVault — ' + (form.title || 'Untitled'),
      'URL: ' + (form.url || ''),
      '---'
    ];

    form.fields.forEach(field => {
      const label = field.label || field.name || 'Field';
      lines.push(label + ': ' + formatFieldValue(field.value));
    });

    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.error('FormVault: Clipboard write failed', e);
      return false;
    }
  }

  // ==================== START ====================

  init();
})();
