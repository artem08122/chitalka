/**
 * Library Controller
 * Manages book shelves, filtering, sorting, search, book upload, and book actions.
 */
import { storage, DEFAULT_SHELVES } from './storage.js';
import { parseBookFile } from './parsers/index.js';
import { cloud } from './cloud.js';

export class LibraryController {
  constructor(app) {
    this.app = app;
    this.books = [];
    this.shelves = [];
    this.activeShelfId = 'all'; // 'all' or shelf.id
    this.activeFilter = 'all'; // 'all' | 'reading' | 'completed' | 'not_started'
    this.sortBy = 'recent'; // 'recent' | 'title' | 'author' | 'date_added'
    this.searchQuery = '';

    // DOM Elements
    this.shelvesBar = document.getElementById('shelves-bar');
    this.booksGrid = document.getElementById('books-grid');
    this.emptyState = document.getElementById('library-empty-state');
    this.searchInput = document.getElementById('library-search-input');
    this.filterPills = document.querySelectorAll('.filter-pill');
    this.sortSelect = document.getElementById('sort-select');
    this.fileInput = document.getElementById('book-file-input');

    this.initEvents();
  }

  async init() {
    await this.loadShelves();
    await this.loadBooks();
    
    // Auto-seed sample books if library is empty
    if (this.books.length === 0) {
      await this.syncFromServer();
    }
    
    this.render();
    this.initCloud();
    window.__appReady = true;
    console.log('__APP_READY__ Books loaded:', this.books.length);
  }

  async syncFromServer() {
    try {
      let res = await fetch('./samples/manifest.json');
      if (!res.ok) {
        res = await fetch('/api/books');
      }
      if (!res.ok) return;
      const data = await res.json();
      if (data.books && data.books.length > 0) {
        for (const item of data.books) {
          try {
            const resp = await fetch(item.url);
            const blob = await resp.blob();
            const file = new File([blob], item.name, { type: blob.type });
            
            // Assign shelf based on filename/topic
            let shelfId = 'shelf_none';
            const nameLower = item.name.toLowerCase();
            if (nameLower.includes('smith') || nameLower.includes('freakonomics') || nameLower.includes('finance') || nameLower.includes('economy')) {
              shelfId = 'shelf_economics';
            } else if (nameLower.includes('psychology') || nameLower.includes('thinking') || nameLower.includes('habits')) {
              shelfId = 'shelf_psychology';
            }

            const parsedBook = await parseBookFile(file, shelfId);
            const arrayBuf = await file.arrayBuffer();
            await storage.saveFileBlob(parsedBook.id, arrayBuf);
            await storage.saveBook(parsedBook);
          } catch (e) {
            console.warn('Auto-seed item error:', item.name, e);
          }
        }
        await this.loadBooks();
      }
    } catch (e) {
      console.warn('Server sync error:', e);
    }
  }


  async initCloud() {
    // Cloud button in the header
    const actions = document.querySelector('.library-actions');
    if (actions && !document.getElementById('cloud-sync-btn')) {
      const btn = document.createElement('button');
      btn.id = 'cloud-sync-btn';
      btn.className = 'icon-btn';
      btn.title = 'Синхронизация книг';
      btn.textContent = '☁';
      btn.style.fontSize = '18px';
      btn.addEventListener('click', async () => {
        if (!cloud.enabled) {
          const t = await cloud.askToken();
          if (!t) return;
          cloud.setToken(t);
        }
        await this.syncCloud(true);
      });
      actions.insertBefore(btn, actions.firstChild);
    }
    await cloud.init();
    if (cloud.enabled) this.syncCloud(false);
  }

  async syncCloud(manual) {
    try {
      if (manual) this.app.toast('Синхронизация…');
      const res = await cloud.sync(storage, parseBookFile, (m) => { if (manual) this.app.toast(m); });
      if (res.down || res.up) {
        await this.loadBooks();
        this.render();
      }
      if (manual || res.down) this.app.toast(`☁ Скачано: ${res.down}, отправлено: ${res.up}`);
    } catch (e) {
      console.warn('cloud sync error', e);
      if (manual) {
        this.app.toast('Ошибка синхронизации: проверьте токен');
        if (String(e.message).includes('401') || String(e.message).includes('403') || String(e.message).includes('404')) {
          cloud.setToken('');
        }
      }
    }
  }

  async loadShelves() {
    this.shelves = await storage.getShelves();
  }

  async loadBooks() {
    this.books = await storage.getAllBooks();
  }

  async refresh() {
    await this.loadBooks();
    this.render();
    window.__appReady = true;
    console.log('__APP_READY__ Books loaded:', this.books.length);
  }

  render() {
    this.renderShelves();
    this.renderBooks();
  }

  renderShelves() {
    this.shelvesBar.innerHTML = '';

    // "All" shelf chip
    const allChip = document.createElement('div');
    allChip.className = `shelf-chip ${this.activeShelfId === 'all' ? 'active' : ''}`;
    allChip.innerHTML = `<span>📚</span><span>Все книги</span>`;
    allChip.onclick = () => {
      this.activeShelfId = 'all';
      this.render();
    };
    this.shelvesBar.appendChild(allChip);

    // Dynamic shelves
    this.shelves.forEach(shelf => {
      const chip = document.createElement('div');
      chip.className = `shelf-chip ${this.activeShelfId === shelf.id ? 'active' : ''}`;
      chip.innerHTML = `<span>${shelf.emoji || '📁'}</span><span>${shelf.name}</span>`;
      chip.onclick = () => {
        this.activeShelfId = shelf.id;
        this.render();
      };
      // Context menu for custom shelves (rename/delete)
      if (!shelf.isSystem) {
        chip.oncontextmenu = (e) => {
          e.preventDefault();
          this.showShelfOptions(shelf);
        };
      }
      this.shelvesBar.appendChild(chip);
    });

    // "+ Новая полка" chip
    const addChip = document.createElement('div');
    addChip.className = 'shelf-chip add-shelf-chip';
    addChip.innerHTML = `<span>+</span><span>Полка</span>`;
    addChip.onclick = () => this.app.openModal('add-shelf-modal');
    this.shelvesBar.appendChild(addChip);
  }

  renderBooks() {
    this.booksGrid.innerHTML = '';

    // Filter books
    let list = this.books.filter(b => {
      // Shelf filter
      if (this.activeShelfId !== 'all' && b.shelfId !== this.activeShelfId) {
        return false;
      }
      // Status filter
      if (this.activeFilter !== 'all' && b.status !== this.activeFilter) {
        return false;
      }
      // Search query
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        const matchesTitle = b.title && b.title.toLowerCase().includes(q);
        const matchesAuthor = b.author && b.author.toLowerCase().includes(q);
        const matchesFormat = b.format && b.format.toLowerCase().includes(q);
        if (!matchesTitle && !matchesAuthor && !matchesFormat) return false;
      }
      return true;
    });

    // Sort books
    list.sort((a, b) => {
      if (this.sortBy === 'recent') {
        return (b.lastReadAt || 0) - (a.lastReadAt || 0);
      } else if (this.sortBy === 'title') {
        return (a.title || '').localeCompare(b.title || '');
      } else if (this.sortBy === 'author') {
        return (a.author || '').localeCompare(b.author || '');
      } else if (this.sortBy === 'date_added') {
        return (b.addedAt || 0) - (a.addedAt || 0);
      }
      return 0;
    });

    if (list.length === 0) {
      this.booksGrid.style.display = 'none';
      this.emptyState.style.display = 'flex';
      return;
    }

    this.booksGrid.style.display = 'grid';
    this.emptyState.style.display = 'none';

    list.forEach((book, idx) => {
      const card = this.createBookCard(book, idx);
      this.booksGrid.appendChild(card);
    });
  }

  createBookCard(book, index) {
    const card = document.createElement('div');
    card.className = 'book-card';

    const percent = book.progress?.percent || 0;
    const themeClass = `theme-${(index % 4) + 1}`;

    let coverHtml = '';
    if (book.coverUrl) {
      coverHtml = `<img class="book-cover-img" src="${book.coverUrl}" alt="${book.title}" />`;
    } else {
      coverHtml = `
        <div class="book-cover-fallback ${themeClass}">
          <div class="cover-badge-format">${(book.format || 'txt').toUpperCase()}</div>
          <div class="cover-text-info">
            <div class="cover-title-text">${book.title}</div>
            <div class="cover-author-text">${book.author}</div>
          </div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="book-cover-wrap">
        ${coverHtml}
        <div class="book-card-progress">
          <div class="book-card-progress-fill" style="width: ${percent}%;"></div>
        </div>
      </div>
      <div class="book-card-info">
        <div class="book-card-title">${book.title}</div>
        <div class="book-card-author">${book.author}</div>
        <div class="book-card-meta">
          <span>${percent > 0 ? `${percent}%` : (book.format || '').toUpperCase()}</span>
          <span>•••</span>
        </div>
      </div>
    `;

    // Click opens reader
    card.addEventListener('click', (e) => {
      // Check if clicked the context dots
      if (e.target.textContent === '•••') {
        e.stopPropagation();
        this.openBookMenu(book);
        return;
      }
      this.app.reader.openBook(book);
    });

    // Long press / right click context menu
    let pressTimer;
    card.addEventListener('touchstart', () => {
      pressTimer = setTimeout(() => {
        this.openBookMenu(book);
      }, 550);
    }, { passive: true });

    card.addEventListener('touchend', () => clearTimeout(pressTimer));
    card.addEventListener('touchmove', () => clearTimeout(pressTimer));

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openBookMenu(book);
    });

    return card;
  }

  openBookMenu(book) {
    this.app.selectedBookForMenu = book;
    const modal = document.getElementById('book-menu-modal');
    document.getElementById('book-menu-title').textContent = book.title;
    document.getElementById('book-menu-author').textContent = book.author;
    this.app.openModal('book-menu-modal');
  }

  showShelfOptions(shelf) {
    if (confirm(`Удалить полку «${shelf.name}»? (Книги перейдут в «Без полки»)`)) {
      storage.deleteShelf(shelf.id).then(async () => {
        await this.loadShelves();
        if (this.activeShelfId === shelf.id) this.activeShelfId = 'all';
        this.render();
      });
    }
  }

  async handleFileUpload(files) {
    if (!files || !files.length) return;

    this.app.showLoading(`Загрузка ${files.length} книг...`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const targetShelf = (this.activeShelfId !== 'all') ? this.activeShelfId : 'shelf_none';
        const parsedBook = await parseBookFile(file, targetShelf);

        // Store raw file blob for PDF original mode or export
        const arrayBuf = await file.arrayBuffer();
        await storage.saveFileBlob(parsedBook.id, arrayBuf);

        // Save book
        await storage.saveBook(parsedBook);

        // Cloud sync (non-blocking)
        parsedBook.fileName = file.name;
        cloud.push(parsedBook.id, file.name, arrayBuf, parsedBook.shelfId)
          .catch(e => console.warn('cloud push failed', e));
      } catch (err) {
        console.error('Error importing file:', file.name, err);
        alert(`Не удалось открыть «${file.name}»: ${err.message}`);
      }
    }

    this.app.hideLoading();
    await this.loadBooks();
    this.render();
    this.app.toast(`Добавлено книг: ${files.length}`);
  }

  initEvents() {
    // Search
    this.searchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.trim();
      this.renderBooks();
    });

    // Filter pills
    this.filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        this.filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.activeFilter = pill.dataset.filter;
        this.renderBooks();
      });
    });

    // Sort
    this.sortSelect?.addEventListener('change', (e) => {
      this.sortBy = e.target.value;
      this.renderBooks();
    });

    // File input
    this.fileInput?.addEventListener('change', (e) => {
      this.handleFileUpload(e.target.files);
      e.target.value = '';
    });

    // Add book button
    document.getElementById('add-book-btn')?.addEventListener('click', () => {
      this.fileInput.click();
    });
    document.getElementById('empty-add-btn')?.addEventListener('click', () => {
      this.fileInput.click();
    });

    // Drag & Drop on view
    const libView = document.getElementById('library-view');
    libView.addEventListener('dragover', (e) => {
      e.preventDefault();
      libView.style.opacity = '0.7';
    });
    libView.addEventListener('dragleave', () => {
      libView.style.opacity = '1';
    });
    libView.addEventListener('drop', (e) => {
      e.preventDefault();
      libView.style.opacity = '1';
      if (e.dataTransfer?.files?.length) {
        this.handleFileUpload(e.dataTransfer.files);
      }
    });
  }
}
