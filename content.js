/**
 * FormVault — Content Script
 * Injected into all pages. Handles form detection, auto-save, and restore toast.
 * Uses Shadow DOM for all injected UI to prevent style conflicts.
 */

(() => {
  'use strict';

  // ==================== CONFIGURATION ====================

  const DEBOUNCE_MS = 3000;
  const TOAST_AUTO_DISMISS_MS = 15000;
  const MIN_FIELD_LENGTH = 1;

  // Input types to track
  const TRACKED_INPUT_TYPES = new Set([
    'text', 'email', 'tel', 'number', 'url', 'search',
    'date', 'datetime-local', 'month', 'week', 'time'
  ]);
  const TRACKED_CUSTOM_ELEMENTS = new Set([
    'lightning-combobox'
  ]);

  // Sensitive field patterns — never save these
  const SENSITIVE_PATTERNS = /password|passwd|pwd|ssn|social.?security|cc[-_]?num|card[-_]?number|cvv|cvc|ccv|credit.?card|expir|routing.?number|account.?number|pin[-_]?code/i;
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
    'cc-csc', 'cc-name', 'cc-type', 'cc-given-name',
    'cc-additional-name', 'cc-family-name',
    'new-password', 'current-password'
  ]);

  // Volatile query params to strip from page keys (tracking / analytics)
  const STRIP_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'fbclid', 'gclid', 'gclsrc', 'msclkid', 'dclid',
    '_ga', '_gl', '_hsenc', '_hsmi', 'mc_cid', 'mc_eid',
    'ref', 'source', 'trk', 'trkCampaign',
    '__cf_chl_jschl_tk__', '__cf_chl_tk'
  ]);

  const frameId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(36).slice(2);

  // CSS.escape polyfill for older environments
  const cssEscape = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape.bind(CSS)
    : (str) => String(str).replace(/([^\w-])/g, '\\$1');

  // ==================== PAGE KEY GENERATION ====================

  /**
   * Generate a stable page key from the current URL.
   * Keeps all query params except known volatile ones (tracking, analytics).
   */
  function generatePageKey() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams();

    for (const [key, value] of url.searchParams) {
      if (!STRIP_PARAMS.has(key)) {
        params.set(key, value);
      }
    }

    params.sort();
    const paramStr = params.toString();
    return url.origin + url.pathname + (paramStr ? '?' + paramStr : '');
  }

  function generateTopPageKey() {
    try {
      if (window.top !== window && document.referrer) {
        const referrer = new URL(document.referrer);
        const current = new URL(window.location.href);
        const params = new URLSearchParams(referrer.search);
        const currentParams = new URLSearchParams(current.search);

        for (const [key, value] of currentParams) {
          if (!params.has(key)) {
            params.set(key, value);
          }
        }

        const strippedParams = new URLSearchParams();
        for (const [key, value] of params) {
          if (!STRIP_PARAMS.has(key)) {
            strippedParams.set(key, value);
          }
        }
        strippedParams.sort();
        const paramStr = strippedParams.toString();
        return referrer.origin + referrer.pathname + (paramStr ? '?' + paramStr : '');
      }
    } catch (e) {
      // Fall back to the current frame URL when parent/referrer access fails.
    }

    return generatePageKey();
  }

  // ==================== FIELD DETECTION & IDENTIFICATION ====================

  /**
   * Check if a field is sensitive and should not be saved.
   * Tests each identifier independently to avoid false positives.
   */
  function isSensitiveField(el) {
    const type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;

    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (SENSITIVE_AUTOCOMPLETE.has(autocomplete)) return true;

    const identifiers = [
      el.id, el.name, el.getAttribute('autocomplete'),
      el.getAttribute('aria-label'), el.placeholder
    ].filter(Boolean);

    return identifiers.some(id => SENSITIVE_PATTERNS.test(id));
  }

  function isTrackedCustomElement(el) {
    return TRACKED_CUSTOM_ELEMENTS.has(el.tagName.toLowerCase());
  }

  function getComposedParent(el) {
    const root = el.getRootNode && el.getRootNode();
    return el.parentElement || (root instanceof ShadowRoot ? root.host : null);
  }

  /**
   * Generate a unique CSS selector for an element
   */
  function getUniqueSelector(el) {
    if (el.id) return `#${cssEscape(el.id)}`;

    const tag = el.tagName.toLowerCase();
    const name = el.name || el.getAttribute('name');
    if (name) {
      const selector = `${tag}[name="${cssEscape(name)}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }

    // Build path-based selector
    const parts = [];
    let current = el;
    let depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < 20) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${cssEscape(current.id)}`);
        break;
      }
      const parent = getComposedParent(current);
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(selector);
      current = getComposedParent(current);
      depth++;
    }
    return parts.join(' > ');
  }

  /**
   * Generate an XPath for an element (last resort identifier)
   */
  function getXPath(el) {
    if (el.getRootNode && el.getRootNode() instanceof ShadowRoot) return '';

    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      const tag = current.tagName.toLowerCase();
      parts.unshift(`${tag}[${index}]`);
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  /**
   * Extract human-readable label for a field
   */
  function getFieldLabel(el) {
    if (isTrackedCustomElement(el)) {
      return typeof el.label === 'string' ? el.label : (el.getAttribute('label') || '');
    }

    // Check associated <label>
    if (el.id) {
      const label = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // Check wrapping <label>
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const text = parentLabel.textContent.trim();
      const fieldValue = el.value || '';
      return text.replace(fieldValue, '').trim() || text;
    }

    // Check aria-label
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');

    // Check aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.trim();
    }

    // Check placeholder
    if (el.placeholder) return el.placeholder;

    if (el.label) return el.label;

    // Fall back to name attribute, prettified
    if (el.name) {
      return el.name
        .replace(/[_\-\[\]]/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .trim();
    }

    return el.type || 'field';
  }

  /**
   * Get the value of a form field
   */
  function getFieldValue(el) {
    if (el.getAttribute('contenteditable') === 'true') {
      return el.textContent || '';
    }
    if (isTrackedCustomElement(el)) {
      const value = el.value;
      return typeof value === 'string' ? value : '';
    }
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      return Boolean(el.checked);
    }
    if (el.tagName === 'SELECT') {
      if (el.multiple) {
        return Array.from(el.selectedOptions).map(option => option.value);
      }
      return el.value;
    }
    return el.value || '';
  }

  function getLightningComboboxDisplayText(el) {
    if (!isTrackedCustomElement(el) || !el.shadowRoot) {
      return '';
    }

    const baseCombobox = el.shadowRoot.querySelector('lightning-base-combobox');
    if (!baseCombobox || !baseCombobox.shadowRoot) return '';

    const valueEl = baseCombobox.shadowRoot.querySelector('[part="input-button-value"]');
    return valueEl ? valueEl.textContent.trim() : '';
  }

  function hasSavableValue(value) {
    if (typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.length >= MIN_FIELD_LENGTH;
    return value.length >= MIN_FIELD_LENGTH;
  }

  function walkElements(root, callback) {
    root.querySelectorAll('*').forEach(el => {
      callback(el);
      if (el.shadowRoot) {
        walkElements(el.shadowRoot, callback);
      }
    });
  }

  /**
   * Validate that a favicon URL uses a safe protocol
   */
  function isValidFaviconUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  /**
   * Find all trackable form fields on the page
   */
  function findFormFields() {
    const fields = [];

    walkElements(document, el => {
      if (el.tagName === 'INPUT') {
        const type = (el.type || 'text').toLowerCase();
        if (type !== 'checkbox' && !TRACKED_INPUT_TYPES.has(type)) return;
        if (isSensitiveField(el)) return;
        fields.push(el);
      } else if (el.tagName === 'TEXTAREA') {
        if (isSensitiveField(el)) return;
        fields.push(el);
      } else if (el.tagName === 'SELECT') {
        if (isSensitiveField(el)) return;
        fields.push(el);
      } else if (el.getAttribute('contenteditable') === 'true') {
        if (el.tagName === 'BODY') return;
        fields.push(el);
      } else if (isTrackedCustomElement(el)) {
        if (isSensitiveField(el)) return;
        fields.push(el);
      }
    });

    return fields;
  }

  // ==================== AUTO-SAVE LOGIC ====================

  let debounceTimer = null;
  let isInitialized = false;
  let settings = null;
  let mutationObserver = null;

  /**
   * Collect all form data from the current page
   */
  function collectFormData() {
    const fields = findFormFields();
    const fieldData = [];

    fields.forEach(el => {
      const value = getFieldValue(el);
      if (!hasSavableValue(value)) return;

      fieldData.push({
        selector: getUniqueSelector(el),
        xpath: getXPath(el),
        name: el.name || el.getAttribute('name') || el.id || '',
        label: getFieldLabel(el),
        type: el.getAttribute('contenteditable') === 'true'
          ? 'contenteditable'
          : isTrackedCustomElement(el)
            ? el.tagName.toLowerCase()
          : el.tagName.toLowerCase() === 'select'
            ? 'select'
            : (el.type || 'text'),
        value: value,
        displayValue: isTrackedCustomElement(el) ? getLightningComboboxDisplayText(el) : ''
      });
    });

    return fieldData;
  }

  /**
   * Save current form data to storage
   */
  async function saveCurrentForms() {
    if (settings && !settings.autoSaveEnabled) return;

    const fields = collectFormData();
    if (fields.length === 0) return;

    const pageKey = generateTopPageKey();

    // Try to get favicon (validated)
    let favicon = '';
    const faviconLink = document.querySelector('link[rel*="icon"]');
    if (faviconLink && isValidFaviconUrl(faviconLink.href)) {
      favicon = faviconLink.href;
    } else {
      const fallback = window.location.origin + '/favicon.ico';
      if (isValidFaviconUrl(fallback)) {
        favicon = fallback;
      }
    }

    const formData = {
      url: window.location.href,
      title: document.title || window.location.hostname,
      favicon: favicon,
      fields: markFrameFields(fields)
    };

    try {
      await FormVaultStorage.saveForm(pageKey, formData);

      // Notify background for badge update
      chrome.runtime.sendMessage({
        action: 'formSaved',
        domain: window.location.hostname
      }).catch(() => {
        // Background may not be ready
      });
    } catch (e) {
      console.error('FormVault: Error saving form data', e);
    }
  }

  /**
   * Debounced save — resets timer on every input
   */
  function debouncedSave() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(saveCurrentForms, DEBOUNCE_MS);
  }

  /**
   * Immediate save — flush pending debounce and save now.
   * Used on beforeunload / visibilitychange to prevent data loss.
   */
  function flushSave() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    // saveCurrentForms is async but beforeunload doesn't await promises.
    // visibilitychange fires early enough for it to complete in most cases.
    saveCurrentForms();
  }

  /**
   * Attach event listeners to a form field
   */
  function attachFieldListeners(el) {
    if (el._formvaultListening) return;
    el._formvaultListening = true;

    el.addEventListener('input', debouncedSave, { passive: true });
    el.addEventListener('change', debouncedSave, { passive: true });
    el.addEventListener('blur', debouncedSave, { passive: true });
  }

  /**
   * Scan page and attach listeners to all form fields
   */
  function scanAndAttach() {
    const fields = findFormFields();
    fields.forEach(attachFieldListeners);
  }

  function querySelectorDeep(selector) {
    let found = null;

    function search(root) {
      try {
        found = root.querySelector(selector);
      } catch (e) {
        return true;
      }
      if (found) return true;

      const elements = root.querySelectorAll('*');
      for (const el of elements) {
        if (el.shadowRoot && search(el.shadowRoot)) return true;
      }
      return false;
    }

    search(document);
    if (!found) {
      walkElements(document, el => {
        if (!found && getUniqueSelector(el) === selector) {
          found = el;
        }
      });
    }
    return found;
  }

  function getCustomElementValueSetter(el) {
    let current = el;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'value');
      if (descriptor?.set) return descriptor.set;
      current = Object.getPrototypeOf(current);
    }
    return null;
  }

  function getFrameIdentifier() {
    if (window.top === window) return '';
    return window.location.href;
  }

  function markFrameFields(fields) {
    const frame = getFrameIdentifier();
    return fields.map(field => ({
      ...field,
      frame
    }));
  }

  function getFrameFields(fields) {
    const frame = getFrameIdentifier();
    return fields.filter(field => (field.frame || '') === frame);
  }

  async function getSavedDataWithFrameFields(pageKey) {
    const savedData = await FormVaultStorage.getForm(pageKey);
    if (!savedData || !savedData.fields) return savedData;

    try {
      if (window.top === window && chrome.runtime && chrome.runtime.sendMessage) {
        const response = await chrome.runtime.sendMessage({
          action: 'getFrameFormFields',
          pageKey,
          frameId
        });

        if (response && Array.isArray(response.fields) && response.fields.length > 0) {
          return {
            ...savedData,
            fields: [...savedData.fields, ...response.fields]
          };
        }
      }
    } catch (e) {
      // Frames may be unavailable; restore whatever was saved in this context.
    }

    return savedData;
  }

  function findLightningOptionLabel(el, value) {
    const options = el.options || el.getAttribute('options');
    if (!Array.isArray(options)) return '';

    const match = options.find(option => String(option.value) === String(value));
    return match ? match.label || match.text || '' : '';
  }

  function restoreLightningCombobox(el, fieldData) {
    const nativeSetter = getCustomElementValueSetter(el);
    if (nativeSetter) {
      nativeSetter.call(el, fieldData.value);
    } else {
      el.value = fieldData.value;
    }

    const label = fieldData.displayValue || findLightningOptionLabel(el, fieldData.value);
    if (label && el.shadowRoot) {
      const baseCombobox = el.shadowRoot.querySelector('lightning-base-combobox');
      if (baseCombobox && baseCombobox.shadowRoot) {
        const valueEl = baseCombobox.shadowRoot.querySelector('[part="input-button-value"]');
        const inputButton = baseCombobox.shadowRoot.querySelector('[part="input-button"]');

        if (valueEl) valueEl.textContent = label;
        if (inputButton) inputButton.setAttribute('data-value', label);
      }
    }

    const changeEvent = new CustomEvent('change', {
      bubbles: true,
      composed: true,
      detail: { value: fieldData.value }
    });

    try {
      Object.defineProperty(changeEvent, 'target', { value: el });
    } catch (e) {
      // Browser-managed event target remains available during dispatch.
    }

    el.dispatchEvent(changeEvent);
  }

  // ==================== RESTORE TOAST ====================

  /**
   * Format relative time string
   */
  function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
  }

  /**
   * Restore field values from saved data
   */
  function restoreFields(fields) {
    let restored = 0;

    getFrameFields(fields).forEach(fieldData => {
      let el = null;

      // Try selector first
      try {
        el = querySelectorDeep(fieldData.selector);
      } catch (e) {
        // Invalid selector
      }

      // Try by name
      if (!el && fieldData.name) {
        el = querySelectorDeep(`[name="${cssEscape(fieldData.name)}"]`) ||
             document.getElementById(fieldData.name);
      }

      // Try XPath as last resort
      if (!el && fieldData.xpath) {
        try {
          const result = document.evaluate(
            fieldData.xpath, document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          );
          el = result.singleNodeValue;
        } catch (e) {
          // Invalid XPath
        }
      }

      if (!el) return;

      // Set value based on field type
      if (fieldData.type === 'contenteditable') {
        el.textContent = fieldData.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (fieldData.type === 'select') {
        if (el.multiple && Array.isArray(fieldData.value)) {
          Array.from(el.options).forEach(option => {
            option.selected = fieldData.value.includes(option.value);
          });
        } else {
          el.value = fieldData.value;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (fieldData.type === 'checkbox') {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;

        if (nativeSetter) {
          nativeSetter.call(el, Boolean(fieldData.value));
        } else {
          el.checked = Boolean(fieldData.value);
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (fieldData.type === 'lightning-combobox') {
        restoreLightningCombobox(el, fieldData);
      } else {
        // Use the correct native setter for React compatibility
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

        if (nativeSetter) {
          nativeSetter.call(el, fieldData.value);
        } else {
          el.value = fieldData.value;
        }

        // Dispatch events for React/SPA frameworks
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      restored++;
    });

    return restored;
  }

  async function restoreSavedDataFromMessage(savedData) {
    return restoreFields(savedData.fields || []);
  }

  /**
   * Create an SVG shield icon element for the toast
   */
  function createShieldIcon() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'shield-icon');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('fill', 'none');

    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', '16');
    circle.setAttribute('cy', '16');
    circle.setAttribute('r', '15');
    circle.setAttribute('fill', '#3b82f6');
    circle.setAttribute('opacity', '0.15');

    const path1 = document.createElementNS(svgNS, 'path');
    path1.setAttribute('d', 'M16 4L7 8.5V15C7 21.1 10.8 26.7 16 28.3C21.2 26.7 25 21.1 25 15V8.5L16 4Z');
    path1.setAttribute('fill', '#3b82f6');
    path1.setAttribute('opacity', '0.3');

    const path2 = document.createElementNS(svgNS, 'path');
    path2.setAttribute('d', 'M16 6L9 9.8V15C9 20.1 12.2 24.8 16 26.2C19.8 24.8 23 20.1 23 15V9.8L16 6Z');
    path2.setAttribute('fill', '#3b82f6');

    const check = document.createElementNS(svgNS, 'path');
    check.setAttribute('d', 'M13 16L15 18L19.5 13.5');
    check.setAttribute('stroke', 'white');
    check.setAttribute('stroke-width', '2');
    check.setAttribute('stroke-linecap', 'round');
    check.setAttribute('stroke-linejoin', 'round');

    svg.appendChild(circle);
    svg.appendChild(path1);
    svg.appendChild(path2);
    svg.appendChild(check);

    return svg;
  }

  /**
   * Create and show the restore toast using Shadow DOM
   */
  function showRestoreToast(savedData) {
    if (settings && !settings.showRestoreToast) return;

    // Prevent duplicate toasts
    const existing = document.getElementById('formvault-toast-host');
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = 'formvault-toast-host';
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      .toast {
        background: rgba(15, 15, 15, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        padding: 16px;
        max-width: 360px;
        color: #fafafa;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        transform: translateY(100px);
        opacity: 0;
        transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1),
                    opacity 0.35s ease;
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }

      .toast.visible {
        transform: translateY(0);
        opacity: 1;
      }

      .toast.hiding {
        opacity: 0;
        transform: translateY(10px);
        transition: opacity 0.3s ease, transform 0.3s ease;
      }

      .shield-icon {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
      }

      .content {
        flex: 1;
        min-width: 0;
      }

      .title {
        font-size: 14px;
        font-weight: 600;
        margin: 0 0 4px 0;
        color: #fafafa;
      }

      .subtitle {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.5);
        margin: 0 0 12px 0;
      }

      .field-count {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.6);
        margin: 0 0 12px 0;
      }

      .actions {
        display: flex;
        gap: 8px;
      }

      .btn {
        border: none;
        border-radius: 8px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s, transform 0.1s;
        font-family: inherit;
      }

      .btn:hover {
        opacity: 0.9;
      }

      .btn:active {
        transform: scale(0.97);
      }

      .btn-restore {
        background: #22c55e;
        color: #fff;
      }

      .btn-dismiss {
        background: rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.7);
      }

      .btn-dismiss:hover {
        background: rgba(255, 255, 255, 0.15);
      }

      .success-msg {
        font-size: 13px;
        color: #22c55e;
        font-weight: 500;
        padding: 4px 0;
      }
    `;

    // Build toast DOM safely
    const toast = document.createElement('div');
    toast.className = 'toast';

    const fieldCount = savedData.fields.length;
    const savedTime = timeAgo(savedData.savedAt);

    // Shield icon (SVG built via DOM API)
    const shieldIcon = createShieldIcon();

    // Content container
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';

    const titleP = document.createElement('p');
    titleP.className = 'title';
    titleP.textContent = 'Restore your saved form data?';

    const subtitleP = document.createElement('p');
    subtitleP.className = 'subtitle';
    subtitleP.textContent = 'Saved ' + savedTime;

    const fieldCountP = document.createElement('p');
    fieldCountP.className = 'field-count';
    fieldCountP.textContent = fieldCount + ' field' + (fieldCount !== 1 ? 's' : '') + ' saved';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn btn-restore';
    restoreBtn.textContent = 'Restore';

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn btn-dismiss';
    dismissBtn.textContent = 'Dismiss';

    actionsDiv.appendChild(restoreBtn);
    actionsDiv.appendChild(dismissBtn);

    contentDiv.appendChild(titleP);
    contentDiv.appendChild(subtitleP);
    contentDiv.appendChild(fieldCountP);
    contentDiv.appendChild(actionsDiv);

    toast.appendChild(shieldIcon);
    toast.appendChild(contentDiv);

    shadow.appendChild(style);
    shadow.appendChild(toast);
    document.body.appendChild(host);

    // Animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.classList.add('visible');
      });
    });

    // Auto-dismiss timer (pause on hover)
    let autoDismissTimer = setTimeout(() => dismissToast(), TOAST_AUTO_DISMISS_MS);

    toast.addEventListener('mouseenter', () => {
      clearTimeout(autoDismissTimer);
    });

    toast.addEventListener('mouseleave', () => {
      autoDismissTimer = setTimeout(() => dismissToast(), TOAST_AUTO_DISMISS_MS);
    });

    function dismissToast() {
      clearTimeout(autoDismissTimer);
      toast.classList.remove('visible');
      toast.classList.add('hiding');
      setTimeout(() => {
        host.remove();
      }, 300);
    }

    // Restore button click handler
    restoreBtn.addEventListener('click', () => {
      clearTimeout(autoDismissTimer);
      let restored = restoreFields(savedData.fields);

      if (window.top === window && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'restoreFrameForms',
          pageKey: generateTopPageKey(),
          savedData
        }).then(response => {
          if (!response || typeof response.restored !== 'number') return;
          restored += response.restored;
          successMsg.textContent = 'Restored ' + restored + ' field' +
            (restored !== 1 ? 's' : '') + ' successfully!';
        }).catch(() => {
          // Frames may be unavailable; keep the top-frame restore result.
        });
      }

      // Replace actions with success message
      while (actionsDiv.firstChild) {
        actionsDiv.removeChild(actionsDiv.firstChild);
      }
      const successMsg = document.createElement('span');
      successMsg.className = 'success-msg';
      successMsg.textContent = 'Restored ' + restored + ' field' + (restored !== 1 ? 's' : '') + ' successfully!';
      actionsDiv.appendChild(successMsg);

      setTimeout(() => dismissToast(), 2000);
    });

    // Dismiss button click handler
    dismissBtn.addEventListener('click', () => {
      dismissToast();
    });
  }

  // ==================== MUTATION OBSERVER ====================

  /**
   * Watch for dynamically added form fields (React/SPA apps).
   * Stores reference for cleanup on unload.
   */
  function setupMutationObserver() {
    if (mutationObserver) mutationObserver.disconnect();

    let pendingScan = false;
    const trackedCustomSelector = Array.from(TRACKED_CUSTOM_ELEMENTS).join(',');

    mutationObserver = new MutationObserver((mutations) => {
      if (pendingScan) return;

      let hasNewFields = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.id === 'formvault-toast-host') continue;

          if (isTrackableField(node)) {
            hasNewFields = true;
            break;
          }

          if (node.querySelectorAll) {
            const fields = node.querySelectorAll(
              `input, textarea, select, [contenteditable="true"], ${trackedCustomSelector}`
            );
            if (fields.length > 0) {
              hasNewFields = true;
              break;
            }
          }
        }
        if (hasNewFields) break;
      }

      if (hasNewFields) {
        pendingScan = true;
        requestAnimationFrame(() => {
          scanAndAttach();
          debouncedSave();
          pendingScan = false;
        });
      }
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Check if an element is a trackable form field
   */
  function isTrackableField(el) {
    if (el.tagName === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      return (type === 'checkbox' || TRACKED_INPUT_TYPES.has(type)) && !isSensitiveField(el);
    }
    if (el.tagName === 'TEXTAREA') return !isSensitiveField(el);
    if (el.tagName === 'SELECT') return !isSensitiveField(el);
    if (isTrackedCustomElement(el)) return !isSensitiveField(el);
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
      return el.tagName !== 'BODY';
    }
    return false;
  }

  // ==================== INITIALIZATION ====================

  async function init() {
    if (isInitialized) return;
    isInitialized = true;

    try {
      // Skip non-http pages where the extension can't fully operate
      const protocol = window.location.protocol;
      if (protocol !== 'http:' && protocol !== 'https:') return;

      settings = await FormVaultStorage.getSettings();

      const isBlocked = await FormVaultStorage.isDomainBlocklisted(
        window.location.hostname
      );
      if (isBlocked) return;

      scanAndAttach();

      if (document.body) {
        setupMutationObserver();
      }

      // Save immediately when user leaves or switches tabs to prevent data loss
      window.addEventListener('beforeunload', flushSave);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          flushSave();
        }
      });

      // Cleanup observer on unload
      window.addEventListener('beforeunload', () => {
        if (mutationObserver) {
          mutationObserver.disconnect();
          mutationObserver = null;
        }
      });

      // Listen for settings changes from the popup
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.settings) {
          settings = { ...FormVaultStorage.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
        }
      });

      // Check for saved data and show restore toast.
      // Uses the user's retention setting instead of a hardcoded max age.
      const pageKey = generateTopPageKey();
      const savedData = await getSavedDataWithFrameFields(pageKey);

      if (savedData && savedData.fields.length > 0) {
        const retentionDays = settings.retentionDays;
        // retentionDays === 0 means "never delete" — always show toast
        if (retentionDays === 0) {
          setTimeout(() => showRestoreToast(savedData), 1000);
        } else {
          const ageMs = Date.now() - savedData.savedAt;
          const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
          if (ageMs < maxAgeMs) {
            setTimeout(() => showRestoreToast(savedData), 1000);
          }
        }
      }
    } catch (e) {
      console.error('FormVault: Initialization error', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'collectFrameFormFields') {
      const fields = markFrameFields(collectFormData());
      sendResponse({ frameId, fields });
      return false;
    }

    if (message.action === 'restoreSavedFrameForms') {
      restoreSavedDataFromMessage(message.savedData).then(restored => {
        sendResponse({ restored });
      });
      return true;
    }

    return false;
  });
})();
