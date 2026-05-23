/**
 * FormVault — Content Script Tests
 * Tests pure functions extracted from the content script IIFE.
 */

const fs = require('fs');
const path = require('path');

const contentSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'content.js'),
  'utf-8'
);

let contentFns;

beforeAll(() => {
  // Provide stubs for globals that content.js expects
  global.FormVaultStorage = {
    getSettings: jest.fn(async () => ({
      autoSaveEnabled: true,
      showRestoreToast: true,
      blocklist: '',
      retentionDays: 30
    })),
    isDomainBlocklisted: jest.fn(async () => false),
    getForm: jest.fn(async () => null),
    saveForm: jest.fn(async () => {}),
    DEFAULT_SETTINGS: {
      autoSaveEnabled: true,
      showRestoreToast: true,
      blocklist: '',
      retentionDays: 30
    }
  };

  // Extract IIFE body by slicing between the opening arrow and closing call
  const openIdx = contentSource.indexOf('(() => {');
  const closeIdx = contentSource.lastIndexOf('})();');

  // Get everything between `(() => {` and `})();`
  let body = contentSource.substring(openIdx + '(() => {'.length, closeIdx);

  // Remove 'use strict'
  body = body.replace(/'use strict';/, '');

  // Remove the init block at the bottom that auto-runs
  const initBlockIdx = body.lastIndexOf('if (document.readyState');
  if (initBlockIdx !== -1) {
    body = body.substring(0, initBlockIdx);
  }

  // Execute and collect testable functions
  const wrapper = new Function(
    body + '\n' +
    'return { generatePageKey, isSensitiveField, getUniqueSelector, getXPath, ' +
    'getFieldLabel, getFieldValue, isValidFaviconUrl, findFormFields, ' +
    'isTrackableField, timeAgo, collectFormData };'
  );

  contentFns = wrapper();
});

// ==================== generatePageKey ====================

describe('generatePageKey', () => {
  function setLocation(url) {
    delete window.location;
    window.location = new URL(url);
  }

  afterEach(() => {
    delete window.location;
    window.location = new URL('about:blank');
  });

  test('returns origin + pathname for URL with no params', () => {
    setLocation('https://example.com/form');
    expect(contentFns.generatePageKey()).toBe('https://example.com/form');
  });

  test('strips UTM tracking parameters', () => {
    setLocation('https://example.com/page?name=test&utm_source=google&utm_medium=cpc');
    expect(contentFns.generatePageKey()).toBe('https://example.com/page?name=test');
  });

  test('strips fbclid and gclid', () => {
    setLocation('https://example.com/page?q=search&fbclid=abc123&gclid=xyz789');
    expect(contentFns.generatePageKey()).toBe('https://example.com/page?q=search');
  });

  test('keeps non-tracking query parameters', () => {
    setLocation('https://example.com/form?step=2&id=abc');
    const key = contentFns.generatePageKey();
    expect(key).toContain('step=2');
    expect(key).toContain('id=abc');
  });

  test('sorts remaining params for stable keys', () => {
    setLocation('https://example.com/form?z=1&a=2');
    const key = contentFns.generatePageKey();
    expect(key).toBe('https://example.com/form?a=2&z=1');
  });

  test('omits query string when all params are stripped', () => {
    setLocation('https://example.com/page?utm_source=x&utm_medium=y');
    expect(contentFns.generatePageKey()).toBe('https://example.com/page');
  });
});

// ==================== isSensitiveField ====================

describe('isSensitiveField', () => {
  function makeInput(attrs = {}) {
    const el = document.createElement('input');
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'type') {
        el.type = value;
      } else {
        el.setAttribute(key, value);
      }
    });
    return el;
  }

  test('detects password type', () => {
    expect(contentFns.isSensitiveField(makeInput({ type: 'password' }))).toBe(true);
  });

  test('detects hidden type', () => {
    expect(contentFns.isSensitiveField(makeInput({ type: 'hidden' }))).toBe(true);
  });

  test('detects credit card autocomplete', () => {
    expect(contentFns.isSensitiveField(makeInput({ autocomplete: 'cc-number' }))).toBe(true);
    expect(contentFns.isSensitiveField(makeInput({ autocomplete: 'cc-csc' }))).toBe(true);
  });

  test('detects password autocomplete', () => {
    expect(contentFns.isSensitiveField(makeInput({ autocomplete: 'new-password' }))).toBe(true);
    expect(contentFns.isSensitiveField(makeInput({ autocomplete: 'current-password' }))).toBe(true);
  });

  test('detects SSN-related name patterns', () => {
    expect(contentFns.isSensitiveField(makeInput({ name: 'ssn' }))).toBe(true);
    expect(contentFns.isSensitiveField(makeInput({ name: 'social_security' }))).toBe(true);
  });

  test('detects credit card name patterns', () => {
    expect(contentFns.isSensitiveField(makeInput({ name: 'cc_num' }))).toBe(true);
    expect(contentFns.isSensitiveField(makeInput({ name: 'card-number' }))).toBe(true);
    expect(contentFns.isSensitiveField(makeInput({ name: 'cvv' }))).toBe(true);
  });

  test('detects sensitive placeholder', () => {
    expect(contentFns.isSensitiveField(makeInput({ placeholder: 'Enter your password' }))).toBe(true);
  });

  test('detects sensitive aria-label', () => {
    expect(contentFns.isSensitiveField(makeInput({ 'aria-label': 'Account Number' }))).toBe(true);
  });

  test('passes normal text input', () => {
    expect(contentFns.isSensitiveField(makeInput({ type: 'text', name: 'username' }))).toBe(false);
  });

  test('passes email input', () => {
    expect(contentFns.isSensitiveField(makeInput({ type: 'email', name: 'email' }))).toBe(false);
  });
});

// ==================== getUniqueSelector ====================

describe('getUniqueSelector', () => {
  test('uses id when available', () => {
    const el = document.createElement('input');
    el.id = 'my-field';
    document.body.appendChild(el);

    expect(contentFns.getUniqueSelector(el)).toBe('#my-field');
    el.remove();
  });

  test('uses name when unique', () => {
    const el = document.createElement('input');
    el.name = 'unique-name';
    document.body.appendChild(el);

    const selector = contentFns.getUniqueSelector(el);
    expect(selector).toContain('unique-name');
    el.remove();
  });

  test('builds path-based selector for elements without id or unique name', () => {
    const container = document.createElement('div');
    const el1 = document.createElement('input');
    const el2 = document.createElement('input');
    container.appendChild(el1);
    container.appendChild(el2);
    document.body.appendChild(container);

    const selector = contentFns.getUniqueSelector(el2);
    expect(selector).toContain('input');
    expect(selector).toContain(':nth-of-type');

    container.remove();
  });
});

// ==================== getXPath ====================

describe('getXPath', () => {
  test('returns valid XPath for simple element', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);

    const xpath = contentFns.getXPath(el);
    expect(xpath).toMatch(/^\/html\[1\]\/body\[1\]\/input\[\d+\]$/);
    el.remove();
  });

  test('returns XPath with correct sibling index', () => {
    const container = document.createElement('div');
    const p1 = document.createElement('p');
    const p2 = document.createElement('p');
    container.appendChild(p1);
    container.appendChild(p2);
    document.body.appendChild(container);

    const xpath = contentFns.getXPath(p2);
    expect(xpath).toContain('p[2]');

    container.remove();
  });
});

// ==================== getFieldLabel ====================

describe('getFieldLabel', () => {
  test('finds label via for attribute', () => {
    const label = document.createElement('label');
    label.setAttribute('for', 'test-input');
    label.textContent = 'Full Name';
    const input = document.createElement('input');
    input.id = 'test-input';

    document.body.appendChild(label);
    document.body.appendChild(input);

    expect(contentFns.getFieldLabel(input)).toBe('Full Name');

    label.remove();
    input.remove();
  });

  test('finds wrapping label', () => {
    const label = document.createElement('label');
    label.textContent = 'Email Address';
    const input = document.createElement('input');
    label.appendChild(input);
    document.body.appendChild(label);

    const result = contentFns.getFieldLabel(input);
    expect(result).toContain('Email');

    label.remove();
  });

  test('uses aria-label', () => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Search query');
    document.body.appendChild(input);

    expect(contentFns.getFieldLabel(input)).toBe('Search query');
    input.remove();
  });

  test('uses aria-labelledby', () => {
    const labelEl = document.createElement('span');
    labelEl.id = 'my-label';
    labelEl.textContent = 'Phone Number';
    const input = document.createElement('input');
    input.setAttribute('aria-labelledby', 'my-label');

    document.body.appendChild(labelEl);
    document.body.appendChild(input);

    expect(contentFns.getFieldLabel(input)).toBe('Phone Number');

    labelEl.remove();
    input.remove();
  });

  test('uses placeholder as fallback', () => {
    const input = document.createElement('input');
    input.placeholder = 'Enter your name';
    document.body.appendChild(input);

    expect(contentFns.getFieldLabel(input)).toBe('Enter your name');
    input.remove();
  });

  test('prettifies name attribute as last resort', () => {
    const input = document.createElement('input');
    input.name = 'first_name';
    document.body.appendChild(input);

    expect(contentFns.getFieldLabel(input)).toBe('first name');
    input.remove();
  });

  test('falls back to type when nothing else is available', () => {
    const input = document.createElement('input');
    input.type = 'email';
    document.body.appendChild(input);

    expect(contentFns.getFieldLabel(input)).toBe('email');
    input.remove();
  });
});

// ==================== getFieldValue ====================

describe('getFieldValue', () => {
  test('returns input value', () => {
    const input = document.createElement('input');
    input.value = 'hello';
    expect(contentFns.getFieldValue(input)).toBe('hello');
  });

  test('returns textContent for contenteditable', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.textContent = 'rich text';
    expect(contentFns.getFieldValue(div)).toBe('rich text');
  });

  test('returns select value', () => {
    const select = document.createElement('select');
    const option = document.createElement('option');
    option.value = 'opt1';
    option.textContent = 'Option 1';
    select.appendChild(option);
    select.value = 'opt1';
    expect(contentFns.getFieldValue(select)).toBe('opt1');
  });

  test('returns selected values for multi-select', () => {
    const select = document.createElement('select');
    select.multiple = true;

    ['red', 'green', 'blue'].forEach((value, index) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      option.selected = index !== 1;
      select.appendChild(option);
    });

    expect(contentFns.getFieldValue(select)).toEqual(['red', 'blue']);
  });

  test('returns empty string for empty input', () => {
    const input = document.createElement('input');
    expect(contentFns.getFieldValue(input)).toBe('');
  });
});

// ==================== collectFormData ====================

describe('collectFormData', () => {
  test('saves single-select dropdown fields', () => {
    const label = document.createElement('label');
    label.setAttribute('for', 'country');
    label.textContent = 'Country';

    const select = document.createElement('select');
    select.id = 'country';
    select.name = 'country';

    const option = document.createElement('option');
    option.value = 'ca';
    option.textContent = 'Canada';
    select.appendChild(option);
    select.value = 'ca';

    document.body.appendChild(label);
    document.body.appendChild(select);

    const fields = contentFns.collectFormData();

    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'country',
        label: 'Country',
        type: 'select',
        value: 'ca'
      })
    ]));

    label.remove();
    select.remove();
  });

  test('saves multi-select dropdown fields', () => {
    const select = document.createElement('select');
    select.name = 'colors';
    select.multiple = true;

    ['red', 'green', 'blue'].forEach((value, index) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      option.selected = index !== 1;
      select.appendChild(option);
    });

    document.body.appendChild(select);

    const fields = contentFns.collectFormData();

    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'colors',
        type: 'select',
        value: ['red', 'blue']
      })
    ]));

    select.remove();
  });
});

// ==================== isValidFaviconUrl ====================

describe('isValidFaviconUrl', () => {
  test('accepts https URL', () => {
    expect(contentFns.isValidFaviconUrl('https://example.com/favicon.ico')).toBe(true);
  });

  test('accepts http URL', () => {
    expect(contentFns.isValidFaviconUrl('http://example.com/favicon.ico')).toBe(true);
  });

  test('rejects data: URL', () => {
    expect(contentFns.isValidFaviconUrl('data:image/png;base64,abc')).toBe(false);
  });

  test('rejects javascript: URL', () => {
    expect(contentFns.isValidFaviconUrl('javascript:alert(1)')).toBe(false);
  });

  test('rejects invalid URL', () => {
    expect(contentFns.isValidFaviconUrl('not a url')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(contentFns.isValidFaviconUrl('')).toBe(false);
  });
});

// ==================== isTrackableField ====================

describe('isTrackableField', () => {
  test('tracks text input', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(contentFns.isTrackableField(input)).toBe(true);
  });

  test('tracks email input', () => {
    const input = document.createElement('input');
    input.type = 'email';
    expect(contentFns.isTrackableField(input)).toBe(true);
  });

  test('does not track checkbox input', () => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    expect(contentFns.isTrackableField(input)).toBe(false);
  });

  test('does not track password input (sensitive)', () => {
    const input = document.createElement('input');
    input.type = 'password';
    expect(contentFns.isTrackableField(input)).toBe(false);
  });

  test('tracks textarea', () => {
    const el = document.createElement('textarea');
    expect(contentFns.isTrackableField(el)).toBe(true);
  });

  test('tracks select', () => {
    const el = document.createElement('select');
    expect(contentFns.isTrackableField(el)).toBe(true);
  });

  test('tracks contenteditable div', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    expect(contentFns.isTrackableField(div)).toBe(true);
  });

  test('does not track contenteditable body', () => {
    // Create a fake body-tagged element
    const body = document.createElement('body');
    body.setAttribute('contenteditable', 'true');
    // Note: body.tagName === 'BODY'
    expect(contentFns.isTrackableField(body)).toBe(false);
  });

  test('does not track non-form elements', () => {
    const div = document.createElement('div');
    expect(contentFns.isTrackableField(div)).toBe(false);
  });
});

// ==================== timeAgo ====================

describe('timeAgo', () => {
  test('returns "just now" for recent timestamps', () => {
    expect(contentFns.timeAgo(Date.now() - 5000)).toBe('just now');
  });

  test('returns minutes ago', () => {
    expect(contentFns.timeAgo(Date.now() - 5 * 60 * 1000)).toBe('5 minutes ago');
  });

  test('returns singular minute', () => {
    expect(contentFns.timeAgo(Date.now() - 1 * 60 * 1000)).toBe('1 minute ago');
  });

  test('returns hours ago', () => {
    expect(contentFns.timeAgo(Date.now() - 3 * 60 * 60 * 1000)).toBe('3 hours ago');
  });

  test('returns singular hour', () => {
    expect(contentFns.timeAgo(Date.now() - 1 * 60 * 60 * 1000)).toBe('1 hour ago');
  });

  test('returns days ago', () => {
    expect(contentFns.timeAgo(Date.now() - 2 * 24 * 60 * 60 * 1000)).toBe('2 days ago');
  });

  test('returns singular day', () => {
    expect(contentFns.timeAgo(Date.now() - 1 * 24 * 60 * 60 * 1000)).toBe('1 day ago');
  });
});

// ==================== findFormFields ====================

describe('findFormFields', () => {
  test('finds text inputs', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);

    const fields = contentFns.findFormFields();
    expect(fields).toContain(input);

    input.remove();
  });

  test('excludes password inputs', () => {
    const input = document.createElement('input');
    input.type = 'password';
    document.body.appendChild(input);

    const fields = contentFns.findFormFields();
    expect(fields).not.toContain(input);

    input.remove();
  });

  test('excludes checkbox inputs', () => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    document.body.appendChild(input);

    const fields = contentFns.findFormFields();
    expect(fields).not.toContain(input);

    input.remove();
  });

  test('finds textareas', () => {
    const el = document.createElement('textarea');
    document.body.appendChild(el);

    const fields = contentFns.findFormFields();
    expect(fields).toContain(el);

    el.remove();
  });

  test('finds selects', () => {
    const el = document.createElement('select');
    document.body.appendChild(el);

    const fields = contentFns.findFormFields();
    expect(fields).toContain(el);

    el.remove();
  });

  test('finds contenteditable elements', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.appendChild(div);

    const fields = contentFns.findFormFields();
    expect(fields).toContain(div);

    div.remove();
  });
});
