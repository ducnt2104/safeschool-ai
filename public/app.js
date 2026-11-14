(() => {
  'use strict';

  const STORAGE_MY_TICKETS = 'safeschool_my_tickets';
  const STORAGE_COUNSELOR_TOKEN = 'safeschool_counselor_token';
  const STORAGE_THEME = 'safeschool_theme';
  const STORAGE_TOUR_DONE = 'safeschool_tour_done';

  const RISK_META = {
    LOW: { label: 'An toàn / Thấp', cls: 'risk-low' },
    MEDIUM: { label: 'Cần theo dõi (Trung bình)', cls: 'risk-medium' },
    HIGH: { label: 'Rủi ro cao', cls: 'risk-high' },
    CRITICAL: { label: 'Khẩn cấp — Cần bảo vệ ngay', cls: 'risk-critical' },
  };

  const STATUS_META = {
    PENDING: { label: 'Đang chờ tiếp nhận', cls: 'status-pending' },
    IN_PROGRESS: { label: 'Đang hỗ trợ', cls: 'status-in_progress' },
    RESOLVED: { label: 'Đã giải quyết', cls: 'status-resolved' },
  };

  const GRADE_META = {
    '10': 'Khối 10',
    '11': 'Khối 11',
    '12': 'Khối 12',
    ANONYMOUS: 'Ẩn danh hoàn toàn',
  };

  const state = {
    mode: 'student',
    studentTab: 'analyzer',
    serverConfig: {
      serverKeyConfigured: false,
      model: 'gemini-3.5-flash-lite',
      isDefaultPin: true,
      demoPinHint: '11092026',
    },
    currentImageDataUrl: null,
    currentImageName: '',
    lastImageMeta: null,
    lastAnalysis: null,
    lastAnalyzeMeta: null,
    lastAnalyzedText: '',
    lastAnalyzedImage: null,
    activeTrackerCode: null,
    counselorToken: sessionStorage.getItem(STORAGE_COUNSELOR_TOKEN) || null,
    counselorFilterStatus: '',
    selectedCounselorCode: null,
    lastAnalytics: null,
    lastDashboardTickets: [],
    riskChart: null,
    categoryChart: null,
    chatPreviousInteractionId: null,
    chatHistory: [],
    analyzeAbortController: null,
    chatAbortController: null,
    breathingTimerId: null,
  };

  // ==================== PROGRESSIVE POLYFILLS & DIALOG HELPERS ====================
  function initModernWebFallbacks() {
    if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
      import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
    }

    if (!('commandForElement' in HTMLButtonElement.prototype)) {
      document.addEventListener('click', (event) => {
        const btn = event.target.closest('button[command][commandfor]');
        if (!btn) return;
        const target = document.getElementById(btn.getAttribute('commandfor'));
        if (!target || target.tagName !== 'DIALOG') return;
        const cmd = btn.getAttribute('command');
        if (cmd === 'show-modal' && !target.open) {
          target.showModal();
        } else if ((cmd === 'close' || cmd === 'request-close') && target.open) {
          target.close();
        }
      });
    }

    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const isOutside = (e, dialog) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
        let pressedOutside = false;
        dialog.addEventListener('pointerdown', (e) => {
          pressedOutside = isOutside(e, dialog);
        });
        dialog.addEventListener('pointerup', (e) => {
          if (pressedOutside && isOutside(e, dialog)) {
            dialog.close();
          }
          pressedOutside = false;
        });
      }
    }

    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.addEventListener('close', () => {
        dialog.returnValue = '';
      });
    }
  }

  function announceSR(text) {
    if (typeof document.ariaNotify === 'function') {
      document.ariaNotify(text);
      return;
    }
    const region = document.getElementById('sr-announcer');
    if (region) {
      region.textContent = '';
      window.setTimeout(() => {
        region.textContent = text;
      }, 40);
    }
  }

  function showToast(message, variant = 'default') {
    // Theo guidance: không hiện toast khi có modal dialog đang mở
    if (document.querySelector('dialog[open]')) {
      announceSR(message);
      return;
    }

    const region = document.getElementById('toast-region');
    if (!region) return;

    const toast = document.createElement('div');
    toast.className = `toast-item${variant === 'success' ? ' is-success' : variant === 'error' ? ' is-error' : ''}`;
    toast.setAttribute('popover', 'manual');

    const span = document.createElement('span');
    span.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close-btn';
    closeBtn.setAttribute('aria-label', 'Đóng thông báo');
    closeBtn.textContent = '×';

    toast.append(span, closeBtn);
    region.appendChild(toast);

    const dismiss = () => {
      if (!toast.isConnected) return;
      try {
        if (typeof toast.hidePopover === 'function') toast.hidePopover();
      } catch {
        // Bỏ qua nếu popover chưa kịp mở hoặc đang dùng polyfill
      }
      window.setTimeout(() => {
        if (toast.isConnected) toast.remove();
      }, 200);
    };

    closeBtn.addEventListener('click', dismiss);

    try {
      if (typeof toast.showPopover === 'function') {
        toast.showPopover();
      } else {
        toast.classList.add(':popover-open');
      }
    } catch {
      toast.classList.add(':popover-open');
    }

    announceSR(message);

    let timer = window.setTimeout(dismiss, 4500);
    toast.addEventListener('focusin', () => window.clearTimeout(timer));
    toast.addEventListener('focusout', () => {
      timer = window.setTimeout(dismiss, 3000);
    });
  }

  // ==================== UTILS & SAFE DOM ====================
  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function formatDateTime(isoOrSqlite) {
    if (!isoOrSqlite) return '';
    const normalized = isoOrSqlite.includes('T') ? isoOrSqlite : `${isoOrSqlite.replace(' ', 'T')}Z`;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return isoOrSqlite;
    return date.toLocaleString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }

  function setInlineAlert(el, message) {
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.textContent = message;
      el.hidden = false;
    }
  }

  function attachImeSafeEnter(textarea, form) {
    let lastCompositionEndAt = null;
    textarea.addEventListener('compositionend', (e) => {
      lastCompositionEndAt = e.timeStamp;
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (e.isComposing || e.keyCode === 229) return;
        if (lastCompositionEndAt !== null && Math.abs(e.timeStamp - lastCompositionEndAt) < 50) {
          return;
        }
        form.requestSubmit();
      }
    });
  }

  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (options.counselorAuth && state.counselorToken) {
      headers.set('Authorization', `Bearer ${state.counselorToken}`);
    }

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: 'Phản hồi máy chủ không hợp lệ.' };
    }

    if (!res.ok) {
      const err = new Error(data.error || `Lỗi máy chủ (${res.status})`);
      err.status = res.status;
      err.code = data.code || 'API_ERROR';
      throw err;
    }
    return data;
  }

  function formatByteSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function streamSseRequest(url, payload, onEvent, signal) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload || {}),
      signal,
    });

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
      let data = { error: `Lỗi máy chủ (${res.status})`, code: 'STREAM_ERROR' };
      try {
        data = await res.json();
      } catch {
        // Fallback giữ nguyên thông báo HTTP status
      }
      const err = new Error(data.error || `Lỗi máy chủ (${res.status})`);
      err.status = res.status;
      err.code = data.code || 'STREAM_ERROR';
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const processChunkBlock = (block) => {
      if (!block.trim()) return;
      let eventName = 'message';
      const dataLines = [];
      for (const rawLine of block.split(/\r?\n/)) {
        if (rawLine.startsWith('event:')) {
          eventName = rawLine.slice(6).trim();
        } else if (rawLine.startsWith('data:')) {
          dataLines.push(rawLine.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) return;
      const rawData = dataLines.join('\n');
      let parsed = rawData;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        // Giữ nguyên chuỗi thô nếu không phải JSON
      }
      onEvent(eventName, parsed);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const part of parts) {
        processChunkBlock(part);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      processChunkBlock(buffer);
    }
  }

  function renderFormattedAssistantText(container, text) {
    container.textContent = '';
    const lines = String(text || '').split(/\r?\n/);
    let currentList = null;

    const appendInlineBold = (parent, lineStr) => {
      const parts = lineStr.split(/(\*\*[^*]+\*\*)/g);
      for (const part of parts) {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          const strong = document.createElement('strong');
          strong.textContent = part.slice(2, -2);
          parent.appendChild(strong);
        } else if (part) {
          parent.appendChild(document.createTextNode(part));
        }
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        currentList = null;
        continue;
      }
      const bulletMatch = line.match(/^(?:[-*•]|\d+\.)\s+(.+)$/);
      if (bulletMatch) {
        if (!currentList) {
          currentList = document.createElement('ul');
          container.appendChild(currentList);
        }
        const li = document.createElement('li');
        appendInlineBold(li, bulletMatch[1]);
        currentList.appendChild(li);
      } else {
        currentList = null;
        const p = document.createElement('p');
        appendInlineBold(p, line);
        container.appendChild(p);
      }
    }
  }

  function openLightbox(src) {
    if (!src) return;
    const dialog = document.getElementById('image-lightbox-dialog');
    const img = document.getElementById('lightbox-img');
    img.src = src;
    dialog.showModal();
  }

  // ==================== SERVER CONFIG & THEME ENGINE (LIGHT / DARK) ====================
  function getStoredTheme() {
    try {
      const value = localStorage.getItem(STORAGE_THEME);
      return value === 'dark' || value === 'light' ? value : null;
    } catch {
      return null;
    }
  }

  function applyTheme(storedPreference) {
    const prefersDark = Boolean(
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    );
    const effective = storedPreference || (prefersDark ? 'dark' : 'light');
    const isDark = effective === 'dark';

    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.classList.toggle('light', !isDark);

    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      meta.content = storedPreference || 'light dark';
    }

    const btn = document.getElementById('btn-theme-toggle');
    const label = document.getElementById('theme-toggle-label');
    if (btn) {
      btn.setAttribute('aria-pressed', String(isDark));
      btn.setAttribute(
        'aria-label',
        isDark ? 'Chuyển sang chế độ Sáng' : 'Chuyển sang chế độ Tối'
      );
    }
    if (label) {
      label.textContent = isDark ? 'Sáng' : 'Tối';
    }

    if (state.lastAnalytics && !document.getElementById('counselor-dashboard')?.hidden) {
      renderCharts(state.lastAnalytics);
    }
  }

  function initThemeToggle() {
    applyTheme(getStoredTheme());

    const toggleBtn = document.getElementById('btn-theme-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const currentlyDark = document.documentElement.classList.contains('dark');
        const nextTheme = currentlyDark ? 'light' : 'dark';
        try {
          localStorage.setItem(STORAGE_THEME, nextTheme);
        } catch {
          // Tiếp tục áp dụng giao diện ngay cả khi trình duyệt chặn lưu trữ
        }
        applyTheme(nextTheme);
        announceSR(
          nextTheme === 'dark' ? 'Đã chuyển sang chế độ Tối.' : 'Đã chuyển sang chế độ Sáng.'
        );
      });
    }

    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onOsThemeChange = () => {
        if (!getStoredTheme()) {
          applyTheme(null);
        }
      };
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onOsThemeChange);
      }
    }

    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_THEME) {
        applyTheme(getStoredTheme());
      }
    });
  }

  async function loadServerConfig() {
    try {
      const data = await apiFetch('/api/config/status');
      state.serverConfig = data;
      const modelBadge = document.getElementById('header-model-badge');
      if (modelBadge && data.model) {
        modelBadge.textContent = data.model;
      }

      const inlineHint = document.getElementById('inline-pin-hint');
      const inlinePinCode = document.getElementById('inline-pin-code');
      const dialogHintBox = document.getElementById('dialog-pin-hint-box');
      const dialogHintVal = document.getElementById('dialog-pin-hint-value');

      if (data.isDefaultPin && data.demoPinHint) {
        if (inlineHint && inlinePinCode) {
          inlinePinCode.textContent = data.demoPinHint;
          inlineHint.hidden = false;
        }
        if (dialogHintBox && dialogHintVal) {
          dialogHintVal.textContent = data.demoPinHint;
          dialogHintBox.hidden = false;
        }
      } else {
        if (inlineHint) inlineHint.hidden = true;
        if (dialogHintBox) dialogHintBox.hidden = true;
      }
    } catch {
      // Giữ nguyên cấu hình mặc định nếu mất kết nối tạm thời
    }
  }

  // ==================== NAVIGATION: STUDENT <-> COUNSELOR & TABS ====================
  function switchMode(targetMode) {
    state.mode = targetMode;
    const studentSpace = document.getElementById('student-space');
    const counselorSpace = document.getElementById('counselor-space');
    const btnStudent = document.getElementById('btn-mode-student');
    const btnCounselor = document.getElementById('btn-mode-counselor');

    const isStudent = targetMode === 'student';
    studentSpace.hidden = !isStudent;
    counselorSpace.hidden = isStudent;

    btnStudent.classList.toggle('is-active', isStudent);
    btnStudent.setAttribute('aria-pressed', String(isStudent));

    btnCounselor.classList.toggle('is-active', !isStudent);
    btnCounselor.setAttribute('aria-pressed', String(!isStudent));

    if (!isStudent) {
      renderCounselorView();
      if (!state.counselorToken) {
        const pinDialog = document.getElementById('counselor-pin-dialog');
        if (!pinDialog.open) pinDialog.showModal();
      }
    }
  }

  function switchStudentTab(tabName) {
    state.studentTab = tabName;
    const tabButtons = document.querySelectorAll('.student-tabs [role="tab"]');
    const panels = {
      analyzer: document.getElementById('panel-analyzer'),
      tracker: document.getElementById('panel-tracker'),
      handbook: document.getElementById('panel-handbook'),
    };

    for (const btn of tabButtons) {
      const btnTab = btn.id.replace('tab-', '');
      const selected = btnTab === tabName;
      btn.classList.toggle('is-active', selected);
      btn.setAttribute('aria-selected', String(selected));
      btn.setAttribute('tabindex', selected ? '0' : '-1');
    }

    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== tabName;
    }

    if (tabName === 'tracker') {
      renderLocalTicketHistory();
    }
  }

  function initNavigation() {
    document.getElementById('btn-mode-student').addEventListener('click', () => switchMode('student'));
    document.getElementById('btn-mode-counselor').addEventListener('click', () => switchMode('counselor'));

    const tabList = document.querySelector('.student-tabs');
    const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'));

    tabs.forEach((tab, idx) => {
      tab.addEventListener('click', () => {
        switchStudentTab(tab.id.replace('tab-', ''));
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          const next = tabs[(idx + dir + tabs.length) % tabs.length];
          next.focus();
          switchStudentTab(next.id.replace('tab-', ''));
        }
      });
    });
  }

  // ==================== IMAGE UPLOAD, DRAG-DROP, CTRL+V & SMART CLIENT COMPRESSION ====================
  function optimizeImageFile(file) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      if (!allowed.includes(file.type)) {
        reject(new Error('Định dạng ảnh không hợp lệ. Vui lòng chọn PNG, JPG, WebP hoặc GIF.'));
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        reject(new Error('Ảnh vượt quá kích thước tối đa 8MB.'));
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Không thể đọc file ảnh.'));
      reader.onload = () => {
        const rawDataUrl = String(reader.result || '');
        const img = new Image();
        img.onerror = () => {
          resolve({
            dataUrl: rawDataUrl,
            originalBytes: file.size,
            optimizedBytes: Math.round(rawDataUrl.length * 0.75),
            width: 0,
            height: 0,
            durationMs: Math.round(performance.now() - startedAt),
            mimeType: file.type,
          });
        };
        img.onload = () => {
          const maxDim = 1024;
          let { naturalWidth: width, naturalHeight: height } = img;
          if (!width || !height) {
            width = img.width || maxDim;
            height = img.height || maxDim;
          }

          if (file.type === 'image/gif' && file.size <= 350 * 1024 && Math.max(width, height) <= maxDim) {
            resolve({
              dataUrl: rawDataUrl,
              originalBytes: file.size,
              optimizedBytes: file.size,
              width,
              height,
              durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
              mimeType: 'image/gif',
            });
            return;
          }

          if (width > maxDim || height > maxDim) {
            const ratio = Math.min(maxDim / width, maxDim / height);
            width = Math.max(1, Math.round(width * ratio));
            height = Math.max(1, Math.round(height * ratio));
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          let outUrl = canvas.toDataURL('image/webp', 0.78);
          let outMime = 'image/webp';
          if (!outUrl.startsWith('data:image/webp')) {
            outUrl = canvas.toDataURL('image/jpeg', 0.78);
            outMime = 'image/jpeg';
          }

          const optimizedBytes = Math.round((outUrl.length - outUrl.indexOf(',') - 1) * 0.75);
          const finalUrl = optimizedBytes >= file.size && Math.max(img.naturalWidth || width, img.naturalHeight || height) <= maxDim && file.type !== 'image/gif'
            ? rawDataUrl
            : outUrl;
          const finalBytes = finalUrl === rawDataUrl ? file.size : optimizedBytes;

          resolve({
            dataUrl: finalUrl,
            originalBytes: file.size,
            optimizedBytes: finalBytes,
            width,
            height,
            durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
            mimeType: finalUrl === rawDataUrl ? file.type : outMime,
          });
        };
        img.src = rawDataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  async function setAttachedImage(file) {
    const errorEl = document.getElementById('analyze-error');
    const compressMetaEl = document.getElementById('image-compress-meta');
    setInlineAlert(errorEl, '');
    try {
      const optimized = await optimizeImageFile(file);
      state.currentImageDataUrl = optimized.dataUrl;
      state.currentImageName = file.name || `anh-chup-${Date.now()}.webp`;
      state.lastImageMeta = optimized;
      document.getElementById('preview-img').src = optimized.dataUrl;
      document.getElementById('preview-filename').textContent = state.currentImageName;
      if (compressMetaEl) {
        const savedPct =
          optimized.originalBytes > optimized.optimizedBytes
            ? Math.round(((optimized.originalBytes - optimized.optimizedBytes) / optimized.originalBytes) * 100)
            : 0;
        const dims = optimized.width && optimized.height ? `${optimized.width}×${optimized.height} · ` : '';
        compressMetaEl.textContent =
          savedPct > 0
            ? `${dims}${formatByteSize(optimized.originalBytes)} → ${formatByteSize(optimized.optimizedBytes)} (-${savedPct}%) trong ${optimized.durationMs}ms`
            : `${dims}${formatByteSize(optimized.optimizedBytes)} · Sẵn sàng (${optimized.durationMs}ms)`;
        compressMetaEl.hidden = false;
      }
      document.getElementById('dropzone-empty').hidden = true;
      document.getElementById('dropzone-preview').hidden = false;
    } catch (err) {
      setInlineAlert(errorEl, err.message);
    }
  }

  function clearAttachedImage() {
    state.currentImageDataUrl = null;
    state.currentImageName = '';
    state.lastImageMeta = null;
    document.getElementById('image-input').value = '';
    document.getElementById('preview-img').src = '';
    document.getElementById('preview-filename').textContent = '';
    const compressMetaEl = document.getElementById('image-compress-meta');
    if (compressMetaEl) {
      compressMetaEl.textContent = '';
      compressMetaEl.hidden = true;
    }
    document.getElementById('dropzone-empty').hidden = false;
    document.getElementById('dropzone-preview').hidden = true;
  }

  function initImageDropzone() {
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('image-input');
    const removeBtn = document.getElementById('btn-remove-image');

    dropzone.addEventListener('click', (e) => {
      if (e.target.closest('#btn-remove-image')) return;
      fileInput.click();
    });

    dropzone.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('#btn-remove-image')) {
        e.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        setAttachedImage(fileInput.files[0]);
      }
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('is-dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) setAttachedImage(file);
    });

    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearAttachedImage();
    });

    // Hỗ trợ dán ảnh trực tiếp bằng Ctrl+V khi đang ở Tab Phân tích
    document.addEventListener('paste', (e) => {
      if (state.mode !== 'student' || state.studentTab !== 'analyzer') return;
      if (document.querySelector('dialog[open]')) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            setAttachedImage(blob);
            showToast('Đã dán ảnh chụp màn hình từ clipboard.', 'success');
            break;
          }
        }
      }
    });
  }

  // ==================== ANALYZER, STREAMING UI, BREATHING AID & TICKET RECEIPT CARD ====================
  function updateAnalyzeStage(stageKey, labelText, percent) {
    const labelEl = document.getElementById('analyze-stage-label');
    const barEl = document.getElementById('analyze-progress-bar');
    const fillEl = document.getElementById('analyze-progress-fill');
    const pills = document.querySelectorAll('#analyze-loading .stage-pill');

    const clamped = Math.max(8, Math.min(100, Number(percent) || 0));
    if (labelEl && labelText) labelEl.textContent = labelText;
    if (barEl) barEl.setAttribute('aria-valuenow', String(Math.round(clamped)));
    if (fillEl) fillEl.style.transform = `scaleX(${clamped / 100})`;

    const order = ['optimize', 'scanning', 'first_aid', 'done'];
    const currentIdx = order.indexOf(stageKey === 'cache_hit' ? 'done' : stageKey);
    for (const pill of pills) {
      const pStage = pill.getAttribute('data-stage');
      const pIdx = order.indexOf(pStage);
      pill.classList.toggle('is-done', currentIdx > pIdx || stageKey === 'done' || stageKey === 'cache_hit');
      pill.classList.toggle('is-active', currentIdx === pIdx && stageKey !== 'done' && stageKey !== 'cache_hit');
    }
  }

  function stopBreathingGuide(resetMessage = true) {
    if (state.breathingTimerId) {
      window.clearInterval(state.breathingTimerId);
      state.breathingTimerId = null;
    }
    const circle = document.getElementById('breathing-circle');
    const countdown = document.getElementById('breathing-countdown');
    const phaseEl = document.getElementById('breathing-phase');
    const btn = document.getElementById('btn-breathing-toggle');
    if (circle) circle.className = 'breathing-circle';
    if (countdown) countdown.textContent = '30s';
    if (resetMessage && phaseEl) {
      phaseEl.textContent =
        'Nếu tim đang đập nhanh hay hoảng loạn, nhấn nút bên cạnh để AI đếm nhịp cùng bạn.';
    }
    if (btn) {
      btn.querySelector('span').textContent = 'Hít thở ngay';
    }
  }

  function initBreathingGuide() {
    const toggleBtn = document.getElementById('btn-breathing-toggle');
    const circle = document.getElementById('breathing-circle');
    const countdown = document.getElementById('breathing-countdown');
    const phaseEl = document.getElementById('breathing-phase');
    if (!toggleBtn) return;

    const PHASES = [
      { end: 4, label: 'Hít vào chậm bằng mũi… (4 giây)', cls: 'phase-inhale' },
      { end: 11, label: 'Giữ hơi nhẹ nhàng… (7 giây)', cls: 'phase-hold' },
      { end: 19, label: 'Thở ra từ từ qua miệng… (8 giây)', cls: 'phase-exhale' },
      { end: 23, label: 'Hít vào lần 2 thật êm… (4 giây)', cls: 'phase-inhale' },
      { end: 30, label: 'Thở ra hết và thả lỏng vai… (7 giây)', cls: 'phase-exhale' },
    ];

    toggleBtn.addEventListener('click', () => {
      if (state.breathingTimerId) {
        stopBreathingGuide(true);
        return;
      }

      const startAt = Date.now();
      toggleBtn.querySelector('span').textContent = 'Dừng lại';

      const tick = () => {
        const elapsedSec = (Date.now() - startAt) / 1000;
        const remaining = Math.max(0, Math.ceil(30 - elapsedSec));
        if (countdown) countdown.textContent = `${remaining}s`;

        if (elapsedSec >= 30) {
          stopBreathingGuide(false);
          if (phaseEl) {
            phaseEl.textContent =
              'Hoàn thành 30 giây. Nhịp tim và hơi thở của bạn đang ổn định hơn rồi.';
          }
          announceSR('Đã hoàn thành bài tập hít thở 30 giây.');
          return;
        }

        const currentPhase = PHASES.find((p) => elapsedSec < p.end) || PHASES[PHASES.length - 1];
        if (phaseEl && phaseEl.textContent !== currentPhase.label) {
          phaseEl.textContent = currentPhase.label;
        }
        if (circle) {
          circle.className = `breathing-circle ${currentPhase.cls}`;
        }
      };

      tick();
      state.breathingTimerId = window.setInterval(tick, 200);
    });
  }

  function renderPartialAnalysis(fields) {
    if (!fields || typeof fields !== 'object') return;
    const emptyEl = document.getElementById('analysis-empty-state');
    const contentEl = document.getElementById('analysis-result-content');
    emptyEl.hidden = true;
    contentEl.hidden = false;

    if (fields.risk_level) {
      const risk = RISK_META[fields.risk_level] || RISK_META.LOW;
      document.getElementById('result-risk-banner').className = `risk-banner ${risk.cls}`;
      const badge = document.getElementById('result-risk-badge');
      badge.className = `risk-pill ${risk.cls}`;
      badge.textContent = risk.label;
      const isUrgent = fields.risk_level === 'HIGH' || fields.risk_level === 'CRITICAL';
      document.getElementById('result-crisis-alert').hidden = !isUrgent;
      document.getElementById('breathing-widget')?.classList.toggle('is-urgent', isUrgent);
    }

    if (Number.isFinite(fields.confidence_score)) {
      document.getElementById('result-confidence').textContent = `Độ tin cậy AI: ${fields.confidence_score}%`;
    }
    if (fields.category) {
      document.getElementById('result-category').textContent = fields.category;
    }
    if (fields.psychological_first_aid) {
      document.getElementById('result-first-aid').textContent = fields.psychological_first_aid;
    }
    if (fields.evidence_excerpt) {
      document.getElementById('result-evidence-excerpt').textContent = `"${fields.evidence_excerpt}"`;
      document.getElementById('result-evidence-excerpt-block').hidden = false;
    }
    if (fields.detected_signals) {
      document.getElementById('result-signals').textContent = fields.detected_signals;
    }
    if (fields.legal_psych_impact) {
      document.getElementById('result-legal-impact').textContent = fields.legal_psych_impact;
      document.getElementById('result-legal-impact-block').hidden = false;
    }
    if (Array.isArray(fields.actionable_steps) && fields.actionable_steps.length > 0) {
      const stepsEl = document.getElementById('result-steps');
      stepsEl.textContent = '';
      for (const step of fields.actionable_steps) {
        const li = document.createElement('li');
        li.textContent = step;
        stepsEl.appendChild(li);
      }
    }
  }

  function renderAnalysisResult(analysis, meta = null) {
    const emptyEl = document.getElementById('analysis-empty-state');
    const contentEl = document.getElementById('analysis-result-content');
    const banner = document.getElementById('result-risk-banner');
    const badge = document.getElementById('result-risk-badge');
    const latencyEl = document.getElementById('result-latency-chip');
    const confidenceEl = document.getElementById('result-confidence');
    const categoryEl = document.getElementById('result-category');
    const crisisEl = document.getElementById('result-crisis-alert');
    const firstAidEl = document.getElementById('result-first-aid');
    const excerptBlock = document.getElementById('result-evidence-excerpt-block');
    const excerptEl = document.getElementById('result-evidence-excerpt');
    const signalsEl = document.getElementById('result-signals');
    const legalBlock = document.getElementById('result-legal-impact-block');
    const legalEl = document.getElementById('result-legal-impact');
    const stepsEl = document.getElementById('result-steps');
    const ticketBox = document.getElementById('anonymous-handoff-section');
    const ticketLead = document.getElementById('ticket-submit-lead');
    const standbyNote = document.getElementById('handoff-standby-note');
    const ticketForm = document.getElementById('ticket-submit-form');

    const risk = RISK_META[analysis.risk_level] || RISK_META.LOW;
    banner.className = `risk-banner ${risk.cls}`;
    badge.className = `risk-pill ${risk.cls}`;
    badge.textContent = risk.label;
    confidenceEl.textContent = `Độ tin cậy AI: ${analysis.confidence_score}%`;
    categoryEl.textContent = analysis.category;

    if (latencyEl && meta && Number.isFinite(meta.latencyMs)) {
      latencyEl.textContent = meta.cached
        ? `Cache tức thì · ${meta.latencyMs}ms`
        : `${(meta.latencyMs / 1000).toFixed(2)}s · ${meta.modelUsed || 'gemini-3.5-flash-lite'}`;
      latencyEl.hidden = false;
    } else if (latencyEl) {
      latencyEl.hidden = true;
    }

    const isUrgent = analysis.risk_level === 'HIGH' || analysis.risk_level === 'CRITICAL';
    crisisEl.hidden = !isUrgent;
    document.getElementById('breathing-widget')?.classList.toggle('is-urgent', isUrgent);

    firstAidEl.textContent = analysis.psychological_first_aid;

    if (analysis.evidence_excerpt) {
      excerptEl.textContent = `"${analysis.evidence_excerpt}"`;
      excerptBlock.hidden = false;
    } else {
      excerptEl.textContent = '';
      excerptBlock.hidden = true;
    }

    signalsEl.textContent = analysis.detected_signals;

    if (analysis.legal_psych_impact) {
      legalEl.textContent = analysis.legal_psych_impact;
      legalBlock.hidden = false;
    } else {
      legalEl.textContent = '';
      legalBlock.hidden = true;
    }

    stepsEl.textContent = '';
    for (const step of analysis.actionable_steps || []) {
      const li = document.createElement('li');
      li.textContent = step;
      stepsEl.appendChild(li);
    }

    const isMediumOrAbove = analysis.risk_level !== 'LOW';
    ticketBox.classList.toggle('is-recommended', isMediumOrAbove);
    ticketLead.textContent = isMediumOrAbove
      ? 'Mức độ rủi ro từ Trung bình trở lên: bạn nên gửi hồ sơ ẩn danh ngay để Thầy/Cô Tổ Tư vấn đồng hành hỗ trợ.'
      : 'Nếu bạn vẫn cảm thấy bất an hoặc muốn trao đổi thêm, bạn luôn có thể gửi hồ sơ ẩn danh tới Tổ Tư vấn.';

    // Mở khóa form gửi ticket cho lượt phân tích mới
    if (standbyNote) standbyNote.hidden = true;
    ticketForm.hidden = false;
    ticketForm.classList.remove('handoff-unlocked-flash');
    void ticketForm.offsetWidth;
    ticketForm.classList.add('handoff-unlocked-flash');
    document.getElementById('ticket-receipt').hidden = true;
    document.getElementById('student-note').value = '';
    setInlineAlert(document.getElementById('ticket-submit-error'), '');

    emptyEl.hidden = true;
    contentEl.hidden = false;
  }

  function downloadTicketReceiptCard(code, riskLevel) {
    if (!code) return;
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 960, 540);
    grad.addColorStop(0, '#042F2E');
    grad.addColorStop(0.52, '#0F172A');
    grad.addColorStop(1, '#082F49');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 960, 540);

    // Subtle accent border
    ctx.strokeStyle = 'rgba(45, 212, 191, 0.55)';
    ctx.lineWidth = 4;
    ctx.strokeRect(24, 24, 912, 492);

    ctx.fillStyle = '#2DD4BF';
    ctx.font = 'bold 24px "Be Vietnam Pro", Arial, sans-serif';
    ctx.fillText('SAFESCHOOL AI — LÁ CHẮN SỐ HỌC ĐƯỜNG', 56, 86);

    ctx.fillStyle = '#CBD5E1';
    ctx.font = '500 18px "Be Vietnam Pro", Arial, sans-serif';
    ctx.fillText('Thẻ Mã Hồ Sơ Ẩn Danh (Zero-Identity 100%)', 56, 122);

    // Code box
    ctx.fillStyle = 'rgba(15, 118, 110, 0.25)';
    ctx.fillRect(56, 162, 848, 150);
    ctx.strokeStyle = '#2DD4BF';
    ctx.lineWidth = 2;
    ctx.strokeRect(56, 162, 848, 150);

    ctx.fillStyle = '#99F6E4';
    ctx.font = '600 18px "Be Vietnam Pro", Arial, sans-serif';
    ctx.fillText('MÃ TRA CỨU & NHẮN TIN 2 CHIỀU CÙNG TỔ TƯ VẤN:', 84, 204);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 64px "JetBrains Mono", monospace';
    ctx.fillText(code, 84, 282);

    const riskLabel = (RISK_META[riskLevel] && RISK_META[riskLevel].label) || riskLevel || 'Đang theo dõi';
    ctx.fillStyle = '#E2E8F0';
    ctx.font = '600 20px "Be Vietnam Pro", Arial, sans-serif';
    ctx.fillText(`Mức độ AI ghi nhận: ${riskLabel}`, 56, 366);
    ctx.fillText(`Thời gian tạo: ${formatDateTime(new Date().toISOString())}`, 56, 402);

    ctx.fillStyle = '#94A3B8';
    ctx.font = '500 16px "Be Vietnam Pro", Arial, sans-serif';
    ctx.fillText('Hãy giữ kín mã này để đọc phản hồi từ Thầy/Cô mà không cần tiết lộ danh tính.', 56, 456);
    ctx.fillText('Team Victer - DNT (Nguyễn Tiến Đức) · Trường THPT Tôn Đức Thắng, xã Tà Lài, tỉnh Đồng Nai', 56, 488);

    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `SafeSchool-${code}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(`Đã tải ảnh thẻ mã ${code}.png về máy.`, 'success');
  }

  function saveLocalTicketCode(code, riskLevel) {
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(STORAGE_MY_TICKETS) || '[]');
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
    const filtered = list.filter((item) => item.code !== code);
    filtered.unshift({ code, riskLevel, createdAt: new Date().toISOString() });
    localStorage.setItem(STORAGE_MY_TICKETS, JSON.stringify(filtered.slice(0, 10)));
  }

  function renderLocalTicketHistory() {
    const box = document.getElementById('local-history-box');
    const chips = document.getElementById('local-history-chips');
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(STORAGE_MY_TICKETS) || '[]');
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }

    if (list.length === 0) {
      box.hidden = true;
      chips.textContent = '';
      return;
    }

    chips.textContent = '';
    for (const item of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-chip';
      btn.textContent = item.code;
      btn.addEventListener('click', () => {
        document.getElementById('lookup-code').value = item.code;
        loadTrackerTicket(item.code);
      });
      chips.appendChild(btn);
    }
    box.hidden = false;
  }

  function initAnalyzer() {
    const form = document.getElementById('analyze-form');
    const textInput = document.getElementById('report-text');
    const submitBtn = document.getElementById('btn-analyze-submit');
    const resetBtn = document.getElementById('btn-analyze-reset');
    const loadingEl = document.getElementById('analyze-loading');
    const errorEl = document.getElementById('analyze-error');

    const elapsedBadge = document.getElementById('analyze-elapsed-badge');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setInlineAlert(errorEl, '');

      const text = textInput.value.trim();
      const imageDataUrl = state.currentImageDataUrl;
      if (!text && !imageDataUrl) {
        setInlineAlert(
          errorEl,
          'Vui lòng nhập nội dung tin nhắn/bình luận hoặc đính kèm ảnh chụp màn hình.'
        );
        textInput.focus();
        return;
      }

      if (state.analyzeAbortController) {
        state.analyzeAbortController.abort();
      }
      const abortCtrl = new AbortController();
      state.analyzeAbortController = abortCtrl;
      stopBreathingGuide(true);

      // Chuẩn bị giao diện nhận luồng SSE mới
      document.getElementById('ticket-submit-form').hidden = true;
      document.getElementById('ticket-receipt').hidden = true;
      const standbyNote = document.getElementById('handoff-standby-note');
      if (standbyNote) standbyNote.hidden = false;
      const excerptBlock = document.getElementById('result-evidence-excerpt-block');
      const legalBlock = document.getElementById('result-legal-impact-block');
      const latencyChip = document.getElementById('result-latency-chip');
      if (excerptBlock) excerptBlock.hidden = true;
      if (legalBlock) legalBlock.hidden = true;
      if (latencyChip) latencyChip.hidden = true;

      submitBtn.disabled = true;
      loadingEl.hidden = false;
      const optimizeLabel = state.lastImageMeta
        ? `Ảnh đã tối ưu (${formatByteSize(state.lastImageMeta.optimizedBytes)}) · Đang gửi luồng AI...`
        : 'Đang gửi dữ liệu an toàn tới luồng AI siêu tốc...';
      updateAnalyzeStage('optimize', optimizeLabel, 18);

      const startedAt = performance.now();
      if (elapsedBadge) elapsedBadge.textContent = '0.0s';
      const elapsedInterval = window.setInterval(() => {
        if (elapsedBadge) {
          elapsedBadge.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
        }
      }, 100);

      let finalPayload = null;
      let streamErrorMsg = null;

      try {
        await streamSseRequest(
          '/api/analyze/stream',
          { text, imageDataUrl },
          (eventName, payload) => {
            if (eventName === 'stage' && payload) {
              updateAnalyzeStage(payload.step, payload.label, payload.percent);
            } else if (eventName === 'partial' && payload && payload.fields) {
              renderPartialAnalysis(payload.fields);
            } else if (eventName === 'done' && payload && payload.analysis) {
              finalPayload = payload;
            } else if (eventName === 'error' && payload) {
              streamErrorMsg = payload.error || 'Không thể hoàn tất phân tích AI.';
            }
          },
          abortCtrl.signal
        );

        if (streamErrorMsg) {
          throw new Error(streamErrorMsg);
        }
        if (!finalPayload || !finalPayload.analysis) {
          throw new Error('Luồng AI kết thúc nhưng chưa nhận đủ kết quả.');
        }

        state.lastAnalysis = finalPayload.analysis;
        state.lastAnalyzeMeta = {
          latencyMs: finalPayload.latencyMs,
          cached: Boolean(finalPayload.cached),
          modelUsed: finalPayload.modelUsed,
        };
        state.lastAnalyzedText = text;
        state.lastAnalyzedImage = imageDataUrl;
        updateAnalyzeStage('done', 'Hoàn tất phân tích & sơ cứu tâm lý', 100);
        renderAnalysisResult(finalPayload.analysis, state.lastAnalyzeMeta);
        announceSR(
          `Đã hoàn tất phân tích. Mức độ rủi ro: ${RISK_META[finalPayload.analysis.risk_level]?.label || finalPayload.analysis.risk_level}.`
        );
      } catch (err) {
        if (err.name !== 'AbortError') {
          setInlineAlert(errorEl, err.message);
        }
      } finally {
        window.clearInterval(elapsedInterval);
        if (state.analyzeAbortController === abortCtrl) {
          state.analyzeAbortController = null;
        }
        submitBtn.disabled = false;
        loadingEl.hidden = true;
      }
    });

    resetBtn.addEventListener('click', () => {
      if (state.analyzeAbortController) {
        state.analyzeAbortController.abort();
        state.analyzeAbortController = null;
      }
      stopBreathingGuide(true);
      textInput.value = '';
      clearAttachedImage();
      setInlineAlert(errorEl, '');
      state.lastAnalysis = null;
      state.lastAnalyzeMeta = null;
      state.lastAnalyzedText = '';
      state.lastAnalyzedImage = null;
      document.getElementById('analysis-empty-state').hidden = false;
      document.getElementById('analysis-result-content').hidden = true;
      const ticketBox = document.getElementById('anonymous-handoff-section');
      if (ticketBox) ticketBox.classList.remove('is-recommended');
      const standbyNote = document.getElementById('handoff-standby-note');
      if (standbyNote) standbyNote.hidden = false;
      document.getElementById('ticket-submit-form').hidden = true;
      document.getElementById('ticket-receipt').hidden = true;
    });

    // Nộp hồ sơ ẩn danh (Zero-Identity Ticket)
    const ticketForm = document.getElementById('ticket-submit-form');
    const ticketErr = document.getElementById('ticket-submit-error');
    const sendTicketBtn = document.getElementById('btn-send-ticket');

    ticketForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      setInlineAlert(ticketErr, '');
      if (!state.lastAnalysis) return;

      const selectedGrade =
        ticketForm.querySelector('input[name="grade_level"]:checked')?.value || 'ANONYMOUS';
      const studentNote = document.getElementById('student-note').value.trim();

      sendTicketBtn.disabled = true;
      try {
        const res = await apiFetch('/api/tickets', {
          method: 'POST',
          body: JSON.stringify({
            grade_level: selectedGrade,
            reported_text: state.lastAnalyzedText,
            student_note: studentNote,
            evidence_image: state.lastAnalyzedImage,
            analysis: state.lastAnalysis,
          }),
        });

        const code = res.ticket.ticket_code;
        saveLocalTicketCode(code, res.ticket.risk_level);

        ticketForm.hidden = true;
        document.getElementById('receipt-code').textContent = code;
        document.getElementById('ticket-receipt').hidden = false;
        showToast(`Đã tạo hồ sơ ẩn danh ${code}`, 'success');
      } catch (err) {
        setInlineAlert(ticketErr, err.message);
      } finally {
        sendTicketBtn.disabled = false;
      }
    });

    document.getElementById('btn-copy-code').addEventListener('click', async () => {
      const code = document.getElementById('receipt-code').textContent.trim();
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        showToast(`Đã sao chép mã ${code}`, 'success');
      } catch {
        showToast(`Mã của bạn là ${code} — hãy ghi lại cẩn thận.`, 'default');
      }
    });

    document.getElementById('btn-download-receipt')?.addEventListener('click', () => {
      const code = document.getElementById('receipt-code').textContent.trim();
      downloadTicketReceiptCard(code, state.lastAnalysis?.risk_level);
    });

    document.getElementById('btn-goto-tracker').addEventListener('click', () => {
      const code = document.getElementById('receipt-code').textContent.trim();
      switchStudentTab('tracker');
      document.getElementById('lookup-code').value = code;
      loadTrackerTicket(code);
    });
  }

  // ==================== TWO-WAY TRACKER (STUDENT) ====================
  function renderMessagesList(container, messages, viewerRole) {
    container.textContent = '';
    if (!messages || messages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'msg-empty-hint';
      empty.textContent =
        viewerRole === 'STUDENT'
          ? 'Chưa có tin nhắn phản hồi. Thầy/Cô Tổ Tư vấn sẽ trả lời qua mã hồ sơ này sớm nhất có thể.'
          : 'Chưa có tin nhắn trao đổi nào. Hãy gửi phản hồi đầu tiên để trấn an và hướng dẫn học sinh.';
      container.appendChild(empty);
      return;
    }

    for (const msg of messages) {
      const bubble = document.createElement('div');
      const isStudent = msg.sender_role === 'STUDENT';
      bubble.className = `msg-bubble ${isStudent ? 'is-student' : 'is-counselor'}`;

      const body = document.createElement('div');
      body.textContent = msg.content;

      const meta = document.createElement('span');
      meta.className = 'msg-meta';
      const senderLabel = isStudent ? 'Học sinh (Ẩn danh)' : 'Thầy/Cô Tổ Tư vấn';
      meta.textContent = `${senderLabel} · ${formatDateTime(msg.created_at)}`;

      bubble.append(body, meta);
      container.appendChild(bubble);
    }
    container.scrollTop = container.scrollHeight;
  }

  async function loadTrackerTicket(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    const errorEl = document.getElementById('lookup-error');
    const emptyEl = document.getElementById('tracker-empty-state');
    const detailEl = document.getElementById('tracker-detail');

    setInlineAlert(errorEl, '');
    if (!/^SH-[A-Z0-9]{6}$/.test(code)) {
      setInlineAlert(errorEl, 'Vui lòng nhập đúng định dạng mã hồ sơ (ví dụ: SH-8F3K2P).');
      return;
    }

    try {
      const data = await apiFetch(`/api/tickets/${encodeURIComponent(code)}`);
      const { ticket, messages } = data;
      state.activeTrackerCode = ticket.ticket_code;

      document.getElementById('tracker-ticket-code').textContent = ticket.ticket_code;

      const statusMeta = STATUS_META[ticket.status] || STATUS_META.PENDING;
      const statusBadge = document.getElementById('tracker-status-badge');
      statusBadge.className = `status-pill ${statusMeta.cls}`;
      statusBadge.textContent = statusMeta.label;

      const riskMeta = RISK_META[ticket.risk_level] || RISK_META.LOW;
      const riskBadge = document.getElementById('tracker-risk-badge');
      riskBadge.className = `risk-pill ${riskMeta.cls}`;
      riskBadge.textContent = riskMeta.label;

      document.getElementById('tracker-category').textContent = ticket.category;
      document.getElementById('tracker-meta').textContent = `${GRADE_META[ticket.grade_level] || 'Ẩn danh'} · Gửi lúc ${formatDateTime(ticket.created_at)}`;

      document.getElementById('tracker-reported-text').textContent =
        ticket.reported_text || '(Học sinh chỉ đính kèm ảnh chụp màn hình)';
      document.getElementById('tracker-first-aid').textContent = ticket.psychological_first_aid;

      const evWrap = document.getElementById('tracker-evidence-wrap');
      const evImg = document.getElementById('tracker-evidence-img');
      if (ticket.evidence_image) {
        evImg.src = ticket.evidence_image;
        evWrap.hidden = false;
      } else {
        evImg.src = '';
        evWrap.hidden = true;
      }

      renderMessagesList(document.getElementById('student-messages-list'), messages, 'STUDENT');

      emptyEl.hidden = true;
      detailEl.hidden = false;
    } catch (err) {
      setInlineAlert(errorEl, err.message);
      emptyEl.hidden = false;
      detailEl.hidden = true;
    }
  }

  function initTracker() {
    const lookupForm = document.getElementById('lookup-form');
    const lookupInput = document.getElementById('lookup-code');
    const replyForm = document.getElementById('student-reply-form');
    const replyInput = document.getElementById('student-reply-input');
    const replyBtn = document.getElementById('btn-student-reply');

    attachImeSafeEnter(replyInput, replyForm);

    lookupForm.addEventListener('submit', (e) => {
      e.preventDefault();
      loadTrackerTicket(lookupInput.value);
    });

    document.getElementById('btn-refresh-tracker').addEventListener('click', () => {
      if (state.activeTrackerCode) {
        loadTrackerTicket(state.activeTrackerCode);
        showToast('Đã cập nhật trạng thái và tin nhắn mới nhất.', 'default');
      }
    });

    document.getElementById('btn-tracker-view-image').addEventListener('click', () => {
      openLightbox(document.getElementById('tracker-evidence-img').src);
    });

    document.getElementById('btn-clear-local-history').addEventListener('click', () => {
      localStorage.removeItem(STORAGE_MY_TICKETS);
      renderLocalTicketHistory();
      showToast('Đã xóa danh sách mã lưu trên trình duyệt này.', 'default');
    });

    replyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.activeTrackerCode) return;
      const content = replyInput.value.trim();
      if (!content) return;

      replyBtn.disabled = true;
      try {
        await apiFetch(`/api/tickets/${encodeURIComponent(state.activeTrackerCode)}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content }),
        });
        replyInput.value = '';
        await loadTrackerTicket(state.activeTrackerCode);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        replyBtn.disabled = false;
        replyInput.focus();
      }
    });
  }

  // ==================== DIGITAL HANDBOOK & AI CHAT (SUBSYSTEM C) ====================
  function appendChatBubble(role, text) {
    const emptyEl = document.getElementById('chat-empty-state');
    if (emptyEl) emptyEl.hidden = true;

    const list = document.getElementById('chat-messages');
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role === 'user' ? 'is-user' : 'is-assistant'}`;
    if (role === 'user') {
      bubble.textContent = text;
    } else if (text) {
      renderFormattedAssistantText(bubble, text);
    }
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
    return bubble;
  }

  async function sendChatMessage(messageText) {
    const errorEl = document.getElementById('chat-error');
    const sendBtn = document.getElementById('btn-chat-send');
    const input = document.getElementById('chat-input');
    const list = document.getElementById('chat-messages');
    setInlineAlert(errorEl, '');

    const text = messageText.trim();
    if (!text) return;

    if (state.chatAbortController) {
      state.chatAbortController.abort();
    }
    const abortCtrl = new AbortController();
    state.chatAbortController = abortCtrl;

    appendChatBubble('user', text);
    input.value = '';
    sendBtn.disabled = true;

    const assistantBubble = appendChatBubble('assistant', '');
    assistantBubble.classList.add('chat-streaming-cursor');
    let streamedReply = '';
    let finalPayload = null;
    let streamErrMsg = null;

    try {
      await streamSseRequest(
        '/api/chat/stream',
        {
          message: text,
          previousInteractionId: state.chatPreviousInteractionId,
          history: state.chatHistory,
        },
        (eventName, payload) => {
          if (eventName === 'delta' && payload && typeof payload.text === 'string') {
            streamedReply += payload.text;
            renderFormattedAssistantText(assistantBubble, streamedReply);
            list.scrollTop = list.scrollHeight;
          } else if (eventName === 'done' && payload) {
            finalPayload = payload;
          } else if (eventName === 'error' && payload) {
            streamErrMsg = payload.error || 'Trợ lý AI gặp gián đoạn khi phản hồi.';
          }
        },
        abortCtrl.signal
      );

      if (streamErrMsg) {
        throw new Error(streamErrMsg);
      }

      const finalText = (finalPayload && finalPayload.reply) || streamedReply;
      if (!finalText) {
        throw new Error('Trợ lý AI chưa trả về nội dung phản hồi.');
      }

      assistantBubble.classList.remove('chat-streaming-cursor');
      renderFormattedAssistantText(assistantBubble, finalText);
      list.scrollTop = list.scrollHeight;

      state.chatHistory.push({ role: 'user', text });
      state.chatHistory.push({ role: 'assistant', text: finalText });
      if (state.chatHistory.length > 16) {
        state.chatHistory = state.chatHistory.slice(-16);
      }
      if (finalPayload && finalPayload.interactionId) {
        state.chatPreviousInteractionId = finalPayload.interactionId;
      }
    } catch (err) {
      assistantBubble.classList.remove('chat-streaming-cursor');
      if (!streamedReply) assistantBubble.remove();
      if (err.name !== 'AbortError') {
        setInlineAlert(errorEl, err.message);
      }
    } finally {
      if (state.chatAbortController === abortCtrl) {
        state.chatAbortController = null;
      }
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function initChat() {
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const resetBtn = document.getElementById('btn-chat-reset');
    const messagesBox = document.getElementById('chat-messages');

    attachImeSafeEnter(input, form);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendChatMessage(input.value);
    });

    for (const chip of document.querySelectorAll('.prompt-chip')) {
      chip.addEventListener('click', () => {
        const prompt = chip.getAttribute('data-prompt') || chip.textContent;
        sendChatMessage(prompt);
      });
    }

    resetBtn.addEventListener('click', () => {
      if (state.chatAbortController) {
        state.chatAbortController.abort();
        state.chatAbortController = null;
      }
      state.chatPreviousInteractionId = null;
      state.chatHistory = [];
      setInlineAlert(document.getElementById('chat-error'), '');
      for (const bubble of messagesBox.querySelectorAll('.chat-bubble')) {
        bubble.remove();
      }
      document.getElementById('chat-empty-state').hidden = false;
      showToast('Đã bắt đầu cuộc trò chuyện mới.', 'default');
    });
  }

  // ==================== COUNSELOR DASHBOARD (SUBSYSTEM B) ====================
  function renderCharts(analytics) {
    state.lastAnalytics = analytics || null;
    const emptyEl = document.getElementById('analytics-empty-state');
    const chartsGrid = document.getElementById('analytics-charts-grid');

    if (!analytics || analytics.total === 0) {
      if (state.riskChart) {
        state.riskChart.destroy();
        state.riskChart = null;
      }
      if (state.categoryChart) {
        state.categoryChart.destroy();
        state.categoryChart = null;
      }
      chartsGrid.hidden = true;
      emptyEl.hidden = false;
      return;
    }

    emptyEl.hidden = true;
    chartsGrid.hidden = false;

    if (typeof window.Chart !== 'function') return;

    const isDark = document.documentElement.classList.contains('dark');
    const textColor = isDark ? '#F1F5F9' : '#0F172A';
    const gridColor = isDark ? 'rgba(148, 163, 184, 0.16)' : 'rgba(15, 23, 42, 0.08)';
    const borderSurface = isDark ? '#1E293B' : '#FFFFFF';
    const barColor = isDark ? '#38BDF8' : '#0284C7';

    const riskCounts = [
      analytics.byRisk.CRITICAL || 0,
      analytics.byRisk.HIGH || 0,
      analytics.byRisk.MEDIUM || 0,
      analytics.byRisk.LOW || 0,
    ];

    const riskCtx = document.getElementById('chart-risk').getContext('2d');
    if (state.riskChart) state.riskChart.destroy();
    state.riskChart = new window.Chart(riskCtx, {
      type: 'doughnut',
      data: {
        labels: ['Khẩn cấp (CRITICAL)', 'Rủi ro cao (HIGH)', 'Trung bình (MEDIUM)', 'Thấp / An toàn (LOW)'],
        datasets: [
          {
            data: riskCounts,
            backgroundColor: ['#e11d48', '#ea580c', '#f59e0b', '#10b981'],
            borderWidth: 2,
            borderColor: borderSurface,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: textColor,
              boxWidth: 12,
              font: { family: "'Be Vietnam Pro', sans-serif", size: 12 },
            },
          },
        },
      },
    });

    const catLabels = analytics.byCategory.map((item) => item.category);
    const catValues = analytics.byCategory.map((item) => item.count);

    const catCtx = document.getElementById('chart-category').getContext('2d');
    if (state.categoryChart) state.categoryChart.destroy();
    state.categoryChart = new window.Chart(catCtx, {
      type: 'bar',
      data: {
        labels: catLabels,
        datasets: [
          {
            label: 'Số hồ sơ thực tế',
            data: catValues,
            backgroundColor: barColor,
            borderRadius: 6,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: gridColor },
            ticks: { precision: 0, color: textColor },
          },
          y: {
            grid: { display: false },
            ticks: { color: textColor, font: { family: "'Be Vietnam Pro', sans-serif", size: 11 } },
          },
        },
        plugins: {
          legend: { display: false },
        },
      },
    });
  }

  function renderTriageQueue(tickets) {
    const emptyEl = document.getElementById('triage-empty-state');
    const listEl = document.getElementById('triage-queue-list');
    listEl.textContent = '';

    if (!tickets || tickets.length === 0) {
      emptyEl.hidden = false;
      return;
    }

    emptyEl.hidden = true;
    for (const item of tickets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'listitem');
      btn.className = `triage-item${state.selectedCounselorCode === item.ticket_code ? ' is-selected' : ''}`;

      const top = document.createElement('div');
      top.className = 'triage-item-top';

      const codeSpan = document.createElement('code');
      codeSpan.className = 'ticket-code-pill';
      codeSpan.textContent = item.ticket_code;

      const riskMeta = RISK_META[item.risk_level] || RISK_META.LOW;
      const riskSpan = document.createElement('span');
      riskSpan.className = `risk-pill ${riskMeta.cls}`;
      riskSpan.textContent = item.risk_level;

      const statusMeta = STATUS_META[item.status] || STATUS_META.PENDING;
      const statusSpan = document.createElement('span');
      statusSpan.className = `status-pill ${statusMeta.cls}`;
      statusSpan.textContent = statusMeta.label;

      top.append(codeSpan, riskSpan, statusSpan);

      const cat = document.createElement('div');
      cat.className = 'triage-item-cat';
      cat.textContent = item.category;

      const preview = document.createElement('div');
      preview.className = 'triage-item-preview';
      preview.textContent =
        item.reported_text ||
        item.student_note ||
        (item.has_image ? '[Hồ sơ đính kèm ảnh chụp màn hình]' : '(Không có mô tả văn bản)');

      const foot = document.createElement('div');
      foot.className = 'triage-item-foot';

      const leftFoot = document.createElement('span');
      leftFoot.textContent = `${GRADE_META[item.grade_level] || 'Ẩn danh'} · ${item.message_count} tin nhắn`;

      const rightFoot = document.createElement('span');
      rightFoot.textContent = formatDateTime(item.created_at);

      foot.append(leftFoot, rightFoot);
      btn.append(top, cat, preview, foot);

      btn.addEventListener('click', () => {
        loadCounselorTicketDetail(item.ticket_code);
      });

      listEl.appendChild(btn);
    }
  }

  async function loadCounselorTicketDetail(code) {
    try {
      const data = await apiFetch(`/api/counselor/tickets/${encodeURIComponent(code)}`, {
        counselorAuth: true,
      });
      const { ticket, messages } = data;
      state.selectedCounselorCode = ticket.ticket_code;

      // Đánh dấu card đang chọn
      for (const node of document.querySelectorAll('.triage-item')) {
        const c = node.querySelector('code')?.textContent;
        node.classList.toggle('is-selected', c === ticket.ticket_code);
      }

      document.getElementById('cd-code').textContent = ticket.ticket_code;

      const riskMeta = RISK_META[ticket.risk_level] || RISK_META.LOW;
      const riskEl = document.getElementById('cd-risk');
      riskEl.className = `risk-pill ${riskMeta.cls}`;
      riskEl.textContent = riskMeta.label;

      document.getElementById('cd-grade').textContent = GRADE_META[ticket.grade_level] || 'Ẩn danh';
      document.getElementById('cd-category').textContent = ticket.category;
      document.getElementById('cd-meta').textContent = `Tiếp nhận: ${formatDateTime(ticket.created_at)} · Độ tin cậy AI: ${ticket.confidence_score}%`;
      document.getElementById('cd-status-select').value = ticket.status;

      document.getElementById('cd-reported-text').textContent =
        ticket.reported_text || '(Học sinh chỉ gửi ảnh chụp màn hình)';

      const evWrap = document.getElementById('cd-evidence-wrap');
      const evImg = document.getElementById('cd-evidence-img');
      if (ticket.evidence_image) {
        evImg.src = ticket.evidence_image;
        evWrap.hidden = false;
      } else {
        evImg.src = '';
        evWrap.hidden = true;
      }

      const excerptEl = document.getElementById('cd-excerpt');
      const legalEl = document.getElementById('cd-legal-impact');
      if (excerptEl) {
        excerptEl.textContent = ticket.evidence_excerpt || 'Không có trích đoạn riêng.';
      }
      document.getElementById('cd-signals').textContent = ticket.detected_signals;
      if (legalEl) {
        legalEl.textContent =
          ticket.legal_psych_impact || 'Theo dõi theo quy tắc ứng xử học đường & Luật An ninh mạng.';
      }
      document.getElementById('cd-first-aid').textContent = ticket.psychological_first_aid;

      renderMessagesList(document.getElementById('counselor-messages-list'), messages, 'COUNSELOR');

      document.getElementById('counselor-detail-empty').hidden = true;
      document.getElementById('counselor-detail-content').hidden = false;
    } catch (err) {
      if (err.status === 401) {
        handleCounselorLogout(false);
        showToast('Phiên làm việc đã hết hạn, vui lòng đăng nhập lại.', 'error');
      } else {
        showToast(err.message, 'error');
      }
    }
  }

  async function refreshCounselorDashboard() {
    if (!state.counselorToken) return;
    try {
      const qs = state.counselorFilterStatus
        ? `?status=${encodeURIComponent(state.counselorFilterStatus)}`
        : '';
      const data = await apiFetch(`/api/counselor/dashboard${qs}`, { counselorAuth: true });
      const { analytics, tickets } = data;
      state.lastAnalytics = analytics;
      state.lastDashboardTickets = tickets || [];

      document.getElementById('kpi-total').textContent = String(analytics.total || 0);
      document.getElementById('kpi-urgent').textContent = String(
        (analytics.byRisk.CRITICAL || 0) + (analytics.byRisk.HIGH || 0)
      );
      document.getElementById('kpi-pending').textContent = String(analytics.byStatus.PENDING || 0);
      document.getElementById('kpi-resolved').textContent = String(analytics.byStatus.RESOLVED || 0);

      renderCharts(analytics);
      renderTriageQueue(tickets);

      if (state.selectedCounselorCode) {
        const stillExists = tickets.some((t) => t.ticket_code === state.selectedCounselorCode);
        if (stillExists) {
          await loadCounselorTicketDetail(state.selectedCounselorCode);
        } else {
          state.selectedCounselorCode = null;
          document.getElementById('counselor-detail-empty').hidden = false;
          document.getElementById('counselor-detail-content').hidden = true;
        }
      }
    } catch (err) {
      if (err.status === 401) {
        handleCounselorLogout(false);
      } else {
        showToast(err.message, 'error');
      }
    }
  }

  function csvEscapeCell(value) {
    let str = String(value == null ? '' : value).replace(/\r?\n/g, ' ').trim();
    if (/^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`;
    }
    return `"${str.replace(/"/g, '""')}"`;
  }

  function exportCounselorCsv() {
    const tickets = state.lastDashboardTickets || [];
    if (tickets.length === 0) {
      showToast('Chưa có hồ sơ thực tế nào để xuất CSV.', 'default');
      return;
    }

    const headers = [
      'Ma_Ho_So',
      'Muc_Do_Rui_Ro',
      'Do_Tin_Cay_AI',
      'Phan_Loai',
      'Khoi_Lop',
      'Trang_Thai',
      'Co_Anh_Bang_Chung',
      'So_Tin_Nhan',
      'Trich_Doan_Trong_Tam',
      'Dau_Hieu_AI',
      'Phap_Ly_Tam_Ly',
      'Thoi_Gian_Tiep_Nhan',
    ];

    const rows = tickets.map((t) =>
      [
        t.ticket_code,
        t.risk_level,
        `${t.confidence_score}%`,
        t.category,
        GRADE_META[t.grade_level] || 'Ẩn danh',
        STATUS_META[t.status]?.label || t.status,
        t.has_image ? 'Có ảnh' : 'Không',
        t.message_count ?? 0,
        t.evidence_excerpt || '',
        t.detected_signals || '',
        t.legal_psych_impact || '',
        formatDateTime(t.created_at),
      ]
        .map(csvEscapeCell)
        .join(',')
    );

    const csvContent = `\uFEFF${headers.join(',')}\r\n${rows.join('\r\n')}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `safeschool-bao-cao-an-danh-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Đã xuất ${tickets.length} hồ sơ ẩn danh ra file CSV.`, 'success');
  }

  function printCounselorReport() {
    const container = document.getElementById('print-report-summary');
    if (container) {
      container.textContent = '';
      const header = document.createElement('div');
      header.className = 'print-report-header';

      const title = document.createElement('h2');
      title.textContent = 'BÁO CÁO TỔNG HỢP AN TOÀN MẠNG HỌC ĐƯỜNG (ẨN DANH 100%)';

      const subtitle = document.createElement('p');
      subtitle.textContent = `Đơn vị: Trường THPT Tôn Đức Thắng, xã Tà Lài, tỉnh Đồng Nai · Ngày lập: ${formatDateTime(
        new Date().toISOString()
      )} · Hệ thống SafeSchool AI (Team Victer - DNT)`;

      header.append(title, subtitle);
      container.appendChild(header);

      const tickets = state.lastDashboardTickets || [];
      if (tickets.length === 0) {
        const emptyP = document.createElement('p');
        emptyP.textContent = 'Hiện chưa có hồ sơ thực tế nào trong cơ sở dữ liệu.';
        container.appendChild(emptyP);
      } else {
        const table = document.createElement('table');
        table.className = 'print-report-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const col of ['Mã HS', 'Mức độ', 'Phân loại hành vi', 'Khối', 'Trạng thái', 'Dấu hiệu & Trích đoạn', 'Thời gian']) {
          const th = document.createElement('th');
          th.textContent = col;
          headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const t of tickets) {
          const tr = document.createElement('tr');
          const cells = [
            t.ticket_code,
            RISK_META[t.risk_level]?.label || t.risk_level,
            `${t.category} (${t.confidence_score}%)`,
            GRADE_META[t.grade_level] || 'Ẩn danh',
            STATUS_META[t.status]?.label || t.status,
            t.evidence_excerpt ? `"${t.evidence_excerpt}" — ${t.detected_signals}` : t.detected_signals,
            formatDateTime(t.created_at),
          ];
          for (const val of cells) {
            const td = document.createElement('td');
            td.textContent = String(val || '');
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);
      }
    }
    window.print();
  }

  function handleCounselorLogout(notify = true) {
    state.counselorToken = null;
    state.selectedCounselorCode = null;
    sessionStorage.removeItem(STORAGE_COUNSELOR_TOKEN);
    renderCounselorView();
    if (notify) {
      showToast('Đã đăng xuất khỏi Góc Tổ Tư vấn.', 'default');
    }
  }

  function renderCounselorView() {
    const authGate = document.getElementById('counselor-auth-gate');
    const dashboard = document.getElementById('counselor-dashboard');
    const isLoggedIn = Boolean(state.counselorToken);

    authGate.hidden = isLoggedIn;
    dashboard.hidden = !isLoggedIn;

    if (isLoggedIn) {
      refreshCounselorDashboard();
    }
  }

  function initCounselor() {
    const pinDialog = document.getElementById('counselor-pin-dialog');
    const loginForm = document.getElementById('counselor-login-form');
    const pinInput = document.getElementById('counselor-pin-input');
    const pinErr = document.getElementById('pin-login-error');
    const pinSubmit = document.getElementById('btn-pin-submit');

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      setInlineAlert(pinErr, '');
      const pin = pinInput.value.trim();
      if (!pin) {
        setInlineAlert(pinErr, 'Vui lòng nhập mã PIN.');
        pinInput.focus();
        return;
      }

      pinSubmit.disabled = true;
      try {
        const res = await apiFetch('/api/counselor/login', {
          method: 'POST',
          body: JSON.stringify({ pin }),
        });
        state.counselorToken = res.token;
        sessionStorage.setItem(STORAGE_COUNSELOR_TOKEN, res.token);
        pinInput.value = '';
        pinDialog.close('authenticated');
        renderCounselorView();
        showToast('Đăng nhập Góc Tổ Tư vấn thành công.', 'success');
      } catch (err) {
        setInlineAlert(pinErr, err.message);
        pinInput.select();
      } finally {
        pinSubmit.disabled = false;
      }
    });

    document.getElementById('btn-refresh-dashboard').addEventListener('click', () => {
      refreshCounselorDashboard();
      showToast('Đã đồng bộ dữ liệu thực từ SQLite.', 'default');
    });

    document.getElementById('btn-counselor-logout').addEventListener('click', () => {
      handleCounselorLogout(true);
    });

    document.getElementById('btn-export-csv')?.addEventListener('click', () => {
      exportCounselorCsv();
    });

    document.getElementById('btn-print-report')?.addEventListener('click', () => {
      printCounselorReport();
    });

    for (const chip of document.querySelectorAll('.filter-chip')) {
      chip.addEventListener('click', () => {
        for (const c of document.querySelectorAll('.filter-chip')) {
          c.classList.remove('is-active');
        }
        chip.classList.add('is-active');
        state.counselorFilterStatus = chip.getAttribute('data-status') || '';
        refreshCounselorDashboard();
      });
    }

    document.getElementById('btn-cd-view-image').addEventListener('click', () => {
      openLightbox(document.getElementById('cd-evidence-img').src);
    });

    const statusSelect = document.getElementById('cd-status-select');
    statusSelect.addEventListener('change', async () => {
      if (!state.selectedCounselorCode) return;
      try {
        await apiFetch(
          `/api/counselor/tickets/${encodeURIComponent(state.selectedCounselorCode)}/status`,
          {
            method: 'PATCH',
            counselorAuth: true,
            body: JSON.stringify({ status: statusSelect.value }),
          }
        );
        showToast('Đã cập nhật trạng thái xử lý hồ sơ.', 'success');
        await refreshCounselorDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    const replyForm = document.getElementById('counselor-reply-form');
    const replyInput = document.getElementById('counselor-reply-input');
    const replyBtn = document.getElementById('btn-counselor-reply');

    attachImeSafeEnter(replyInput, replyForm);

    replyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.selectedCounselorCode) return;
      const content = replyInput.value.trim();
      if (!content) return;

      replyBtn.disabled = true;
      try {
        await apiFetch(
          `/api/counselor/tickets/${encodeURIComponent(state.selectedCounselorCode)}/messages`,
          {
            method: 'POST',
            counselorAuth: true,
            body: JSON.stringify({ content }),
          }
        );
        replyInput.value = '';
        await refreshCounselorDashboard();
        showToast('Đã gửi phản hồi ẩn danh tới học sinh.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        replyBtn.disabled = false;
        replyInput.focus();
      }
    });
  }

  // ==================== INTERACTIVE SPOTLIGHT ONBOARDING TOUR ====================
  const TOUR_STEPS = [
    {
      targetId: 'tour-target-input-area',
      mode: 'student',
      tab: 'analyzer',
      title: 'Nhập nội dung & ảnh chụp màn hình',
      description:
        'Dán đoạn tin nhắn, bình luận gây tổn thương vào khung nhập liệu hoặc tải lên, kéo thả hay nhấn Ctrl+V để dán trực tiếp ảnh chụp màn hình đoạn chat.',
      example:
        'Ví dụ: Dán đoạn tin nhắn bị chế giễu ngoại hình trên nhóm lớp hoặc ảnh chụp màn hình bình luận ác ý.',
    },
    {
      targetId: 'btn-analyze-submit',
      mode: 'student',
      tab: 'analyzer',
      title: 'Phân tích & sơ cứu tâm lý tức thì bằng AI',
      description:
        'Bấm nút gửi để Gemini AI đánh giá mức độ rủi ro (Thấp đến Khẩn cấp), chỉ ra dấu hiệu bắt nạt mạng và cung cấp lời khuyên trấn an cùng 3–4 bước hành động bảo vệ.',
      example:
        'Ví dụ: Nhấn “Phân tích & Sơ cứu ngay” để nhận hướng dẫn lưu bằng chứng hợp lệ và cách chặn/báo cáo an toàn.',
    },
    {
      targetId: 'anonymous-handoff-section',
      mode: 'student',
      tab: 'analyzer',
      title: 'Cổng gửi báo cáo ẩn danh tới Tổ Tư vấn',
      description:
        'Cam kết bảo mật 100% Zero-Identity: hệ thống không thu thập họ tên, lớp cụ thể, số điện thoại hay IP. Sau khi gửi, bạn nhận ngay một Mã Hồ Sơ Ẩn Danh (SH-XXXXXX).',
      example:
        'Ví dụ: Lưu lại mã SH-482910 để theo dõi phản hồi của thầy cô mà không ai biết bạn là ai.',
    },
    {
      targetId: 'tab-tracker',
      mode: 'student',
      tab: 'analyzer',
      title: 'Tab Tra cứu Phản hồi & Nhắn tin 2 chiều',
      description:
        'Mở tab Tra cứu Phản hồi để nhập mã SH-XXXXXX đã lưu, kiểm tra trạng thái tiếp nhận, đọc lời khuyên từ Tổ Tư vấn Tâm lý và nhắn tin trao đổi tiếp hoàn toàn ẩn danh.',
      example:
        'Ví dụ: Nhập mã SH-482910 vào ô tra cứu bất cứ lúc nào để đọc phản hồi mới nhất từ Thầy/Cô Tổ Tư vấn.',
    },
    {
      targetId: 'tour-target-header-controls',
      mode: 'student',
      tab: null,
      title: 'Chế độ Tổ Tư vấn & Giao diện Sáng / Tối',
      description:
        'Nút Góc Tổ Tư vấn dành cho Thầy/Cô đăng nhập mã PIN tiếp nhận danh sách cảnh báo theo mức độ ưu tiên. Bên cạnh là nút Mặt trời / Mặt trăng để chuyển chế độ Sáng / Tối bảo vệ mắt.',
      example:
        'Ví dụ: Bấm biểu tượng Mặt trăng để bật nền tối dịu mắt vào buổi tối, hoặc chọn Góc Tổ Tư vấn để kiểm thử phân hệ giáo viên.',
    },
  ];

  function buildCutoutClipPath(rect, pad, radius) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const l = Math.max(4, rect.left - pad);
    const t = Math.max(4, rect.top - pad);
    const r = Math.min(vw - 4, rect.right + pad);
    const b = Math.min(vh - 4, rect.bottom + pad);
    const rad = Math.max(0, Math.min(radius, (r - l) / 2, (b - t) / 2));

    const pts = [];
    const pushArc = (cx, cy, startDeg, endDeg, steps = 5) => {
      for (let i = 0; i <= steps; i += 1) {
        const angle = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180;
        pts.push(`${(cx + rad * Math.cos(angle)).toFixed(1)}px ${(cy + rad * Math.sin(angle)).toFixed(1)}px`);
      }
    };

    // Vòng ngoài theo chiều kim đồng hồ
    pts.push('0px 0px', `${vw}px 0px`, `${vw}px ${vh}px`, `0px ${vh}px`, '0px 0px');
    // Lỗ khoét bo góc ngược chiều kim đồng hồ để dùng quy tắc evenodd
    pushArc(l + rad, t + rad, 270, 180);
    pushArc(l + rad, b - rad, 180, 90);
    pushArc(r - rad, b - rad, 90, 0);
    pushArc(r - rad, t + rad, 0, -90);
    pts.push(`${(l + rad).toFixed(1)}px ${t.toFixed(1)}px`);

    return {
      clipPath: `polygon(evenodd, ${pts.join(', ')})`,
      box: { left: l, top: t, width: r - l, height: b - t, radius: rad },
    };
  }

  function initSpotlightTour() {
    const backdrop = document.getElementById('tour-backdrop');
    const ring = document.getElementById('tour-spotlight-ring');
    const tooltip = document.getElementById('tour-tooltip');
    const counterEl = document.getElementById('tour-step-counter');
    const titleEl = document.getElementById('tour-step-title');
    const descEl = document.getElementById('tour-step-desc');
    const exampleEl = document.getElementById('tour-step-example');
    const dotsEl = document.getElementById('tour-dots');
    const prevBtn = document.getElementById('btn-tour-prev');
    const nextBtn = document.getElementById('btn-tour-next');
    const finishBtn = document.getElementById('btn-tour-finish');
    const skipBtn = document.getElementById('btn-tour-skip');
    const startBtn = document.getElementById('btn-start-tour');

    if (!backdrop || !ring || !tooltip) return;

    const tourState = {
      active: false,
      stepIndex: 0,
      rafHandle: 0,
      previousFocus: null,
    };

    const setBackgroundInert = (isInert) => {
      for (const selector of ['header.site-header', 'main.main-shell', 'footer.site-footer']) {
        const node = document.querySelector(selector);
        if (node) node.inert = isInert;
      }
    };

    const positionTooltipCard = (box) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 14;
      const margin = 12;

      const cardRect = tooltip.getBoundingClientRect();
      const cardW = cardRect.width || Math.min(vw - 24, 410);
      const cardH = cardRect.height || 260;

      const spaceBelow = vh - (box.top + box.height) - margin;
      const spaceAbove = box.top - margin;
      const spaceRight = vw - (box.left + box.width) - margin;
      const spaceLeft = box.left - margin;

      let top;
      let left;

      if (spaceBelow >= cardH + gap) {
        top = box.top + box.height + gap;
        left = box.left;
      } else if (spaceAbove >= cardH + gap) {
        top = box.top - cardH - gap;
        left = box.left;
      } else if (vw >= 900 && spaceRight >= cardW + gap) {
        top = box.top;
        left = box.left + box.width + gap;
      } else if (vw >= 900 && spaceLeft >= cardW + gap) {
        top = box.top;
        left = box.left - cardW - gap;
      } else if (spaceBelow >= spaceAbove) {
        top = Math.min(vh - cardH - margin, box.top + box.height + gap);
        left = (vw - cardW) / 2;
      } else {
        top = Math.max(margin, box.top - cardH - gap);
        left = (vw - cardW) / 2;
      }

      left = Math.max(margin, Math.min(left, vw - cardW - margin));
      top = Math.max(margin, Math.min(top, vh - cardH - margin));

      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    };

    const syncGeometry = () => {
      if (!tourState.active) return;
      const step = TOUR_STEPS[tourState.stepIndex];
      const target = step ? document.getElementById(step.targetId) : null;
      if (!target) return;

      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const computedRadius = parseFloat(window.getComputedStyle(target).borderRadius) || 12;
      const { clipPath, box } = buildCutoutClipPath(rect, 8, Math.max(10, computedRadius));

      backdrop.style.clipPath = clipPath;
      ring.style.left = `${Math.round(box.left)}px`;
      ring.style.top = `${Math.round(box.top)}px`;
      ring.style.width = `${Math.round(box.width)}px`;
      ring.style.height = `${Math.round(box.height)}px`;
      ring.style.borderRadius = `${Math.round(box.radius)}px`;

      positionTooltipCard(box);
    };

    const trackSmoothScroll = (durationMs = 480) => {
      if (tourState.rafHandle) window.cancelAnimationFrame(tourState.rafHandle);
      const start = performance.now();
      const tick = (now) => {
        syncGeometry();
        if (tourState.active && now - start < durationMs) {
          tourState.rafHandle = window.requestAnimationFrame(tick);
        } else {
          tourState.rafHandle = 0;
        }
      };
      tourState.rafHandle = window.requestAnimationFrame(tick);
    };

    const renderDots = (activeIdx) => {
      dotsEl.textContent = '';
      TOUR_STEPS.forEach((_, idx) => {
        const dot = document.createElement('span');
        dot.className = `tour-dot${idx === activeIdx ? ' is-active' : ''}`;
        dotsEl.appendChild(dot);
      });
    };

    const goToStep = (idx) => {
      tourState.stepIndex = Math.max(0, Math.min(idx, TOUR_STEPS.length - 1));
      const step = TOUR_STEPS[tourState.stepIndex];

      if (step.mode && state.mode !== step.mode) {
        switchMode(step.mode);
      }
      if (step.tab && state.studentTab !== step.tab) {
        switchStudentTab(step.tab);
      }

      counterEl.textContent = `Bước ${tourState.stepIndex + 1}/${TOUR_STEPS.length}`;
      titleEl.textContent = step.title;
      descEl.textContent = step.description;
      exampleEl.textContent = step.example;
      renderDots(tourState.stepIndex);

      const isFirst = tourState.stepIndex === 0;
      const isLast = tourState.stepIndex === TOUR_STEPS.length - 1;
      prevBtn.hidden = isFirst;
      nextBtn.hidden = isLast;
      finishBtn.hidden = !isLast;

      const target = document.getElementById(step.targetId);
      if (target) {
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({
          behavior: reducedMotion ? 'auto' : 'smooth',
          block: 'center',
          inline: 'nearest',
        });
      }

      syncGeometry();
      trackSmoothScroll(500);
      announceSR(`Hướng dẫn bước ${tourState.stepIndex + 1} trên ${TOUR_STEPS.length}: ${step.title}`);
    };

    const closeTour = (markCompleted = true) => {
      if (!tourState.active) return;
      tourState.active = false;
      if (tourState.rafHandle) {
        window.cancelAnimationFrame(tourState.rafHandle);
        tourState.rafHandle = 0;
      }

      backdrop.hidden = true;
      ring.hidden = true;
      tooltip.hidden = true;
      setBackgroundInert(false);

      document.removeEventListener('keydown', onTourKeydown);
      window.removeEventListener('scroll', syncGeometry, true);
      window.removeEventListener('resize', syncGeometry);

      if (markCompleted) {
        try {
          localStorage.setItem(STORAGE_TOUR_DONE, '1');
        } catch {
          // Bỏ qua nếu trình duyệt chặn lưu localStorage
        }
      }

      if (tourState.previousFocus && typeof tourState.previousFocus.focus === 'function') {
        tourState.previousFocus.focus();
      }
      announceSR('Đã đóng hướng dẫn sử dụng.');
    };

    const onTourKeydown = (e) => {
      if (!tourState.active) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTour(true);
        return;
      }
      if (e.key === 'Tab') {
        const focusables = Array.from(
          tooltip.querySelectorAll('button:not([hidden]):not(:disabled)')
        );
        if (focusables.length > 0) {
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    const startTour = (startAt = 0) => {
      // Đóng bất kỳ modal <dialog> nào đang mở để tránh xung đột tiêu điểm
      for (const dialog of document.querySelectorAll('dialog[open]')) {
        dialog.close();
      }

      tourState.previousFocus = document.activeElement;
      tourState.active = true;

      backdrop.hidden = false;
      ring.hidden = false;
      tooltip.hidden = false;
      setBackgroundInert(true);

      document.addEventListener('keydown', onTourKeydown);
      window.addEventListener('scroll', syncGeometry, true);
      window.addEventListener('resize', syncGeometry);

      goToStep(startAt);
      const focusTarget = tourState.stepIndex === TOUR_STEPS.length - 1 ? finishBtn : nextBtn;
      window.setTimeout(() => focusTarget?.focus({ preventScroll: true }), 60);
    };

    prevBtn.addEventListener('click', () => {
      if (tourState.stepIndex > 0) goToStep(tourState.stepIndex - 1);
    });
    nextBtn.addEventListener('click', () => {
      if (tourState.stepIndex < TOUR_STEPS.length - 1) goToStep(tourState.stepIndex + 1);
    });
    finishBtn.addEventListener('click', () => closeTour(true));
    skipBtn.addEventListener('click', () => closeTour(true));
    backdrop.addEventListener('click', () => closeTour(true));

    if (startBtn) {
      startBtn.addEventListener('click', () => startTour(0));
    }

    // Tự động mở hướng dẫn nếu là lần truy cập đầu tiên
    let tourAlreadySeen = false;
    try {
      tourAlreadySeen = localStorage.getItem(STORAGE_TOUR_DONE) === '1';
    } catch {
      tourAlreadySeen = false;
    }
    if (!tourAlreadySeen) {
      window.setTimeout(() => {
        if (!document.querySelector('dialog[open]')) {
          startTour(0);
        }
      }, 420);
    }
  }

  // ==================== BOOTSTRAP ====================
  document.addEventListener('DOMContentLoaded', () => {
    initThemeToggle();
    initModernWebFallbacks();
    initNavigation();
    initImageDropzone();
    initBreathingGuide();
    initAnalyzer();
    initTracker();
    initChat();
    initCounselor();
    refreshIcons();
    loadServerConfig();
    initSpotlightTour();
  });
})();
