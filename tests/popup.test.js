/**
 * FormVault — Popup Utility Function Tests
 */

const fs = require('fs');
const path = require('path');

const popupSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'popup.js'),
  'utf-8'
);

let popupFns;

beforeAll(() => {
  // Provide stubs for FormVaultStorage (used by popup.js)
  global.FormVaultStorage = {
    getAllForms: jest.fn(async () => ({})),
    searchForms: jest.fn(async () => ({})),
    getSettings: jest.fn(async () => ({
      autoSaveEnabled: true,
      showRestoreToast: true,
      blocklist: '',
      retentionDays: 30
    })),
    saveSettings: jest.fn(async () => {}),
    getStorageInfo: jest.fn(async () => ({
      bytesUsed: 0, maxBytes: 10485760, percentUsed: 0, nearQuota: false, formCount: 0
    })),
    deleteForm: jest.fn(async () => {}),
    deleteAllForms: jest.fn(async () => {}),
    DEFAULT_SETTINGS: {
      autoSaveEnabled: true,
      showRestoreToast: true,
      blocklist: '',
      retentionDays: 30
    }
  };

  // Build a minimal popup DOM so the IIFE's getElementById calls don't crash
  const domIds = [
    'mainView', 'settingsPanel', 'formList', 'emptyState', 'searchInput',
    'formCount', 'footer', 'storageWarning', 'settingsBtn', 'backBtn',
    'clearAllBtn', 'autoSaveToggle', 'toastToggle', 'retentionSelect',
    'blocklistInput', 'confirmOverlay', 'confirmTitle', 'confirmText',
    'confirmCancel', 'confirmAction'
  ];

  domIds.forEach(id => {
    let el;
    if (id === 'autoSaveToggle' || id === 'toastToggle') {
      el = document.createElement('input');
      el.type = 'checkbox';
    } else if (id === 'retentionSelect') {
      el = document.createElement('select');
    } else if (id === 'blocklistInput' || id === 'searchInput') {
      el = document.createElement('input');
    } else {
      el = document.createElement('div');
    }
    el.id = id;
    document.body.appendChild(el);
  });

  // Extract IIFE body by slicing between the opening arrow and closing call
  const openIdx = popupSource.indexOf('(() => {');
  const closeIdx = popupSource.lastIndexOf('})();');

  let body = popupSource.substring(openIdx + '(() => {'.length, closeIdx);

  // Remove 'use strict'
  body = body.replace(/'use strict';/, '');

  // Remove the standalone init() call at the bottom
  const lastInitIdx = body.lastIndexOf('init();');
  if (lastInitIdx !== -1) {
    body = body.substring(0, lastInitIdx) + body.substring(lastInitIdx + 'init();'.length);
  }

  const wrapper = new Function(
    body + '\n' +
    'return { truncate, truncateUrl, timeAgo, formatFieldValue, copyFormData, updateFormCount };'
  );

  popupFns = wrapper();
});

// ==================== truncate ====================

describe('truncate', () => {
  test('returns string unchanged when shorter than max', () => {
    expect(popupFns.truncate('hello', 10)).toBe('hello');
  });

  test('truncates with ellipsis when too long', () => {
    expect(popupFns.truncate('hello world this is long', 10)).toBe('hello worl...');
  });

  test('returns empty string for null input', () => {
    expect(popupFns.truncate(null, 10)).toBe('');
  });

  test('returns empty string for empty string input', () => {
    expect(popupFns.truncate('', 10)).toBe('');
  });

  test('returns exact length string unchanged', () => {
    expect(popupFns.truncate('12345', 5)).toBe('12345');
  });
});

// ==================== truncateUrl ====================

describe('truncateUrl', () => {
  test('extracts hostname and path from full URL', () => {
    const result = popupFns.truncateUrl('https://example.com/path/to/page');
    expect(result).toContain('example.com');
    expect(result).toContain('/path');
  });

  test('omits trailing slash for root path', () => {
    const result = popupFns.truncateUrl('https://example.com/');
    expect(result).toBe('example.com');
  });

  test('falls back to truncated string for invalid URL', () => {
    const result = popupFns.truncateUrl('not-a-url');
    expect(result).toBe('not-a-url');
  });

  test('truncates long paths', () => {
    const longPath = '/a/really/long/path/that/goes/on/and/on/and/on/forever';
    const result = popupFns.truncateUrl('https://example.com' + longPath);
    expect(result.length).toBeLessThan(('example.com' + longPath).length);
  });
});

// ==================== timeAgo ====================

describe('timeAgo', () => {
  test('returns "unknown" for null timestamp', () => {
    expect(popupFns.timeAgo(null)).toBe('unknown');
  });

  test('returns "unknown" for undefined timestamp', () => {
    expect(popupFns.timeAgo(undefined)).toBe('unknown');
  });

  test('returns "just now" for recent timestamp', () => {
    expect(popupFns.timeAgo(Date.now() - 5000)).toBe('just now');
  });

  test('returns minutes ago', () => {
    expect(popupFns.timeAgo(Date.now() - 5 * 60 * 1000)).toBe('5 mins ago');
  });

  test('returns singular minute', () => {
    expect(popupFns.timeAgo(Date.now() - 60 * 1000)).toBe('1 min ago');
  });

  test('returns hours ago', () => {
    expect(popupFns.timeAgo(Date.now() - 3 * 60 * 60 * 1000)).toBe('3 hrs ago');
  });

  test('returns singular hour', () => {
    expect(popupFns.timeAgo(Date.now() - 60 * 60 * 1000)).toBe('1 hr ago');
  });

  test('returns days ago', () => {
    expect(popupFns.timeAgo(Date.now() - 2 * 24 * 60 * 60 * 1000)).toBe('2 days ago');
  });

  test('returns singular day', () => {
    expect(popupFns.timeAgo(Date.now() - 24 * 60 * 60 * 1000)).toBe('1 day ago');
  });
});

// ==================== formatFieldValue ====================

describe('formatFieldValue', () => {
  test('returns strings unchanged', () => {
    expect(popupFns.formatFieldValue('Alice')).toBe('Alice');
  });

  test('joins array values', () => {
    expect(popupFns.formatFieldValue(['red', 'blue'])).toBe('red, blue');
  });

  test('formats checkbox values', () => {
    expect(popupFns.formatFieldValue(true)).toBe('Checked');
    expect(popupFns.formatFieldValue(false)).toBe('Unchecked');
  });

  test('returns empty string for null values', () => {
    expect(popupFns.formatFieldValue(null)).toBe('');
  });
});

// ==================== copyFormData ====================

describe('copyFormData', () => {
  // Mock navigator.clipboard
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn(async () => {}) },
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      writable: true,
      configurable: true
    });
  });

  test('returns true on successful copy', async () => {
    const form = {
      title: 'Test Form',
      url: 'https://example.com',
      fields: [{ label: 'Name', value: 'Alice' }]
    };
    const result = await popupFns.copyFormData(form);
    expect(result).toBe(true);
  });

  test('formats copy text with title, URL, and fields', async () => {
    const form = {
      title: 'Test Form',
      url: 'https://example.com',
      fields: [
        { label: 'Name', value: 'Alice' },
        { label: 'Email', value: 'alice@test.com' }
      ]
    };
    await popupFns.copyFormData(form);

    const written = navigator.clipboard.writeText.mock.calls[0][0];
    expect(written).toContain('Test Form');
    expect(written).toContain('https://example.com');
    expect(written).toContain('Name: Alice');
    expect(written).toContain('Email: alice@test.com');
  });

  test('formats multi-select values when copying', async () => {
    const form = {
      title: 'Preferences',
      url: 'https://example.com',
      fields: [{ label: 'Colors', value: ['red', 'blue'] }]
    };
    await popupFns.copyFormData(form);

    const written = navigator.clipboard.writeText.mock.calls[0][0];
    expect(written).toContain('Colors: red, blue');
  });

  test('returns false when fields are empty', async () => {
    const form = { title: 'Empty', url: '', fields: [] };
    const result = await popupFns.copyFormData(form);
    expect(result).toBe(false);
  });

  test('returns false when fields are missing', async () => {
    const form = { title: 'No Fields', url: '' };
    const result = await popupFns.copyFormData(form);
    expect(result).toBe(false);
  });

  test('returns false on clipboard error', async () => {
    navigator.clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    const form = {
      title: 'Test',
      url: 'https://example.com',
      fields: [{ label: 'Name', value: 'Test' }]
    };
    const result = await popupFns.copyFormData(form);
    expect(result).toBe(false);
  });
});

// ==================== updateFormCount ====================

describe('updateFormCount', () => {
  test('shows plural form count', () => {
    document.getElementById('searchInput').value = '';
    popupFns.updateFormCount(5);
    expect(document.getElementById('formCount').textContent).toBe('5 forms saved');
  });

  test('shows singular form count', () => {
    document.getElementById('searchInput').value = '';
    popupFns.updateFormCount(1);
    expect(document.getElementById('formCount').textContent).toBe('1 form saved');
  });

  test('shows result count when searching', () => {
    document.getElementById('searchInput').value = 'test query';
    popupFns.updateFormCount(3);
    expect(document.getElementById('formCount').textContent).toBe('3 results');
  });

  test('shows singular result when searching', () => {
    document.getElementById('searchInput').value = 'test';
    popupFns.updateFormCount(1);
    expect(document.getElementById('formCount').textContent).toBe('1 result');
  });
});
