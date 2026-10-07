/* ========================================================
   UMOLKTERM APPLICATION CORE
   ======================================================== */

// Редірект на логін при втраті сесії
const _origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401 && !String(args[0]).includes('/api/login')) {
    location.href = '/login';
  }
  return res;
};

const IS_MOBILE = window.matchMedia('(max-width: 820px)').matches;
// Іконки prompt (Nerd Font) завжди додаються як fallback
const withSymbols = (family) => `${family.replace(/,?\s*monospace\s*$/, '')}, 'UmolkSymbols', monospace`;

// Dracula Terminal Palette
const DRACULA_XTERM_THEME = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: '#383a4c',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff'
};

class DraculaTerminalApp {
  constructor() {
    this.tabs = new Map();
    this.activeTabId = null;
    this.tabCounter = 0;
    this.savedConnections = [];
    this.settings = {
      fontSize: 12,
      fontFamily: "'JetBrains Mono'",
      aiModel: 'auto'
    };

    // DOM Elements
    this.tabsListEl = document.getElementById('tabs-list');
    this.terminalsContainerEl = document.getElementById('terminals-container');
    this.hostsContainerEl = document.getElementById('hosts-container');
    this.inputSearchHosts = document.getElementById('input-search-hosts');
    this.newTabMenu = document.getElementById('new-tab-menu');
    this.aiDrawer = document.getElementById('ai-drawer');

    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.loadSettings();
    await this.loadKeys();
    await this.loadConnections();

    // Дочекатись шрифтів, інакше xterm міряє клітинки по fallback-шрифту (і з'являються квадрати)
    try {
      await document.fonts.ready;
      await Promise.all([
        document.fonts.load("400 15px 'JetBrains Mono'"),
        document.fonts.load("700 15px 'JetBrains Mono'"),
        document.fonts.load("15px 'UmolkSymbols'")
      ]);
    } catch (e) {}

    if (IS_MOBILE) document.getElementById('sidebar').classList.add('collapsed');

    // Open default initial Local Zsh tab
    this.createTab({ type: 'local', title: 'Local ZSH' });

    // Handle window resize
    window.addEventListener('resize', () => this.fitActiveTerminal());
    if (window.visualViewport) {
      const updateVV = () => {
        document.documentElement.style.setProperty('--vv-height', `${window.visualViewport.height}px`);
        this.fitActiveTerminal();
      };
      window.visualViewport.addEventListener('resize', updateVV);
      updateVV();
    }
    new ResizeObserver(() => this.fitActiveTerminal()).observe(this.terminalsContainerEl);
    document.fonts.ready.then(() => this.applySettings());
  }

  // ================= MOBILE HELPERS =================

  isMobile() {
    return window.matchMedia('(max-width: 820px)').matches;
  }

  setSidebar(open) {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed', !open);
    document.getElementById('sidebar-backdrop').classList.toggle('hidden', !(open && this.isMobile()));
    setTimeout(() => this.fitActiveTerminal(), 300);
  }

  // Sticky Ctrl з екранної клавіатури
  transformInput(data) {
    const ctrlBtn = document.getElementById('key-ctrl');
    if (ctrlBtn && ctrlBtn.classList.contains('on') && data.length === 1) {
      const c = data.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) {
        ctrlBtn.classList.remove('on');
        return String.fromCharCode(c - 64);
      }
    }
    return data;
  }

  sendRaw(data) {
    const tab = this.tabs.get(this.activeTabId);
    if (tab && tab.socket.readyState === WebSocket.OPEN) {
      tab.socket.send(JSON.stringify({ type: 'input', data: this.transformInput(data) }));
    }
  }

  setupKeyBar() {
    const KEYS = {
      esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B',
      right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F'
    };
    document.querySelectorAll('#key-bar button').forEach(btn => {
      // не забираємо фокус у терміналу, щоб клавіатура не зникала
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        if (key === 'ctrl') {
          btn.classList.toggle('on');
        } else if (key === 'paste') {
          try { this.sendRaw(await navigator.clipboard.readText()); } catch (e) {}
        } else if (key === 'paste-run') {
          try { 
            const text = await navigator.clipboard.readText();
            this.sendRaw(text + '\r');
          } catch (e) {}
        } else if (key) {
          this.sendRaw(KEYS[key]);
        } else if (btn.dataset.seq) {
          this.sendRaw(btn.dataset.seq);
        }
        const tab = this.tabs.get(this.activeTabId);
        if (tab) tab.term.focus();
      });
    });
  }

  // ================= TAB MANAGEMENT =================

  createTab({ type = 'local', title = 'Terminal', connId = null, hostInfo = null }) {
    this.tabCounter++;
    const tabId = `tab-${Date.now()}-${this.tabCounter}`;

    // 1. Create Tab Header Item
    const tabItem = document.createElement('div');
    tabItem.className = 'tab-item';
    tabItem.id = `header-${tabId}`;
    tabItem.innerHTML = `
      <span class="tab-status-dot connecting"></span>
      <i class="fa-solid ${type === 'local' ? 'fa-terminal text-purple' : 'fa-server text-cyan'}"></i>
      <span class="tab-title">${this.escapeHtml(title)}</span>
      <i class="fa-solid fa-xmark tab-close" title="Закрити вкладку"></i>
    `;

    tabItem.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        this.closeTab(tabId);
      } else {
        this.switchTab(tabId);
      }
    });

    this.tabsListEl.appendChild(tabItem);

    // 2. Create Terminal Wrapper Container
    const termWrapper = document.createElement('div');
    termWrapper.className = 'term-instance-wrapper';
    termWrapper.id = `wrapper-${tabId}`;
    this.terminalsContainerEl.appendChild(termWrapper);

    // 3. Initialize XTerm.js Instance
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: this.settings.fontSize,
      fontFamily: withSymbols(this.settings.fontFamily),
      lineHeight: 1.25,
      theme: DRACULA_XTERM_THEME,
      allowTransparency: true,
      convertEol: true,
      scrollback: 5000
    });

    const FitAddonClass = window.FitAddon?.FitAddon || window.FitAddon;
    const fitAddon = FitAddonClass ? new FitAddonClass() : null;
    if (fitAddon) {
      term.loadAddon(fitAddon);
    }

    const WebLinksAddonClass = window.WebLinksAddon?.WebLinksAddon || window.WebLinksAddon;
    if (WebLinksAddonClass) {
      term.loadAddon(new WebLinksAddonClass());
    }

    term.open(termWrapper);

    // 4. WebSocket setup
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/terminal?type=${type}`;
    if (connId) {
      wsUrl += `&id=${encodeURIComponent(connId)}`;
    } else if (hostInfo && hostInfo.ticket) {
      wsUrl += `&ticket=${encodeURIComponent(hostInfo.ticket)}`;
    }

    const socket = new WebSocket(wsUrl);

    const tabRecord = {
      id: tabId,
      type,
      title,
      connId,
      term,
      fitAddon,
      socket,
      wrapperEl: termWrapper,
      headerEl: tabItem
    };

    this.tabs.set(tabId, tabRecord);

    // Terminal Input -> WebSocket
    term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data: this.transformInput(data) }));
      }
    });

    // Resize -> WebSocket
    term.onResize((size) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });

    // WebSocket events
    socket.onopen = () => {
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }, 50);
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data') {
          term.write(msg.data);
        } else if (msg.type === 'status') {
          term.write(msg.message);
        } else if (msg.type === 'connected') {
          this.setTabStatus(tabId, 'connected');
          if (msg.title) {
            tabItem.querySelector('.tab-title').textContent = msg.title;
          }
        } else if (msg.type === 'error') {
          this.setTabStatus(tabId, 'disconnected');
          term.write(`\r\n\x1b[38;2;255;85;85m[Помилка]\x1b[0m ${msg.message}\r\n`);
        } else if (msg.type === 'exit') {
          this.setTabStatus(tabId, 'disconnected');
          term.write(`\r\n\x1b[38;2;98;114;164m[Сесію завершено]\x1b[0m\r\n`);
        }
      } catch (e) {
        term.write(event.data);
      }
    };

    socket.onclose = () => {
      this.setTabStatus(tabId, 'disconnected');
    };

    socket.onerror = () => {
      this.setTabStatus(tabId, 'disconnected');
    };

    // Switch to new tab
    this.switchTab(tabId);
    if (this.isMobile()) this.setSidebar(false);
    return tabId;
  }

  switchTab(tabId) {
    if (!this.tabs.has(tabId)) return;

    this.tabs.forEach((t) => {
      t.headerEl.classList.remove('active');
      t.wrapperEl.classList.remove('active');
    });

    const activeTab = this.tabs.get(tabId);
    activeTab.headerEl.classList.add('active');
    activeTab.wrapperEl.classList.add('active');
    this.activeTabId = tabId;

    setTimeout(() => {
      if (activeTab.fitAddon) activeTab.fitAddon.fit();
      activeTab.term.focus();
    }, 20);
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    try {
      if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
        tab.socket.close();
      }
    } catch(e) {}

    try {
      tab.term.dispose();
    } catch(e) {}

    tab.headerEl.remove();
    tab.wrapperEl.remove();
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        // If all closed, open a new local zsh
        this.createTab({ type: 'local', title: 'Local ZSH' });
      }
    }
  }

  setTabStatus(tabId, status) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const dot = tab.headerEl.querySelector('.tab-status-dot');
    if (dot) {
      dot.className = `tab-status-dot ${status}`;
    }
  }

  fitActiveTerminal() {
    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab.fitAddon) tab.fitAddon.fit();
      if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
        tab.socket.send(JSON.stringify({ type: 'resize', cols: tab.term.cols, rows: tab.term.rows }));
      }
    }
  }

  sendToActiveTerminal(text, execute = false) {
    if (!this.activeTabId || !this.tabs.has(this.activeTabId)) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
      const payload = execute ? `${text}\n` : text;
      tab.socket.send(JSON.stringify({ type: 'input', data: payload }));
      tab.term.focus();
    }
  }

  // ================= SSH CONNECTIONS CRUD =================
  
  async loadKeys() {
    try {
      const res = await fetch('/api/keys');
      const data = await res.json();
      if (data.success) {
        this.keys = data.keys || [];
        this.renderKeys();
      }
    } catch (e) {
      console.error('Failed to load keys', e);
    }
  }

  renderKeys() {
    const list = document.getElementById('keyring-list');
    const select = document.getElementById('conn-key-id');
    
    // Select options
    select.innerHTML = '<option value="">-- Оберіть ключ --</option>';
    this.keys.forEach(k => {
      const opt = document.createElement('option');
      opt.value = k.id;
      opt.textContent = k.name;
      select.appendChild(opt);
    });

    // List
    list.innerHTML = '';
    if (this.keys.length === 0) {
      list.innerHTML = '<div class="empty-state">Немає збережених ключів</div>';
      return;
    }
    
    this.keys.forEach(k => {
      const el = document.createElement('div');
      el.className = 'host-item';
      el.innerHTML = `
        <div class="host-info">
          <div class="host-name"><i class="fa-solid fa-key"></i> ${this.escapeHtml(k.name)}</div>
        </div>
        <div class="host-actions">
          <button class="icon-btn text-red btn-delete-key" data-id="${k.id}"><i class="fa-solid fa-trash"></i></button>
        </div>
      `;
      list.appendChild(el);
    });

    list.querySelectorAll('.btn-delete-key').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        if (!confirm('Видалити ключ?')) return;
        const id = e.currentTarget.getAttribute('data-id');
        await fetch(`/api/keys/${id}`, { method: 'DELETE' });
        await this.loadKeys();
      });
    });
  }

  async loadConnections() {
    try {
      const res = await fetch('/api/connections');
      const data = await res.json();
      if (data.success) {
        this.savedConnections = data.connections || [];
        this.renderConnections();
        this.updateNewTabMenu();
      }
    } catch (err) {
      console.error('Failed to load connections:', err);
    }
  }

  renderConnections(filterText = '') {
    const filter = filterText.toLowerCase().trim();
    const filtered = this.savedConnections.filter(c => {
      return !filter || 
        c.name.toLowerCase().includes(filter) || 
        c.host.toLowerCase().includes(filter) || 
        c.username.toLowerCase().includes(filter) ||
        (c.group && c.group.toLowerCase().includes(filter));
    });

    if (filtered.length === 0) {
      this.hostsContainerEl.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-server"></i>
          <p>${filter ? 'Нічого не знайдено' : 'Немає збережених серверів.<br>Натисніть "Додати", щоб зберегти SSH хост.'}</p>
        </div>
      `;
      return;
    }

    this.hostsContainerEl.innerHTML = '';

    filtered.forEach(conn => {
      const card = document.createElement('div');
      card.className = 'host-card';
      card.innerHTML = `
        <div class="host-card-header">
          <div class="host-name">
            <span style="color: ${conn.color || '#bd93f9'}">●</span>
            <span>${this.escapeHtml(conn.name)}</span>
          </div>
          <button class="host-action-btn btn-connect" title="Швидке підключення">
            <i class="fa-solid fa-plug"></i> Connect
          </button>
        </div>
        <div class="host-endpoint">
          ${this.escapeHtml(conn.username)}@${this.escapeHtml(conn.host)}:${conn.port}
        </div>
        <div class="host-card-footer">
          <div class="host-badges">
            <span class="badge badge-group">${this.escapeHtml(conn.group || 'Default')}</span>
            <span class="badge ${conn.authType === 'key' ? 'badge-key' : 'badge-pwd'}">
              ${conn.authType === 'key' ? '🔑 Key' : '🔒 Password'}
            </span>
          </div>
          <div class="host-actions">
            <button class="host-action-btn btn-test" title="Тестувати підключення">
              <i class="fa-solid fa-vial"></i>
            </button>
            <button class="host-action-btn btn-edit" title="Редагувати">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="host-action-btn btn-delete" title="Видалити">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
      `;

      // Connect button
      card.querySelector('.btn-connect').addEventListener('click', (e) => {
        e.stopPropagation();
        this.createTab({
          type: 'ssh',
          title: conn.name,
          connId: conn.id
        });
        if (this.isMobile()) this.setSidebar(false);
      });

      // Card double click -> connect
      card.addEventListener('dblclick', () => {
        this.createTab({
          type: 'ssh',
          title: conn.name,
          connId: conn.id
        });
        if (this.isMobile()) this.setSidebar(false);
      });

      // Test button
      card.querySelector('.btn-test').addEventListener('click', async (e) => {
        e.stopPropagation();
        const testBtn = e.currentTarget;
        testBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
        try {
          const res = await fetch('/api/connections/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: conn.id })
          });
          const d = await res.json();
          alert(d.success ? `✓ ${d.message}` : `✗ ${d.error}`);
        } catch(err) {
          alert(`Помилка тесту: ${err.message}`);
        } finally {
          testBtn.innerHTML = `<i class="fa-solid fa-vial"></i>`;
        }
      });

      // Edit button
      card.querySelector('.btn-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openEditConnectionModal(conn);
      });

      // Delete button
      card.querySelector('.btn-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Видалити підключення "${conn.name}"?`)) {
          await fetch(`/api/connections/${conn.id}`, { method: 'DELETE' });
          await this.loadConnections();
        }
      });

      this.hostsContainerEl.appendChild(card);
    });
  }

  updateNewTabMenu() {
    const container = document.getElementById('menu-ssh-list');
    if (!container) return;
    container.innerHTML = '';

    if (this.savedConnections.length === 0) {
      container.innerHTML = `<div style="padding: 4px 10px; font-size: 11px; color: var(--dracula-comment);">Немає серверів</div>`;
      return;
    }

    this.savedConnections.forEach(conn => {
      const btn = document.createElement('button');
      btn.className = 'dropdown-item';
      btn.innerHTML = `
        <i class="fa-solid fa-server" style="color: ${conn.color || '#bd93f9'}"></i>
        <span>${this.escapeHtml(conn.name)}</span>
      `;
      btn.addEventListener('click', () => {
        this.createTab({
          type: 'ssh',
          title: conn.name,
          connId: conn.id
        });
        this.newTabMenu.classList.add('hidden');
      });
      container.appendChild(btn);
    });
  }

  // ================= MODALS & FORMS =================

  openAddConnectionModal() {
    document.getElementById('modal-conn-title').innerHTML = `<i class="fa-solid fa-server text-purple"></i> Додати SSH підключення`;
    document.getElementById('form-connection').reset();
    document.getElementById('conn-id').value = '';
    document.getElementById('conn-port').value = '22';
    document.getElementById('conn-group').value = 'Servers';
    document.getElementById('group-password').classList.remove('hidden');
    document.getElementById('group-key').classList.add('hidden');
    document.querySelector('input[name="conn-key-source"][value="keyring"]').checked = true;
    document.getElementById('conn-key-keyring-wrapper').classList.remove('hidden');
    document.getElementById('conn-key-text-wrapper').classList.add('hidden');
    document.getElementById('conn-test-status').className = 'status-box hidden';
    document.getElementById('modal-connection').classList.remove('hidden');
  }

  openEditConnectionModal(conn) {
    document.getElementById('modal-conn-title').innerHTML = `<i class="fa-solid fa-pen-to-square text-purple"></i> Редагувати підключення`;
    document.getElementById('conn-id').value = conn.id;
    document.getElementById('conn-name').value = conn.name;
    document.getElementById('conn-host').value = conn.host;
    document.getElementById('conn-port').value = conn.port;
    document.getElementById('conn-user').value = conn.username;
    document.getElementById('conn-group').value = conn.group || 'Servers';
    document.getElementById('conn-notes').value = conn.notes || '';

    const authRadios = document.getElementsByName('conn-auth-type');
    for (const r of authRadios) {
      r.checked = (r.value === conn.authType);
    }

    if (conn.authType === 'key') {
      document.getElementById('group-password').classList.add('hidden');
      document.getElementById('group-key').classList.remove('hidden');
      if (conn.keyId) {
        document.querySelector('input[name="conn-key-source"][value="keyring"]').checked = true;
        document.getElementById('conn-key-id').value = conn.keyId;
        document.getElementById('conn-key-keyring-wrapper').classList.remove('hidden');
        document.getElementById('conn-key-text-wrapper').classList.add('hidden');
      } else {
        document.querySelector('input[name="conn-key-source"][value="text"]').checked = true;
        document.getElementById('conn-key-keyring-wrapper').classList.add('hidden');
        document.getElementById('conn-key-text-wrapper').classList.remove('hidden');
      }
    } else {
      document.getElementById('group-password').classList.remove('hidden');
      document.getElementById('group-key').classList.add('hidden');
      document.querySelector('input[name="conn-key-source"][value="keyring"]').checked = true;
      document.getElementById('conn-key-id').value = '';
      document.getElementById('conn-key-keyring-wrapper').classList.remove('hidden');
      document.getElementById('conn-key-text-wrapper').classList.add('hidden');
    }

    document.getElementById('conn-password').value = '';
    document.getElementById('conn-key').value = '';
    document.getElementById('conn-passphrase').value = '';
    document.getElementById('conn-test-status').className = 'status-box hidden';
    document.getElementById('modal-connection').classList.remove('hidden');
  }

  // ================= SETTINGS =================

  async loadSettings() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.success) {
        this.settings = { ...this.settings, ...data.settings };
        this.applySettings();
      }
    } catch (e) {
      console.error(e);
    }
  }

  applySettings() {
    document.getElementById('setting-font-size').value = this.settings.fontSize;
    document.getElementById('font-size-val').textContent = this.settings.fontSize;
    const famSel = document.getElementById('setting-font-family');
    const known = Array.from(famSel.options).some(o => o.value === this.settings.fontFamily);
    famSel.value = known ? this.settings.fontFamily : famSel.options[0].value;
    document.getElementById('select-ai-model').value = this.settings.aiModel || 'auto';
    document.getElementById('setting-voice-lang').value = this.settings.voiceLang || 'uk-UA';

    // Apply to existing open terminals
    this.tabs.forEach(t => {
      t.term.options.fontSize = this.settings.fontSize;
      t.term.options.fontFamily = withSymbols(this.settings.fontFamily);
      t.fitAddon.fit();
    });
  }

  // ================= AI COPILOT =================

  async askAI(prompt) {
    if (!prompt.trim()) return;

    const chatBody = document.getElementById('ai-chat-body');
    const model = document.getElementById('select-ai-model').value;

    // Render User message
    const userMsg = document.createElement('div');
    userMsg.className = 'ai-message user';
    userMsg.innerHTML = `<p>${this.escapeHtml(prompt)}</p>`;
    chatBody.appendChild(userMsg);

    // Render loading indicator
    const loadingMsg = document.createElement('div');
    loadingMsg.className = 'ai-message loading';
    loadingMsg.innerHTML = `<p><i class="fa-solid fa-spinner fa-spin text-pink"></i> Аналізую команду для Linux/ZSH...</p>`;
    chatBody.appendChild(loadingMsg);
    chatBody.scrollTop = chatBody.scrollHeight;

    try {
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, model })
      });
      const data = await res.json();

      loadingMsg.remove();

      const aiMsg = document.createElement('div');
      aiMsg.className = 'ai-message assistant';

      if (data.success) {
        aiMsg.innerHTML = `
          <div class="msg-header">
            <span class="badge badge-purple">${data.source || 'AI Assistant'}</span>
          </div>
          <p>${this.escapeHtml(data.explanation || '')}</p>
          ${data.warning ? `<p class="text-orange mt-2"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(data.warning)}</p>` : ''}
          <div class="ai-command-box">
            <div class="ai-command-text">${this.escapeHtml(data.command)}</div>
            <div class="ai-cmd-actions">
              <button class="btn-cmd-action btn-copy" title="Скопіювати команду">
                <i class="fa-solid fa-copy"></i> Копіювати
              </button>
              <button class="btn-cmd-action btn-insert" title="Вставити в активний термінал">
                <i class="fa-solid fa-terminal"></i> Вставити
              </button>
              <button class="btn-cmd-action btn-execute" title="Виконати негайно">
                <i class="fa-solid fa-bolt text-yellow"></i> Виконати
              </button>
            </div>
          </div>
          ${data.hint ? `<p class="text-comment mt-2" style="font-size: 11px;">${this.escapeHtml(data.hint)}</p>` : ''}
        `;

        // Action bindings
        aiMsg.querySelector('.btn-copy').addEventListener('click', () => {
          navigator.clipboard.writeText(data.command);
          alert('Команду скопійовано в буфер обміну!');
        });

        aiMsg.querySelector('.btn-insert').addEventListener('click', () => {
          this.sendToActiveTerminal(data.command, false);
        });

        aiMsg.querySelector('.btn-execute').addEventListener('click', () => {
          this.sendToActiveTerminal(data.command, true);
        });

      } else {
        aiMsg.innerHTML = `<p class="text-red"><i class="fa-solid fa-circle-exclamation"></i> Помилка: ${this.escapeHtml(data.error || 'Не вдалося обробити запит')}</p>`;
      }

      chatBody.appendChild(aiMsg);
      chatBody.scrollTop = chatBody.scrollHeight;

    } catch (err) {
      loadingMsg.remove();
      const errorMsg = document.createElement('div');
      errorMsg.className = 'ai-message error';
      errorMsg.innerHTML = `<p class="text-red">Мережева помилка: ${this.escapeHtml(err.message)}</p>`;
      chatBody.appendChild(errorMsg);
    }
  }


  // ================= ГОЛОСОВІ КОМАНДИ =================

  setupVoice() {
    this.voice = { active: false, mode: null, recorder: null, stream: null, chunks: [], recognition: null, cmd: '', timer: null };
    this.$ = (id) => document.getElementById(id);

    this.$('btn-mic').addEventListener('click', () => {
      if (this.voice.active) this.stopVoice();
      else this.startVoice();
    });
    this.$('voice-close').addEventListener('click', () => this.cancelVoice());
    this.$('voice-retry').addEventListener('click', () => this.startVoice());
    this.$('voice-insert').addEventListener('click', () => {
      if (!this.voice.cmd) return;
      this.sendToActiveTerminal(this.voice.cmd, false);
      this.cancelVoice();
    });
    this.$('voice-run').addEventListener('click', () => {
      const cmd = this.voice.cmd;
      if (!cmd) return;
      if (this.isDangerous(cmd) && !confirm(`⚠️ Потенційно небезпечна команда:\n\n${cmd}\n\nТочно виконати?`)) return;
      this.sendToActiveTerminal(cmd, true);
      this.cancelVoice();
    });
  }

  isDangerous(cmd) {
    return /\b(rm\s+(-[a-z]*\s+)*-[a-z]*r|mkfs|dd\s+if=|shutdown|reboot|poweroff|halt\b|wipefs|fdisk|parted|userdel|passwd|iptables\s+-F|chmod\s+-R|chown\s+-R)|:\(\)\s*\{|>\s*\/dev\/(sd|nvme)/i.test(cmd);
  }

  showVoicePanel(state, { rec = false, transcript = null, keepResult = false } = {}) {
    this.$('voice-panel').classList.remove('hidden');
    const st = this.$('voice-state');
    st.textContent = state;
    st.classList.toggle('rec', rec);
    if (transcript !== null) this.$('voice-transcript').textContent = transcript;
    if (!keepResult) this.$('voice-result').classList.add('hidden');
  }

  async startVoice() {
    this.cleanupVoice();
    this.voice.cmd = '';

    if (!window.isSecureContext || !navigator.mediaDevices) {
      this.showVoicePanel('⚠️ Мікрофон недоступний', {
        transcript: `Браузер дозволяє мікрофон лише на HTTPS. Відкрийте https://${location.host} і прийміть самопідписаний сертифікат.`
      });
      return;
    }

    const lang = this.settings.voiceLang || 'uk-UA';
    const useWhisper = Boolean(this.settings.hasOpenaiKey) && window.MediaRecorder;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!useWhisper && !SR) {
      this.showVoicePanel('⚠️ Розпізнавання не підтримується', {
        transcript: 'Додайте OpenAI API Key в налаштуваннях (Whisper) або використайте Chrome/Edge/Safari.'
      });
      return;
    }

    try {
      if (useWhisper) await this.startWhisper();
      else this.startBrowserRecognition(SR, lang);
    } catch (e) {
      this.voice.active = false;
      this.$('btn-mic').classList.remove('recording');
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      this.showVoicePanel('⚠️ Немає доступу до мікрофона', {
        transcript: denied ? 'Дозвольте доступ до мікрофона для цього сайту в налаштуваннях браузера.' : String(e.message || e)
      });
    }
  }

  async startWhisper() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.voice = { ...this.voice, active: true, mode: 'whisper', recorder: rec, stream, chunks: [] };

    rec.ondataavailable = (e) => { if (e.data && e.data.size) this.voice.chunks.push(e.data); };
    rec.onstop = async () => {
      const chunks = this.voice.chunks;
      const type = rec.mimeType || 'audio/webm';
      this.releaseStream();
      if (!this.voice.mode) return; // скасовано
      if (!chunks.length) { this.showVoicePanel('Нічого не записано'); return; }
      this.showVoicePanel('🧠 Розпізнаю (Whisper)…', { transcript: '' });
      try {
        const res = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': type },
          body: new Blob(chunks, { type })
        });
        const d = await res.json();
        if (!d.success) throw new Error(d.error || 'Помилка розпізнавання');
        this.handleTranscript(d.text);
      } catch (e) {
        this.showVoicePanel('⚠️ Помилка розпізнавання', { transcript: e.message });
      }
    };

    rec.start();
    this.$('btn-mic').classList.add('recording');
    this.showVoicePanel('🎙 Слухаю… натисніть мікрофон, щоб завершити', { rec: true, transcript: '' });
    this.voice.timer = setTimeout(() => this.stopVoice(), 60000);
  }

  startBrowserRecognition(SR, lang) {
    const r = new SR();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = '';
    let handled = false;
    this.voice = { ...this.voice, active: true, mode: 'browser', recognition: r };

    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      this.$('voice-transcript').textContent = (finalText + interim).trim();
    };
    r.onerror = (e) => {
      handled = true;
      this.endVoiceUi();
      const msg = e.error === 'not-allowed' ? 'Дозвольте доступ до мікрофона в налаштуваннях браузера.'
        : e.error === 'no-speech' ? 'Мовлення не почуто. Спробуйте ще раз.'
        : `Помилка: ${e.error}`;
      this.showVoicePanel('⚠️ Не вдалося розпізнати', { transcript: msg });
    };
    r.onend = () => {
      this.endVoiceUi();
      if (handled || !this.voice.mode) return;
      handled = true;
      if (finalText.trim()) this.handleTranscript(finalText.trim());
      else this.showVoicePanel('Мовлення не почуто', { transcript: 'Спробуйте ще раз.' });
    };

    r.start();
    this.$('btn-mic').classList.add('recording');
    this.showVoicePanel('🎙 Слухаю… говоріть', { rec: true, transcript: '' });
  }

  stopVoice() {
    clearTimeout(this.voice.timer);
    this.$('btn-mic').classList.remove('recording');
    if (this.voice.mode === 'whisper' && this.voice.recorder && this.voice.recorder.state !== 'inactive') {
      this.voice.active = false;
      this.voice.recorder.stop();
    } else if (this.voice.mode === 'browser' && this.voice.recognition) {
      this.voice.recognition.stop();
    }
  }

  endVoiceUi() {
    this.voice.active = false;
    this.$('btn-mic').classList.remove('recording');
  }

  releaseStream() {
    if (this.voice.stream) {
      this.voice.stream.getTracks().forEach(t => t.stop());
      this.voice.stream = null;
    }
  }

  cleanupVoice() {
    clearTimeout(this.voice.timer);
    const v = this.voice;
    v.mode = null;
    try { if (v.recognition) { v.recognition.onend = null; v.recognition.onerror = null; v.recognition.abort(); } } catch (e) {}
    try { if (v.recorder && v.recorder.state !== 'inactive') { v.recorder.onstop = null; v.recorder.stop(); } } catch (e) {}
    this.releaseStream();
    v.recognition = null; v.recorder = null; v.active = false;
    this.$('btn-mic').classList.remove('recording');
  }

  cancelVoice() {
    this.cleanupVoice();
    this.voice.cmd = '';
    this.$('voice-panel').classList.add('hidden');
  }

  async handleTranscript(text) {
    text = (text || '').trim();
    if (!text) {
      this.showVoicePanel('Мовлення не розпізнано', { transcript: 'Спробуйте ще раз.' });
      return;
    }
    this.showVoicePanel('🤖 Підбираю команду…', { transcript: `«${text}»` });
    try {
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, model: this.$('select-ai-model').value })
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || 'Помилка ШІ');
      if (!d.command) {
        this.showVoicePanel('💬 Відповідь', { transcript: d.explanation || '' });
        return;
      }
      this.voice.cmd = d.command;
      const dangerous = this.isDangerous(d.command) || Boolean(d.warning);
      this.$('voice-explain').textContent = d.explanation || '';
      const w = this.$('voice-warning');
      w.textContent = d.warning || (dangerous ? 'Небезпечна команда. Перевірте перед виконанням.' : '');
      w.classList.toggle('hidden', !dangerous);
      this.$('voice-cmd').textContent = d.command;
      this.$('voice-run').classList.toggle('voice-danger', dangerous);
      this.$('voice-result').classList.remove('hidden');
      this.showVoicePanel('✅ Команда готова', { transcript: `«${text}»`, keepResult: true });
    } catch (e) {
      this.showVoicePanel('⚠️ Помилка', { transcript: e.message });
    }
  }

  // ================= EVENT LISTENERS =================

  setupEventListeners() {
    // Toggle Sidebar
    document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
      const open = document.getElementById('sidebar').classList.contains('collapsed');
      if (open && this.isMobile()) this.aiDrawer.classList.add('hidden');
      this.setSidebar(open);
    });

    document.getElementById('sidebar-backdrop').addEventListener('click', () => this.setSidebar(false));
    
    // Swipe gestures for sidebars on mobile
    const sidebar = document.getElementById('sidebar');
    
    // Close gestures
    let closeTouchStartX = -1;
    sidebar.addEventListener('touchstart', e => closeTouchStartX = e.changedTouches[0].screenX, {passive: true});
    sidebar.addEventListener('touchend', e => {
      if (closeTouchStartX > -1 && closeTouchStartX - e.changedTouches[0].screenX > 50) this.setSidebar(false);
    });
    
    let aiTouchStartX = -1;
    this.aiDrawer.addEventListener('touchstart', e => aiTouchStartX = e.changedTouches[0].screenX, {passive: true});
    this.aiDrawer.addEventListener('touchend', e => {
      if (aiTouchStartX > -1 && e.changedTouches[0].screenX - aiTouchStartX > 50) this.aiDrawer.classList.add('hidden');
    });

    // Open gesture (swipe from the left edge of the screen)
    let openTouchStartX = -1;
    document.addEventListener('touchstart', e => {
      if (e.touches.length === 1 && e.touches[0].clientX < 30) openTouchStartX = e.touches[0].clientX;
      else openTouchStartX = -1;
    }, {passive: true});
    document.addEventListener('touchend', e => {
      if (openTouchStartX > -1 && e.changedTouches[0].clientX - openTouchStartX > 50) {
        this.setSidebar(true);
      }
      openTouchStartX = -1;
    });

    document.getElementById('btn-logout').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      location.href = '/login';
    });
    this.setupKeyBar();
    this.setupVoice();

    // New Tab Menu dropdown toggle
    const btnNewTab = document.getElementById('btn-new-tab');
    btnNewTab.addEventListener('click', (e) => {
      e.stopPropagation();
      this.newTabMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      this.newTabMenu.classList.add('hidden');
    });

    // New Local Zsh tab
    document.getElementById('menu-new-local').addEventListener('click', () => {
      this.createTab({ type: 'local', title: 'Local ZSH' });
      this.newTabMenu.classList.add('hidden');
    });

    // Search hosts
    this.inputSearchHosts.addEventListener('input', (e) => {
      this.renderConnections(e.target.value);
    });

    // Add Connection button
    document.getElementById('btn-add-connection').addEventListener('click', () => {
      this.openAddConnectionModal();
    });

    document.getElementById('btn-conn-upload-key')?.addEventListener('click', () => {
      document.getElementById('file-conn-upload-key').click();
    });
    
    document.getElementById('file-conn-upload-key')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        document.getElementById('conn-key').value = ev.target.result;
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.getElementById('btn-keyring').addEventListener('click', () => {
      document.getElementById('modal-keyring').classList.remove('hidden');
    });

    document.getElementById('btn-keyring-upload').addEventListener('click', () => {
      document.getElementById('keyring-file').click();
    });

    document.getElementById('keyring-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      let name = document.getElementById('keyring-name').value.trim();
      if (!name) name = file.name;
      
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content: text })
      });
      const d = await res.json();
      if (d.success) {
        document.getElementById('keyring-name').value = '';
        e.target.value = '';
        await this.loadKeys();
      } else {
        alert('Помилка: ' + d.error);
      }
    });

    document.getElementById('btn-keyring-paste-toggle').addEventListener('click', () => {
      document.getElementById('keyring-paste-area').classList.toggle('hidden');
    });

    document.getElementById('btn-keyring-save-text').addEventListener('click', async () => {
      let name = document.getElementById('keyring-name').value.trim();
      let text = document.getElementById('keyring-text-content').value.trim();
      if (!name || !text) {
        alert('Введіть назву та вставте текст ключа');
        return;
      }
      
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content: text })
      });
      const d = await res.json();
      if (d.success) {
        document.getElementById('keyring-name').value = '';
        document.getElementById('keyring-text-content').value = '';
        document.getElementById('keyring-paste-area').classList.add('hidden');
        await this.loadKeys();
      } else {
        alert('Помилка: ' + d.error);
      }
    });

    // Auth type radio buttons toggle
    const authRadios = document.getElementsByName('conn-auth-type');
    authRadios.forEach(r => {
      r.addEventListener('change', () => {
        if (r.value === 'key') {
          document.getElementById('group-password').classList.add('hidden');
          document.getElementById('group-key').classList.remove('hidden');
        } else {
          document.getElementById('group-password').classList.remove('hidden');
          document.getElementById('group-key').classList.add('hidden');
        }
      });
    });

    const keySourceRadios = document.getElementsByName('conn-key-source');
    keySourceRadios.forEach(r => {
      r.addEventListener('change', () => {
        if (r.value === 'keyring') {
          document.getElementById('conn-key-keyring-wrapper').classList.remove('hidden');
          document.getElementById('conn-key-text-wrapper').classList.add('hidden');
        } else {
          document.getElementById('conn-key-keyring-wrapper').classList.add('hidden');
          document.getElementById('conn-key-text-wrapper').classList.remove('hidden');
        }
      });
    });

    // Password visibility toggle
    document.querySelectorAll('.btn-toggle-pwd').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = btn.parentElement.querySelector('input');
        if (inp.type === 'password') {
          inp.type = 'text';
          btn.innerHTML = `<i class="fa-solid fa-eye-slash"></i>`;
        } else {
          inp.type = 'password';
          btn.innerHTML = `<i class="fa-solid fa-eye"></i>`;
        }
      });
    });

    // Test connection button inside modal
    document.getElementById('btn-test-connection').addEventListener('click', async () => {
      const statusBox = document.getElementById('conn-test-status');
      statusBox.className = 'status-box info';
      statusBox.textContent = "Перевірка зв'язку з SSH сервером...";
      statusBox.classList.remove('hidden');

      const host = document.getElementById('conn-host').value;
      const port = document.getElementById('conn-port').value;
      const username = document.getElementById('conn-user').value;
      const authType = document.querySelector('input[name="conn-auth-type"]:checked').value;
      const password = document.getElementById('conn-password').value;
      const keySource = document.querySelector('input[name="conn-key-source"]:checked').value;
      const keyId = keySource === 'keyring' ? document.getElementById('conn-key-id').value : '';
      const privateKey = keySource === 'text' ? document.getElementById('conn-key').value : '';
      const passphrase = document.getElementById('conn-passphrase').value;

      try {
        const res = await fetch('/api/connections/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host, port, username, authType, password, privateKey, keyId, passphrase })
        });
        const data = await res.json();
        if (data.success) {
          statusBox.className = 'status-box success';
          statusBox.textContent = `✓ ${data.message}`;
        } else {
          statusBox.className = 'status-box error';
          statusBox.textContent = `✗ ${data.error}`;
        }
      } catch (err) {
        statusBox.className = 'status-box error';
        statusBox.textContent = `Помилка: ${err.message}`;
      }
    });

    // Save connection form submit
    document.getElementById('form-connection').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('conn-id').value;
      const keySource = document.querySelector('input[name="conn-key-source"]:checked').value;
      const payload = {
        name: document.getElementById('conn-name').value,
        host: document.getElementById('conn-host').value,
        port: document.getElementById('conn-port').value,
        username: document.getElementById('conn-user').value,
        group: document.getElementById('conn-group').value,
        authType: document.querySelector('input[name="conn-auth-type"]:checked').value,
        password: document.getElementById('conn-password').value,
        keyId: keySource === 'keyring' ? document.getElementById('conn-key-id').value : '',
        privateKey: keySource === 'text' ? document.getElementById('conn-key').value : '',
        passphrase: document.getElementById('conn-passphrase').value,
        notes: document.getElementById('conn-notes').value
      };

      const url = id ? `/api/connections/${id}` : '/api/connections';
      const method = id ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const d = await res.json();
        if (d.success) {
          document.getElementById('modal-connection').classList.add('hidden');
          await this.loadConnections();
        } else {
          alert(`Помилка: ${d.error}`);
        }
      } catch (err) {
        alert(`Помилка: ${err.message}`);
      }
    });

    // Quick Connect Modal
    document.getElementById('btn-quick-connect').addEventListener('click', () => {
      document.getElementById('form-quick-connect').reset();
      document.getElementById('modal-quick-connect').classList.remove('hidden');
      document.getElementById('quick-target').focus();
    });

    document.getElementById('form-quick-connect').addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawTarget = document.getElementById('quick-target').value.trim();
      const password = document.getElementById('quick-password').value;
      const saveIt = document.getElementById('quick-save').checked;

      // Parse user@host:port
      let username = 'root';
      let host = rawTarget;
      let port = 22;

      if (host.includes('@')) {
        const parts = host.split('@');
        username = parts[0];
        host = parts[1];
      }

      if (host.includes(':')) {
        const parts = host.split(':');
        host = parts[0];
        port = parseInt(parts[1], 10) || 22;
      }

      if (saveIt) {
        await fetch('/api/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `${username}@${host}`,
            host,
            port,
            username,
            authType: 'password',
            password,
            group: 'Quick'
          })
        });
        await this.loadConnections();
      }

      document.getElementById('modal-quick-connect').classList.add('hidden');
      const tr = await fetch('/api/quick-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port, username, password })
      });
      const td = await tr.json();
      if (!td.success) { alert(td.error || 'Помилка'); return; }
      this.createTab({
        type: 'ssh',
        title: `${username}@${host}`,
        hostInfo: { ticket: td.ticket }
      });
      if (this.isMobile()) this.setSidebar(false);
    });

    // AI Drawer toggle
    document.getElementById('btn-ai-toggle').addEventListener('click', () => {
      this.aiDrawer.classList.toggle('hidden');
      if (!this.aiDrawer.classList.contains('hidden') && this.isMobile()) this.setSidebar(false);
      setTimeout(() => this.fitActiveTerminal(), 300);
    });

    document.getElementById('btn-close-ai').addEventListener('click', () => {
      this.aiDrawer.classList.add('hidden');
      setTimeout(() => this.fitActiveTerminal(), 300);
    });

    // AI send button & enter key
    const aiInput = document.getElementById('ai-prompt-input');
    const sendAI = () => {
      const q = aiInput.value.trim();
      if (q) {
        this.askAI(q);
        aiInput.value = '';
      }
    };

    document.getElementById('btn-send-ai').addEventListener('click', sendAI);
    aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAI();
      }
    });

    // AI prompt chips
    document.querySelectorAll('.prompt-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.getAttribute('data-query');
        if (q) this.askAI(q);
      });
    });

    // Settings Modal
    document.getElementById('btn-settings').addEventListener('click', () => {
      document.getElementById('modal-settings').classList.remove('hidden');
    });

    document.getElementById('setting-font-size').addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('font-size-val').textContent = val;
      this.settings.fontSize = val;
      this.tabs.forEach(t => {
        t.term.options.fontSize = val;
        t.fitAddon.fit();
      });
    });

    document.getElementById('btn-save-settings').addEventListener('click', async () => {
      const fontSize = parseInt(document.getElementById('setting-font-size').value, 10);
      const fontFamily = document.getElementById('setting-font-family').value;
      const openaiApiKey = document.getElementById('setting-openai-key').value;
      const geminiApiKey = document.getElementById('setting-gemini-key').value;

      const updated = { fontSize, fontFamily, voiceLang: document.getElementById('setting-voice-lang').value };
      if (openaiApiKey) updated.openaiApiKey = openaiApiKey;
      if (geminiApiKey) updated.geminiApiKey = geminiApiKey;

      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });

      const { openaiApiKey: _k1, geminiApiKey: _k2, ...localUpdate } = updated;
      this.settings = { ...this.settings, ...localUpdate, hasOpenaiKey: this.settings.hasOpenaiKey || Boolean(openaiApiKey) };
      document.getElementById('setting-openai-key').value = '';
      document.getElementById('setting-gemini-key').value = '';
      this.applySettings();
      alert('Налаштування збережено');
      document.getElementById('modal-settings').classList.add('hidden');
    });

    document.getElementById('btn-apply-whisper')?.addEventListener('click', async () => {
      const model = document.getElementById('setting-whisper-model').value;
      const btn = document.getElementById('btn-apply-whisper');
      const ogHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Чекайте...';
      btn.disabled = true;
      try {
        const r = await fetch('/api/settings/whisper', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ model })
        });
        const json = await r.json();
        if (json.success) alert(json.message);
        else alert('Помилка: ' + json.error);
      } catch (e) { alert('Помилка мережі'); }
      btn.innerHTML = ogHtml;
      btn.disabled = false;
    });

    document.getElementById('btn-export-data')?.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/export');
        const data = await res.json();
        if (data.success) {
          const blob = new Blob([JSON.stringify({ connections: data.connections, keys: data.keys }, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `umolkterm_backup_${new Date().toISOString().split('T')[0]}.json`;
          a.click();
          URL.revokeObjectURL(url);
        }
      } catch (e) {
        alert('Помилка при експорті: ' + e.message);
      }
    });

    document.getElementById('btn-import-data')?.addEventListener('click', () => {
      document.getElementById('file-import-data').click();
    });

    document.getElementById('file-import-data')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const json = JSON.parse(ev.target.result);
          const res = await fetch('/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(json)
          });
          const result = await res.json();
          if (result.success) {
            alert('Дані успішно імпортовано! Сторінка буде перезавантажена.');
            location.reload();
          } else {
            alert('Помилка імпорту: ' + (result.error || 'Невідома помилка'));
          }
        } catch (err) {
          alert('Помилка читання файлу: перевірте формат JSON');
        }
        e.target.value = ''; // reset
      };
      reader.readAsText(file);
    });

    // Fullscreen toggle
    document.getElementById('btn-fullscreen').addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Modal close buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-modal');
        if (modalId) {
          document.getElementById(modalId).classList.add('hidden');
        }
      });
    });

    // Close modal on backdrop click
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Start app on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.app = new DraculaTerminalApp();
});
