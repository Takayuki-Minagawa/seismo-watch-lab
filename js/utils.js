/**
 * utils.js - 依存を持たない共通ユーティリティ
 */
const AppUtils = (() => {
  const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPE_MAP[char]);
  }

  function sanitizeHttpUrl(value, baseUrl = 'https://example.invalid/') {
    if (!value) return '';

    try {
      const url = new URL(String(value), baseUrl);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function sanitizeUrlForOrigins(value, allowedOrigins, baseUrl = 'https://example.invalid/') {
    const sanitized = sanitizeHttpUrl(value, baseUrl);
    if (!sanitized || !Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return '';
    const origin = new URL(sanitized).origin;
    return allowedOrigins.includes(origin) ? sanitized : '';
  }

  function maxAbs(values) {
    let max = 0;
    for (const value of values || []) {
      const absolute = Math.abs(value);
      if (Number.isFinite(absolute) && absolute > max) max = absolute;
    }
    return max;
  }

  function snapSampleRatio(value) {
    const nearestInteger = Math.round(value);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 16;
    return Math.abs(value - nearestInteger) <= tolerance ? nearestInteger : value;
  }

  function sampleIndexAtOrAfter(seconds, dt) {
    if (!Number.isFinite(seconds) || !Number.isFinite(dt) || dt <= 0) {
      throw new RangeError('時刻とサンプリング間隔は有限値で、間隔は正にしてください');
    }
    return Math.ceil(snapSampleRatio(seconds / dt));
  }

  function sampleIndexAtOrBefore(seconds, dt) {
    if (!Number.isFinite(seconds) || !Number.isFinite(dt) || dt <= 0) {
      throw new RangeError('時刻とサンプリング間隔は有限値で、間隔は正にしてください');
    }
    return Math.floor(snapSampleRatio(seconds / dt));
  }

  function escapeCsvCell(value) {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && /^[\t\r ]*[=+\-@]/.test(text)) {
      text = `'${text}`;
    }
    return `"${text.replace(/"/g, '""')}"`;
  }

  function formatLocalDate(date) {
    if (!date || typeof date.getTime !== 'function' || Number.isNaN(date.getTime())) {
      throw new TypeError('有効なDateを指定してください');
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function createRequestCoordinator() {
    let sequence = 0;
    let controller = null;

    return {
      begin() {
        if (controller) controller.abort();
        controller = new AbortController();
        const id = ++sequence;
        return {
          id,
          signal: controller.signal,
          isCurrent: () => id === sequence,
        };
      },
      finish(id) {
        if (id === sequence) controller = null;
      },
      cancel() {
        sequence += 1;
        if (controller) controller.abort();
        controller = null;
      },
      isCurrent(id) {
        return id === sequence;
      },
    };
  }

  async function fetchWithTimeout(resource, options = {}, consumeResponse = null) {
    const {
      signal: externalSignal,
      timeoutMs = 20000,
      timeoutMessage = '通信がタイムアウトしました',
      ...fetchOptions
    } = options;
    const controller = new AbortController();
    let timedOut = false;

    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
      abortFromExternal();
    } else if (externalSignal) {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

    try {
      const response = await fetch(resource, { ...fetchOptions, signal: controller.signal });
      if (!consumeResponse) return response;
      const body = await consumeResponse(response);
      return { response, body };
    } catch (error) {
      if (timedOut) throw new Error(timeoutMessage);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }

  async function fetchTextWithTimeout(resource, options = {}) {
    const result = await fetchWithTimeout(resource, options, response => response.text());
    return { response: result.response, text: result.body };
  }

  async function fetchJsonWithTimeout(resource, options = {}) {
    const result = await fetchWithTimeout(resource, options, response => response.json());
    return { response: result.response, data: result.body };
  }

  function isAbortError(error) {
    return error?.name === 'AbortError';
  }

  return Object.freeze({
    escapeHtml,
    sanitizeHttpUrl,
    sanitizeUrlForOrigins,
    maxAbs,
    sampleIndexAtOrAfter,
    sampleIndexAtOrBefore,
    escapeCsvCell,
    formatLocalDate,
    createRequestCoordinator,
    fetchWithTimeout,
    fetchTextWithTimeout,
    fetchJsonWithTimeout,
    isAbortError,
  });
})();
