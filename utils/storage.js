/**
 * FormVault — Shared Storage Helpers
 * All data stored in chrome.storage.local. Zero network requests.
 */

/* eslint-disable no-implicit-globals */
const FormVaultStorage = (() => {
  const STORAGE_KEY = 'forms';
  const SETTINGS_KEY = 'settings';
  const QUOTA_WARNING_THRESHOLD = 0.8; // 80% of 10MB
  const MAX_BYTES = 10 * 1024 * 1024; // 10MB limit

  // Default settings
  const DEFAULT_SETTINGS = {
    autoSaveEnabled: true,
    showRestoreToast: true,
    blocklist: '',
    retentionDays: 30
  };

  /**
   * Get all saved forms
   * @returns {Promise<Object>} All saved form entries keyed by pageKey
   */
  async function getAllForms() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] || {};
    } catch (e) {
      console.error('FormVault: Failed to read forms', e);
      return {};
    }
  }

  /**
   * Get saved form data for a specific page key
   * @param {string} pageKey - The unique key for the page
   * @returns {Promise<Object|null>} The saved form data or null
   */
  async function getForm(pageKey) {
    const forms = await getAllForms();
    return forms[pageKey] || null;
  }

  /**
   * Save form data for a specific page key.
   * Pre-checks quota and prunes if near the limit before writing.
   * @param {string} pageKey - The unique key for the page
   * @param {Object} formData - The form data to save
   * @returns {Promise<void>}
   */
  async function saveForm(pageKey, formData) {
    try {
      // Pre-check quota before saving
      const bytesUsed = await chrome.storage.local.getBytesInUse(null);
      if (bytesUsed >= MAX_BYTES * QUOTA_WARNING_THRESHOLD) {
        await pruneIfNearQuota();
      }

      const forms = await getAllForms();
      const existing = forms[pageKey] || {};
      const existingFields = Array.isArray(existing.fields) ? existing.fields : [];
      const incomingFields = Array.isArray(formData.fields) ? formData.fields : [];
      const incomingFrames = new Set(incomingFields.map(field => field.frame || ''));
      const fields = [
        ...existingFields.filter(field => !incomingFrames.has(field.frame || '')),
        ...incomingFields
      ];

      forms[pageKey] = {
        ...existing,
        ...formData,
        fields,
        savedAt: Date.now()
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: forms });
    } catch (e) {
      console.error('FormVault: Failed to save form', { pageKey, error: e.message || e });
    }
  }

  /**
   * Delete a specific saved form
   * @param {string} pageKey - The unique key for the page
   * @returns {Promise<void>}
   */
  async function deleteForm(pageKey) {
    try {
      const forms = await getAllForms();
      delete forms[pageKey];
      await chrome.storage.local.set({ [STORAGE_KEY]: forms });
    } catch (e) {
      console.error('FormVault: Failed to delete form', e);
    }
  }

  /**
   * Delete all saved forms
   * @returns {Promise<void>}
   */
  async function deleteAllForms() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: {} });
    } catch (e) {
      console.error('FormVault: Failed to clear all forms', e);
    }
  }

  /**
   * Search forms by title, URL, or field content
   * @param {string} query - Search query string
   * @returns {Promise<Object>} Matching form entries
   */
  async function searchForms(query) {
    const forms = await getAllForms();
    if (!query || !query.trim()) return forms;

    const lowerQuery = query.toLowerCase().trim();
    const results = {};

    for (const [key, form] of Object.entries(forms)) {
      if (form.title && form.title.toLowerCase().includes(lowerQuery)) {
        results[key] = form;
        continue;
      }
      if (form.url && form.url.toLowerCase().includes(lowerQuery)) {
        results[key] = form;
        continue;
      }
      if (form.fields && form.fields.some(field =>
        (field.label && field.label.toLowerCase().includes(lowerQuery)) ||
        (field.value && field.value.toLowerCase().includes(lowerQuery))
      )) {
        results[key] = form;
      }
    }

    return results;
  }

  /**
   * Delete forms older than the specified number of days
   * @param {number} days - Maximum age in days
   * @returns {Promise<number>} Number of forms deleted
   */
  async function pruneOldForms(days) {
    if (days <= 0) return 0;
    const forms = await getAllForms();
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    let deleted = 0;

    for (const [key, form] of Object.entries(forms)) {
      if (form.savedAt < cutoff) {
        delete forms[key];
        deleted++;
      }
    }

    if (deleted > 0) {
      await chrome.storage.local.set({ [STORAGE_KEY]: forms });
    }
    return deleted;
  }

  /**
   * Auto-prune oldest entries when storage is near quota
   * @returns {Promise<number>} Number of forms pruned
   */
  async function pruneIfNearQuota() {
    try {
      const bytesUsed = await chrome.storage.local.getBytesInUse(null);
      if (bytesUsed < MAX_BYTES * QUOTA_WARNING_THRESHOLD) return 0;

      const forms = await getAllForms();
      const entries = Object.entries(forms).sort((a, b) => a[1].savedAt - b[1].savedAt);
      let pruned = 0;

      // Remove oldest 20% of entries
      const toRemove = Math.max(1, Math.ceil(entries.length * 0.2));
      for (let i = 0; i < toRemove && i < entries.length; i++) {
        delete forms[entries[i][0]];
        pruned++;
      }

      if (pruned > 0) {
        await chrome.storage.local.set({ [STORAGE_KEY]: forms });
      }
      return pruned;
    } catch (e) {
      console.error('FormVault: Quota pruning failed', e);
      return 0;
    }
  }

  /**
   * Get storage usage information
   * @returns {Promise<Object>} Storage usage stats
   */
  async function getStorageInfo() {
    try {
      const bytesUsed = await chrome.storage.local.getBytesInUse(null);
      const forms = await getAllForms();
      return {
        bytesUsed,
        maxBytes: MAX_BYTES,
        percentUsed: (bytesUsed / MAX_BYTES) * 100,
        nearQuota: bytesUsed >= MAX_BYTES * QUOTA_WARNING_THRESHOLD,
        formCount: Object.keys(forms).length
      };
    } catch (e) {
      console.error('FormVault: Failed to get storage info', e);
      return {
        bytesUsed: 0,
        maxBytes: MAX_BYTES,
        percentUsed: 0,
        nearQuota: false,
        formCount: 0
      };
    }
  }

  /**
   * Get count of saved forms for a specific domain
   * @param {string} domain - The domain to count forms for
   * @returns {Promise<number>} Number of saved forms
   */
  async function getFormCountForDomain(domain) {
    const forms = await getAllForms();
    let count = 0;
    for (const form of Object.values(forms)) {
      try {
        const formDomain = new URL(form.url).hostname;
        if (formDomain === domain) count++;
      } catch (e) {
        // Skip invalid URLs
      }
    }
    return count;
  }

  /**
   * Get user settings
   * @returns {Promise<Object>} User settings
   */
  async function getSettings() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
    } catch (e) {
      console.error('FormVault: Failed to read settings', e);
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * Save user settings
   * @param {Object} settings - Settings to save (merged with existing)
   * @returns {Promise<void>}
   */
  async function saveSettings(settings) {
    try {
      const current = await getSettings();
      await chrome.storage.local.set({
        [SETTINGS_KEY]: { ...current, ...settings }
      });
    } catch (e) {
      console.error('FormVault: Failed to save settings', e);
    }
  }

  /**
   * Check if a domain is blocklisted.
   * Uses exact match or subdomain match (not substring).
   * @param {string} domain - The domain to check
   * @returns {Promise<boolean>} True if blocklisted
   */
  async function isDomainBlocklisted(domain) {
    const settings = await getSettings();
    if (!settings.blocklist) return false;
    const blocklist = settings.blocklist
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(d => d.length > 0);
    const lowerDomain = domain.toLowerCase();
    return blocklist.some(blocked =>
      lowerDomain === blocked || lowerDomain.endsWith('.' + blocked)
    );
  }

  return {
    getAllForms,
    getForm,
    saveForm,
    deleteForm,
    deleteAllForms,
    searchForms,
    pruneOldForms,
    pruneIfNearQuota,
    getStorageInfo,
    getFormCountForDomain,
    getSettings,
    saveSettings,
    isDomainBlocklisted,
    DEFAULT_SETTINGS
  };
})();
