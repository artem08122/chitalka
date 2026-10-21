/**
 * Main Application Orchestrator
 * Connects Telegram WebApp SDK, LibraryController, ReaderController, and Modals
 */
import { LibraryController } from './library.js';
import { ReaderController } from './reader.js';
import { storage } from './storage.js';
import { cloud } from './cloud.js';

class AntigravityReaderApp {
  constructor() {
    this.currentView = 'library';
    this.selectedBookForMenu = null;
    this.library = null;
    this.reader = null;

    // Toast & Loading
    this.toastEl = document.getElementById('app-toast');
    this.loadingOverlay = document.getElementById('loading-overlay');
    this.loadingText = document.getElementById('loading-text');

    this.initTelegram();
    this.initControllers();
    this.initModals();
    this.initSelectionToolbar();
    this.registerServiceWorker();
  }

  initTelegram() {
    if (window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.ready();
      tg.expand();

      // Set header color to match app theme
      try {
        tg.setHeaderColor?.('#ffffff');
      } catch (e) {}

      // Listen to viewport changes
      tg.onEvent?.('viewportChanged', () => {
        document.documentElement.style.setProperty('--app-height', `${tg.viewportHeight}px`);
      });

      // Listen to theme changes
      tg.onEvent?.('themeChanged', () => {
        const settings = storage.getSettings().then(s => {
          if (s.theme === 'auto') {
            document.documentElement.setAttribute('data-theme', tg.colorScheme || 'light');
          }
        });
      });
    }
  }

  async initControllers() {
    this.reader = new ReaderController(this);
    this.library = new LibraryController(this);
    await this.library.init();
  }

  showView(viewName) {
    this.currentView = viewName;
    const libView = document.getElementById('library-view');
    const readView = document.getElementById('reader-view');

    if (viewName === 'reader') {
      libView.classList.add('hidden');
      readView.classList.remove('hidden');
    } else {
      readView.classList.add('hidden');
      libView.classList.remove('hidden');
    }
  }

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('open');

    if (modalId === 'toc-modal') {
      this.populateTOCModal();
    } else if (modalId === 'settings-modal') {
      this.populateSettingsModal();
    } else if (modalId === 'move-shelf-modal') {
      this.populateMoveShelfModal();
    }
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('open');
  }

  initModals() {
    // Backdrop click closes modal
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.remove('open');
        }
      });
      modal.querySelector('.sheet-close-btn')?.addEventListener('click', () => {
        modal.classList.remove('open');
      });
    });

    // Reader header buttons
    document.getElementById('btn-open-toc')?.addEventListener('click', () => {
      this.openModal('toc-modal');
    });
    document.getElementById('btn-open-settings')?.addEventListener('click', () => {
      this.openModal('settings-modal');
    });
    document.getElementById('btn-open-search')?.addEventListener('click', () => {
      this.openModal('search-modal');
    });
    document.getElementById('btn-bookmark')?.addEventListener('click', () => {
      this.reader.addBookmark();
    });

    // TOC / Bookmarks Tab switching
    const tocTabBtn = document.getElementById('tab-toc-btn');
    const bmTabBtn = document.getElementById('tab-bm-btn');
    const tocList = document.getElementById('toc-list');
    const bmList = document.getElementById('bookmarks-list');

    tocTabBtn?.addEventListener('click', () => {
      tocTabBtn.classList.add('active');
      bmTabBtn.classList.remove('active');
      tocList.style.display = 'block';
      bmList.style.display = 'none';
    });

    bmTabBtn?.addEventListener('click', () => {
      bmTabBtn.classList.add('active');
      tocTabBtn.classList.remove('active');
      tocList.style.display = 'none';
      bmList.style.display = 'block';
      this.populateBookmarksList();
    });

    // Settings Modal handlers
    this.initSettingsModalControls();

    // Search Modal handler
    this.initSearchModalControls();

    // Add Shelf form
    document.getElementById('save-new-shelf-btn')?.addEventListener('click', async () => {
      const nameInput = document.getElementById('new-shelf-name');
      const name = nameInput.value.trim();
      if (!name) return alert('Введите название полки');

      const emoji = document.querySelector('.emoji-opt.selected')?.textContent || '📁';
      const color = document.querySelector('.color-opt.selected')?.dataset.color || '#3b82f6';

      const newShelf = {
        id: 'shelf_' + Date.now(),
        name,
        emoji,
        color,
        isSystem: false,
        createdAt: Date.now()
      };

      await storage.saveShelf(newShelf);
      nameInput.value = '';
      this.closeModal('add-shelf-modal');
      await this.library.loadShelves();
      this.library.render();
      this.toast(`Полка «${name}» создана`);
    });

    // Book Context Menu Handlers
    document.getElementById('book-menu-move')?.addEventListener('click', () => {
      this.closeModal('book-menu-modal');
      this.openModal('move-shelf-modal');
    });

    document.getElementById('book-menu-status')?.addEventListener('click', async () => {
      if (!this.selectedBookForMenu) return;
      this.selectedBookForMenu.status = this.selectedBookForMenu.status === 'completed' ? 'reading' : 'completed';
      await storage.saveBook(this.selectedBookForMenu);
      this.closeModal('book-menu-modal');
      this.library.refresh();
      this.toast('Статус обновлён');
    });

    document.getElementById('book-menu-delete')?.addEventListener('click', async () => {
      if (!this.selectedBookForMenu) return;
      if (confirm(`Удалить «${this.selectedBookForMenu.title}» из библиотеки?`)) {
        await storage.deleteBook(this.selectedBookForMenu.id);
        cloud.removeBook(this.selectedBookForMenu.id);
        this.closeModal('book-menu-modal');
        this.library.refresh();
        this.toast('Книга удалена');
      }
    });

    // Add Shelf Emoji & Color picker selectors
    document.querySelectorAll('.emoji-opt').forEach(opt => {
      opt.onclick = () => {
        document.querySelectorAll('.emoji-opt').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
      };
    });
    document.querySelectorAll('.color-opt').forEach(opt => {
      opt.onclick = () => {
        document.querySelectorAll('.color-opt').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
      };
    });
  }

  populateTOCModal() {
    const list = document.getElementById('toc-list');
    list.innerHTML = '';
    const book = this.reader.book;
    if (!book || !book.toc?.length) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary)">Оглавление отсутствует</div>';
      return;
    }

    book.toc.forEach(item => {
      const row = document.createElement('div');
      row.className = `toc-item ${this.reader.currentChapterIndex === item.chapterIndex ? 'active' : ''}`;
      row.innerHTML = `<span>${item.title}</span><span style="font-size:12px;opacity:0.6">${item.chapterIndex + 1}</span>`;
      row.onclick = () => {
        this.closeModal('toc-modal');
        this.reader.renderChapter(item.chapterIndex);
      };
      list.appendChild(row);
    });
  }

  populateBookmarksList() {
    const list = document.getElementById('bookmarks-list');
    list.innerHTML = '';
    const book = this.reader.book;
    const bms = book?.bookmarks || [];
    const hls = book?.highlights || [];

    if (!bms.length && !hls.length) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary)">Нет закладок и цитат</div>';
      return;
    }

    // Bookmarks
    bms.forEach(bm => {
      const row = document.createElement('div');
      row.className = 'toc-item';
      row.innerHTML = `
        <div>
          <div style="font-weight:600;font-size:14px">🔖 ${bm.title}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${bm.snippet}</div>
        </div>
      `;
      row.onclick = () => {
        this.closeModal('toc-modal');
        this.reader.renderChapter(bm.chapterIndex);
        if (bm.pageIndex !== undefined) {
          this.reader.goToPage(bm.pageIndex);
        }
      };
      list.appendChild(row);
    });

    // Highlights
    hls.forEach(hl => {
      const row = document.createElement('div');
      row.className = 'toc-item';
      row.innerHTML = `
        <div>
          <div style="font-weight:600;font-size:13px;color:var(--accent)">💡 Цитата</div>
          <div style="font-size:13px;font-style:italic;margin-top:2px">«${hl.text}»</div>
        </div>
      `;
      row.onclick = () => {
        this.closeModal('toc-modal');
        this.reader.renderChapter(hl.chapterIndex);
      };
      list.appendChild(row);
    });
  }

  populateMoveShelfModal() {
    const list = document.getElementById('move-shelf-list');
    list.innerHTML = '';
    const book = this.selectedBookForMenu;
    if (!book) return;

    this.library.shelves.forEach(shelf => {
      const row = document.createElement('div');
      row.className = 'dialog-action-btn';
      row.innerHTML = `<span>${shelf.emoji || '📁'}</span><span>${shelf.name}</span> ${book.shelfId === shelf.id ? '✓' : ''}`;
      row.onclick = async () => {
        book.shelfId = shelf.id;
        cloud.updateShelf(book.id, shelf.id);
        await storage.saveBook(book);
        this.closeModal('move-shelf-modal');
        this.library.refresh();
        this.toast(`Книга перемещена на полку «${shelf.name}»`);
      };
      list.appendChild(row);
    });
  }

  populateSettingsModal() {
    const s = this.reader.settings;
    if (!s) return;

    // Theme active state
    document.querySelectorAll('.theme-opt-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeChoice === s.theme);
    });

    // Font Family active state
    document.querySelectorAll('.font-family-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.font === s.fontFamily);
    });

    // Reading Mode active state
    document.querySelectorAll('.reading-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === s.readingMode);
    });

    // Margin active state
    document.querySelectorAll('.margin-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.margin === s.margin);
    });

    // Align active state
    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.align === s.textAlign);
    });

    // Font size display
    document.getElementById('font-size-val').textContent = `${s.fontSize}px`;
    document.getElementById('brightness-range').value = s.brightness || 100;
  }

  initSettingsModalControls() {
    // Theme buttons
    document.querySelectorAll('.theme-opt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.dataset.themeChoice;
        this.reader.updateSettings({ theme });
        document.querySelectorAll('.theme-opt-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Font family buttons
    document.querySelectorAll('.font-family-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fontFamily = btn.dataset.font;
        this.reader.updateSettings({ fontFamily });
        document.querySelectorAll('.font-family-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Reading mode buttons
    document.querySelectorAll('.reading-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const readingMode = btn.dataset.mode;
        this.reader.updateSettings({ readingMode });
        document.querySelectorAll('.reading-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Margin buttons
    document.querySelectorAll('.margin-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const margin = btn.dataset.margin;
        this.reader.updateSettings({ margin });
        document.querySelectorAll('.margin-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Align buttons
    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const textAlign = btn.dataset.align;
        this.reader.updateSettings({ textAlign });
        document.querySelectorAll('.align-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Font size buttons
    document.getElementById('btn-font-dec')?.addEventListener('click', () => {
      const current = this.reader.settings.fontSize || 18;
      const next = Math.max(12, current - 1);
      document.getElementById('font-size-val').textContent = `${next}px`;
      this.reader.updateSettings({ fontSize: next });
    });

    document.getElementById('btn-font-inc')?.addEventListener('click', () => {
      const current = this.reader.settings.fontSize || 18;
      const next = Math.min(32, current + 1);
      document.getElementById('font-size-val').textContent = `${next}px`;
      this.reader.updateSettings({ fontSize: next });
    });

    // Brightness range
    document.getElementById('brightness-range')?.addEventListener('input', (e) => {
      const brightness = parseInt(e.target.value, 10);
      this.reader.updateSettings({ brightness });
    });
  }

  initSearchModalControls() {
    const input = document.getElementById('book-search-input');
    const resultsList = document.getElementById('search-results-list');

    input?.addEventListener('input', () => {
      const query = input.value.trim();
      resultsList.innerHTML = '';
      if (!query || query.length < 2) return;

      const book = this.reader.book;
      if (!book) return;

      const results = [];
      const qLower = query.toLowerCase();

      book.chapters.forEach((ch, chIdx) => {
        // Strip tags for clean text search
        const div = document.createElement('div');
        div.innerHTML = ch.html;
        const text = div.textContent || '';
        const tLower = text.toLowerCase();

        let pos = 0;
        while ((pos = tLower.indexOf(qLower, pos)) !== -1) {
          const start = Math.max(0, pos - 40);
          const end = Math.min(text.length, pos + query.length + 40);
          const snippet = text.slice(start, end);
          results.push({
            chapterIndex: chIdx,
            chapterTitle: ch.title,
            snippet,
            query
          });
          pos += query.length + 10;
          if (results.length > 50) break; // max matches
        }
      });

      if (!results.length) {
        resultsList.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary)">Ничего не найдено</div>';
        return;
      }

      results.forEach(res => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        const escapedQ = res.query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const highlightedSnippet = res.snippet.replace(new RegExp(`(${escapedQ})`, 'gi'), '<mark>$1</mark>');

        item.innerHTML = `
          <div class="search-result-title">${res.chapterTitle}</div>
          <div class="search-result-snippet">...${highlightedSnippet}...</div>
        `;
        item.onclick = () => {
          this.closeModal('search-modal');
          this.reader.renderChapter(res.chapterIndex);
        };
        resultsList.appendChild(item);
      });
    });
  }

  initSelectionToolbar() {
    const toolbar = document.getElementById('selection-toolbar');

    document.addEventListener('selectionchange', () => {
      if (this.currentView !== 'reader') return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        toolbar.style.display = 'none';
        return;
      }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        toolbar.style.display = 'none';
        return;
      }

      toolbar.style.display = 'flex';
      toolbar.style.left = `${rect.left + rect.width / 2}px`;
      toolbar.style.top = `${rect.top - 8}px`;
    });

    document.querySelectorAll('.highlight-color-dot').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = btn.dataset.color;
        this.reader.addHighlight(color);
        toolbar.style.display = 'none';
      });
    });

    document.getElementById('btn-copy-selection')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = window.getSelection().toString();
      navigator.clipboard?.writeText(text);
      this.toast('Скопировано');
      toolbar.style.display = 'none';
    });
  }

  toast(message) {
    if (!this.toastEl) return;
    this.toastEl.textContent = message;
    this.toastEl.style.opacity = '1';
    this.toastEl.style.transform = 'translate(-50%, 0)';
    setTimeout(() => {
      this.toastEl.style.opacity = '0';
      this.toastEl.style.transform = 'translate(-50%, 10px)';
    }, 2400);
  }

  showLoading(text = 'Загрузка...') {
    if (this.loadingOverlay) {
      this.loadingText.textContent = text;
      this.loadingOverlay.style.display = 'flex';
    }
  }

  hideLoading() {
    if (this.loadingOverlay) {
      this.loadingOverlay.style.display = 'none';
    }
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('SW registration failed:', err);
      });
    }
  }
}

function startApp() {
  if (!window.antigravityApp) {
    window.antigravityApp = new AntigravityReaderApp();
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
