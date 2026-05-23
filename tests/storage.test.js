/**
 * FormVault — Storage Module Tests
 */

const fs = require('fs');
const path = require('path');

// Load storage module — it assigns FormVaultStorage to the global scope
const storageSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'utils', 'storage.js'),
  'utf-8'
);

beforeAll(() => {
  // Replace `const FormVaultStorage` with assignment to global so it's accessible in tests
  const patchedSource = storageSource.replace(
    /^(\/\*.*?\*\/\s*\n\s*\/\*.*?\*\/\s*\n)?const FormVaultStorage/m,
    'global.FormVaultStorage'
  );
  const fn = new Function(patchedSource);
  fn();
});

beforeEach(() => {
  global.__resetChromeStorage();
});

// ==================== getAllForms ====================

describe('getAllForms', () => {
  test('returns empty object when no forms saved', async () => {
    const forms = await FormVaultStorage.getAllForms();
    expect(forms).toEqual({});
  });

  test('returns saved forms', async () => {
    const testForms = {
      'https://example.com': { url: 'https://example.com', fields: [], savedAt: 1000 }
    };
    await chrome.storage.local.set({ forms: testForms });

    const forms = await FormVaultStorage.getAllForms();
    expect(forms).toEqual(testForms);
  });

  test('returns empty object on storage error', async () => {
    chrome.storage.local.get.mockRejectedValueOnce(new Error('fail'));
    const forms = await FormVaultStorage.getAllForms();
    expect(forms).toEqual({});
  });
});

// ==================== getForm ====================

describe('getForm', () => {
  test('returns form data for existing key', async () => {
    const formData = { url: 'https://test.com', fields: [{ label: 'Name', value: 'Alice' }], savedAt: 1000 };
    await chrome.storage.local.set({ forms: { 'key1': formData } });

    const result = await FormVaultStorage.getForm('key1');
    expect(result).toEqual(formData);
  });

  test('returns null for missing key', async () => {
    await chrome.storage.local.set({ forms: {} });
    const result = await FormVaultStorage.getForm('nonexistent');
    expect(result).toBeNull();
  });
});

// ==================== saveForm ====================

describe('saveForm', () => {
  test('saves form data with savedAt timestamp', async () => {
    const now = Date.now();
    await FormVaultStorage.saveForm('page1', { url: 'https://example.com', fields: [] });

    const stored = await chrome.storage.local.get('forms');
    expect(stored.forms.page1).toBeDefined();
    expect(stored.forms.page1.url).toBe('https://example.com');
    expect(stored.forms.page1.savedAt).toBeGreaterThanOrEqual(now);
  });

  test('overwrites existing form at same key', async () => {
    await FormVaultStorage.saveForm('page1', { url: 'https://old.com', fields: [] });
    await FormVaultStorage.saveForm('page1', { url: 'https://new.com', fields: [] });

    const stored = await chrome.storage.local.get('forms');
    expect(stored.forms.page1.url).toBe('https://new.com');
  });

  test('merges fields from different frames at same page key', async () => {
    await FormVaultStorage.saveForm('page1', {
      url: 'https://example.com',
      fields: [{
        name: 'top-field',
        value: 'top',
        frame: ''
      }]
    });
    await FormVaultStorage.saveForm('page1', {
      url: 'https://example.com/frame',
      fields: [{
        name: 'frame-field',
        value: 'frame',
        frame: 'https://example.com/frame'
      }]
    });

    const stored = await chrome.storage.local.get('forms');
    expect(stored.forms.page1.fields).toEqual([
      expect.objectContaining({ name: 'top-field', frame: '' }),
      expect.objectContaining({ name: 'frame-field', frame: 'https://example.com/frame' })
    ]);
  });

  test('replaces fields only for the frame being saved', async () => {
    await chrome.storage.local.set({
      forms: {
        page1: {
          url: 'https://example.com',
          fields: [
            { name: 'top-field', value: 'top', frame: '' },
            { name: 'old-frame-field', value: 'old', frame: 'https://example.com/frame' }
          ],
          savedAt: 1000
        }
      }
    });

    await FormVaultStorage.saveForm('page1', {
      url: 'https://example.com/frame',
      fields: [{
        name: 'new-frame-field',
        value: 'new',
        frame: 'https://example.com/frame'
      }]
    });

    const stored = await chrome.storage.local.get('forms');
    expect(stored.forms.page1.fields).toEqual([
      expect.objectContaining({ name: 'top-field', frame: '' }),
      expect.objectContaining({ name: 'new-frame-field', frame: 'https://example.com/frame' })
    ]);
    expect(stored.forms.page1.fields).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'old-frame-field' })
    ]));
  });

  test('triggers quota prune when near limit', async () => {
    // Simulate high storage usage (above 80% of 10MB)
    chrome.storage.local.getBytesInUse.mockResolvedValueOnce(9 * 1024 * 1024);

    // Pre-populate with old forms that can be pruned
    const oldForms = {};
    for (let i = 0; i < 10; i++) {
      oldForms[`old-${i}`] = { url: `https://old${i}.com`, fields: [], savedAt: 1000 + i };
    }
    await chrome.storage.local.set({ forms: oldForms });

    // getBytesInUse will be called again inside pruneIfNearQuota
    chrome.storage.local.getBytesInUse.mockResolvedValueOnce(9 * 1024 * 1024);

    await FormVaultStorage.saveForm('new-page', { url: 'https://new.com', fields: [] });

    const stored = await chrome.storage.local.get('forms');
    // Should have pruned some old forms but saved the new one
    expect(stored.forms['new-page']).toBeDefined();
  });

  test('handles save error gracefully', async () => {
    chrome.storage.local.getBytesInUse.mockResolvedValueOnce(0);
    chrome.storage.local.set.mockRejectedValueOnce(new Error('quota exceeded'));

    // Should not throw
    await FormVaultStorage.saveForm('page1', { url: 'https://test.com', fields: [] });
  });
});

// ==================== deleteForm ====================

describe('deleteForm', () => {
  test('removes specified form', async () => {
    await chrome.storage.local.set({
      forms: {
        'key1': { url: 'https://a.com', savedAt: 1000 },
        'key2': { url: 'https://b.com', savedAt: 2000 }
      }
    });

    await FormVaultStorage.deleteForm('key1');

    const stored = await chrome.storage.local.get('forms');
    expect(stored.forms.key1).toBeUndefined();
    expect(stored.forms.key2).toBeDefined();
  });

  test('handles missing key gracefully', async () => {
    await chrome.storage.local.set({ forms: {} });
    await FormVaultStorage.deleteForm('nonexistent');
    // Should not throw
  });
});

// ==================== deleteAllForms ====================

describe('deleteAllForms', () => {
  test('clears all forms', async () => {
    await chrome.storage.local.set({
      forms: { 'a': { savedAt: 1 }, 'b': { savedAt: 2 } }
    });

    await FormVaultStorage.deleteAllForms();

    const stored = await chrome.storage.local.get('forms');
    expect(stored.forms).toEqual({});
  });
});

// ==================== searchForms ====================

describe('searchForms', () => {
  const testForms = {
    'page1': { title: 'Login Form', url: 'https://example.com/login', fields: [{ label: 'Email', value: 'alice@test.com' }], savedAt: 1000 },
    'page2': { title: 'Contact Us', url: 'https://other.com/contact', fields: [{ label: 'Message', value: 'Hello world' }], savedAt: 2000 },
    'page3': { title: 'Registration', url: 'https://example.com/register', fields: [{ label: 'Username', value: 'bob' }], savedAt: 3000 }
  };

  beforeEach(async () => {
    await chrome.storage.local.set({ forms: testForms });
  });

  test('returns all forms when query is empty', async () => {
    const results = await FormVaultStorage.searchForms('');
    expect(Object.keys(results)).toHaveLength(3);
  });

  test('returns all forms when query is null', async () => {
    const results = await FormVaultStorage.searchForms(null);
    expect(Object.keys(results)).toHaveLength(3);
  });

  test('matches by title', async () => {
    const results = await FormVaultStorage.searchForms('login');
    expect(Object.keys(results)).toHaveLength(1);
    expect(results.page1).toBeDefined();
  });

  test('matches by URL', async () => {
    const results = await FormVaultStorage.searchForms('other.com');
    expect(Object.keys(results)).toHaveLength(1);
    expect(results.page2).toBeDefined();
  });

  test('matches by field label', async () => {
    const results = await FormVaultStorage.searchForms('username');
    expect(Object.keys(results)).toHaveLength(1);
    expect(results.page3).toBeDefined();
  });

  test('matches by field value', async () => {
    const results = await FormVaultStorage.searchForms('alice@test.com');
    expect(Object.keys(results)).toHaveLength(1);
    expect(results.page1).toBeDefined();
  });

  test('returns empty object when nothing matches', async () => {
    const results = await FormVaultStorage.searchForms('zzzzz');
    expect(Object.keys(results)).toHaveLength(0);
  });

  test('search is case-insensitive', async () => {
    const results = await FormVaultStorage.searchForms('LOGIN');
    expect(Object.keys(results)).toHaveLength(1);
  });
});

// ==================== pruneOldForms ====================

describe('pruneOldForms', () => {
  test('deletes forms older than specified days', async () => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    await chrome.storage.local.set({
      forms: {
        'old': { url: 'https://old.com', savedAt: now - (10 * oneDay) },
        'new': { url: 'https://new.com', savedAt: now - (1 * oneDay) }
      }
    });

    const deleted = await FormVaultStorage.pruneOldForms(7);
    expect(deleted).toBe(1);

    const stored = await chrome.storage.local.get('forms');
    expect(stored.forms.old).toBeUndefined();
    expect(stored.forms.new).toBeDefined();
  });

  test('keeps all forms when none are expired', async () => {
    const now = Date.now();
    await chrome.storage.local.set({
      forms: {
        'fresh': { url: 'https://fresh.com', savedAt: now }
      }
    });

    const deleted = await FormVaultStorage.pruneOldForms(30);
    expect(deleted).toBe(0);
  });

  test('returns 0 when days is 0 (never delete)', async () => {
    const deleted = await FormVaultStorage.pruneOldForms(0);
    expect(deleted).toBe(0);
  });

  test('returns 0 when days is negative', async () => {
    const deleted = await FormVaultStorage.pruneOldForms(-5);
    expect(deleted).toBe(0);
  });
});

// ==================== pruneIfNearQuota ====================

describe('pruneIfNearQuota', () => {
  test('does nothing when under threshold', async () => {
    chrome.storage.local.getBytesInUse.mockResolvedValueOnce(1000);
    const pruned = await FormVaultStorage.pruneIfNearQuota();
    expect(pruned).toBe(0);
  });

  test('removes oldest 20% when over threshold', async () => {
    chrome.storage.local.getBytesInUse.mockResolvedValueOnce(9 * 1024 * 1024);

    const forms = {};
    for (let i = 0; i < 10; i++) {
      forms[`form-${i}`] = { url: `https://test${i}.com`, savedAt: 1000 + i };
    }
    await chrome.storage.local.set({ forms });

    const pruned = await FormVaultStorage.pruneIfNearQuota();
    expect(pruned).toBe(2); // 20% of 10

    const stored = await chrome.storage.local.get('forms');
    // The two oldest (savedAt 1000 and 1001) should be gone
    expect(stored.forms['form-0']).toBeUndefined();
    expect(stored.forms['form-1']).toBeUndefined();
    expect(stored.forms['form-2']).toBeDefined();
  });

  test('handles error gracefully', async () => {
    chrome.storage.local.getBytesInUse.mockRejectedValueOnce(new Error('fail'));
    const pruned = await FormVaultStorage.pruneIfNearQuota();
    expect(pruned).toBe(0);
  });
});

// ==================== getStorageInfo ====================

describe('getStorageInfo', () => {
  test('returns correct storage stats', async () => {
    chrome.storage.local.getBytesInUse.mockResolvedValueOnce(5 * 1024 * 1024);
    await chrome.storage.local.set({
      forms: { 'a': { savedAt: 1 }, 'b': { savedAt: 2 } }
    });

    const info = await FormVaultStorage.getStorageInfo();
    expect(info.bytesUsed).toBe(5 * 1024 * 1024);
    expect(info.maxBytes).toBe(10 * 1024 * 1024);
    expect(info.percentUsed).toBe(50);
    expect(info.nearQuota).toBe(false);
    expect(info.formCount).toBe(2);
  });

  test('sets nearQuota flag when at 80%+', async () => {
    chrome.storage.local.getBytesInUse.mockResolvedValueOnce(8.5 * 1024 * 1024);
    await chrome.storage.local.set({ forms: {} });

    const info = await FormVaultStorage.getStorageInfo();
    expect(info.nearQuota).toBe(true);
  });

  test('returns fallback on error', async () => {
    chrome.storage.local.getBytesInUse.mockRejectedValueOnce(new Error('fail'));
    const info = await FormVaultStorage.getStorageInfo();
    expect(info.bytesUsed).toBe(0);
    expect(info.nearQuota).toBe(false);
  });
});

// ==================== getFormCountForDomain ====================

describe('getFormCountForDomain', () => {
  beforeEach(async () => {
    await chrome.storage.local.set({
      forms: {
        'a': { url: 'https://example.com/page1', savedAt: 1000 },
        'b': { url: 'https://example.com/page2', savedAt: 2000 },
        'c': { url: 'https://other.com/page', savedAt: 3000 }
      }
    });
  });

  test('counts forms matching the domain', async () => {
    const count = await FormVaultStorage.getFormCountForDomain('example.com');
    expect(count).toBe(2);
  });

  test('returns 0 for domain with no forms', async () => {
    const count = await FormVaultStorage.getFormCountForDomain('unknown.com');
    expect(count).toBe(0);
  });

  test('skips forms with invalid URLs', async () => {
    await chrome.storage.local.set({
      forms: {
        'good': { url: 'https://example.com', savedAt: 1000 },
        'bad': { url: 'not-a-url', savedAt: 2000 }
      }
    });

    const count = await FormVaultStorage.getFormCountForDomain('example.com');
    expect(count).toBe(1);
  });
});

// ==================== getSettings / saveSettings ====================

describe('getSettings', () => {
  test('returns default settings when none saved', async () => {
    const settings = await FormVaultStorage.getSettings();
    expect(settings).toEqual({
      autoSaveEnabled: true,
      showRestoreToast: true,
      blocklist: '',
      retentionDays: 30
    });
  });

  test('merges saved settings with defaults', async () => {
    await chrome.storage.local.set({ settings: { retentionDays: 90 } });
    const settings = await FormVaultStorage.getSettings();
    expect(settings.retentionDays).toBe(90);
    expect(settings.autoSaveEnabled).toBe(true); // default preserved
  });

  test('returns defaults on error', async () => {
    chrome.storage.local.get.mockRejectedValueOnce(new Error('fail'));
    const settings = await FormVaultStorage.getSettings();
    expect(settings.autoSaveEnabled).toBe(true);
  });
});

describe('saveSettings', () => {
  test('merges new settings with existing', async () => {
    await chrome.storage.local.set({ settings: { retentionDays: 7 } });
    await FormVaultStorage.saveSettings({ autoSaveEnabled: false });

    const stored = await chrome.storage.local.get('settings');
    expect(stored.settings.autoSaveEnabled).toBe(false);
    expect(stored.settings.retentionDays).toBe(7);
  });

  test('handles error gracefully', async () => {
    // First get succeeds, then set fails
    chrome.storage.local.set.mockRejectedValueOnce(new Error('fail'));
    await FormVaultStorage.saveSettings({ retentionDays: 90 });
    // Should not throw
  });
});

// ==================== isDomainBlocklisted ====================

describe('isDomainBlocklisted', () => {
  test('returns true for exact match', async () => {
    await chrome.storage.local.set({ settings: { blocklist: 'example.com' } });
    const result = await FormVaultStorage.isDomainBlocklisted('example.com');
    expect(result).toBe(true);
  });

  test('returns true for subdomain match', async () => {
    await chrome.storage.local.set({ settings: { blocklist: 'example.com' } });
    const result = await FormVaultStorage.isDomainBlocklisted('sub.example.com');
    expect(result).toBe(true);
  });

  test('returns false for non-matching domain', async () => {
    await chrome.storage.local.set({ settings: { blocklist: 'example.com' } });
    const result = await FormVaultStorage.isDomainBlocklisted('other.com');
    expect(result).toBe(false);
  });

  test('returns false when blocklist is empty', async () => {
    await chrome.storage.local.set({ settings: { blocklist: '' } });
    const result = await FormVaultStorage.isDomainBlocklisted('example.com');
    expect(result).toBe(false);
  });

  test('is case-insensitive', async () => {
    await chrome.storage.local.set({ settings: { blocklist: 'Example.COM' } });
    const result = await FormVaultStorage.isDomainBlocklisted('example.com');
    expect(result).toBe(true);
  });

  test('handles multiple domains in blocklist', async () => {
    await chrome.storage.local.set({ settings: { blocklist: 'a.com, b.com, c.com' } });

    expect(await FormVaultStorage.isDomainBlocklisted('b.com')).toBe(true);
    expect(await FormVaultStorage.isDomainBlocklisted('d.com')).toBe(false);
  });

  test('does not match partial domain names', async () => {
    await chrome.storage.local.set({ settings: { blocklist: 'example.com' } });
    // "notexample.com" should NOT match "example.com"
    const result = await FormVaultStorage.isDomainBlocklisted('notexample.com');
    expect(result).toBe(false);
  });
});
