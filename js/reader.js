/**
 * Reader Controller
 * Manages active book reading, pagination/scroll modes, typography, themes,
 * TOC navigation, in-book search, bookmarks, highlights, and PDF switching.
 */
import { storage } from './storage.js';
import { cloud } from './cloud.js';

export class ReaderController {
  constructor(app) {
    this.app = app;
    this.book = null;
    this.currentChapterIndex = 0;
    this.currentPageIndex = 0;
    this.totalPagesInChapter = 1;
    this.settings = null;
    this.barsVisible = true;
    this.pdfMode = 'reformat'; // 'reformat' | 'original'

    // DOM Elements
    this.view = document.getElementById('reader-view');
    this.header = document.getElementById('reader-header');
    this.footer = document.getElementById('reader-footer');
    this.content = document.getElementById('reader-content');
    this.titleEl = document.getElementById('reader-book-title');
    this.progressText = document.getElementById('reader-progress-text');
    this.progressBar = document.getElementById('reader-chapter-range');
    this.timeLeftText = document.getElementById('reader-time-left');
    this.modeToggleBtn = document.getElementById('reader-mode-toggle');
    this.brightnessOverlay = document.getElementById('brightness-overlay');
    this.pdfOriginalContainer = document.getElementById('pdf-original-container');

    this.initEvents();
  }

  async openBook(book, savedChapterIndex = null, savedScrollRatio = null) {
    this.book = book;
    this.settings = await storage.getSettings();
    this.applySettings();

    this.currentChapterIndex = savedChapterIndex !== null ? savedChapterIndex : (book.progress?.chapterIndex || 0);
    this.currentPageIndex = book.progress?.pageIndex || 0;
    this._pendingFrac = (book.progress && typeof book.progress.frac === 'number') ? book.progress.frac : null;
    this.pdfMode = book.settings?.pdfMode || (book.format === 'pdf' ? 'reformat' : 'reformat');

    // Title
    this.titleEl.textContent = book.title;

    // Show/hide PDF mode switcher
    if (book.format === 'pdf') {
      this.modeToggleBtn.style.display = 'flex';
      this.updatePdfModeButton();
    } else {
      this.modeToggleBtn.style.display = 'none';
    }

    // Switch view
    this.app.showView('reader');

    // Load content
    await this.renderCurrentView();

    // Notify Telegram WebApp BackButton
    if (window.Telegram?.WebApp?.BackButton) {
      window.Telegram.WebApp.BackButton.show();
      window.Telegram.WebApp.BackButton.onClick(() => this.closeReader());
    }

    // Update book last read timestamp and status
    this.book.lastReadAt = Date.now();
    if (this.book.status === 'not_started') {
      this.book.status = 'reading';
    }
    await storage.saveBook(this.book);
  }

  closeReader() {
    this.saveProgress();
    if (window.Telegram?.WebApp?.BackButton) {
      window.Telegram.WebApp.BackButton.hide();
    }
    this.app.showView('library');
    this.app.library.refresh();
  }

  async renderCurrentView() {
    if (this.book.format === 'pdf' && this.pdfMode === 'original') {
      this.content.style.display = 'none';
      this.pdfOriginalContainer.style.display = 'flex';
      await this.renderOriginalPdfPages();
    } else {
      this.content.style.display = 'block';
      this.pdfOriginalContainer.style.display = 'none';
      await this.renderChapter(this.currentChapterIndex);
    }
    this.updateFooterInfo();
  }

  async renderChapter(index) {
    if (!this.book.chapters || !this.book.chapters[index]) return;

    this.currentChapterIndex = Math.max(0, Math.min(index, this.book.chapters.length - 1));
    const chapter = this.book.chapters[this.currentChapterIndex];

    // Render HTML content
    this.content.innerHTML = chapter.html;

    // Apply highlights
    this.applyHighlightsToDom();

    // Mode-specific layout
    if (this.settings.readingMode === 'paginate') {
      this.content.classList.add('mode-paginate');
      this.content.classList.remove('mode-scroll');
      this.content.style.transform = 'none';
      this.content.scrollLeft = 0;
      this.calculatePagination();
      if (this._pendingFrac != null) {
        this.currentPageIndex = Math.min(this.totalPagesInChapter - 1, Math.floor(this._pendingFrac * this.totalPagesInChapter));
        this._pendingFrac = null;
      }
      this.goToPage(this.currentPageIndex);
    } else {
      this.content.classList.remove('mode-paginate');
      this.content.classList.add('mode-scroll');
      this.content.scrollTop = 0;
    }

    this.updateFooterInfo();
  }

  calculatePagination() {
    // Total columns calculation based on scrollWidth and clientWidth
    const colWidth = this.content.clientWidth;
    const scrollW = this.content.scrollWidth;
    this.totalPagesInChapter = Math.max(1, Math.ceil(scrollW / colWidth));
    if (this.currentPageIndex >= this.totalPagesInChapter) {
      this.currentPageIndex = this.totalPagesInChapter - 1;
    }
  }

  goToPage(pageIdx) {
    this.currentPageIndex = Math.max(0, Math.min(pageIdx, this.totalPagesInChapter - 1));
    this.content.style.transform = 'none';
    this.content.scrollLeft = this.currentPageIndex * this.content.clientWidth;
    this.updateFooterInfo();
    this.haptic('selection_changed');
    this.saveProgress();
  }

  nextPage() {
    if (this.settings.readingMode === 'paginate') {
      if (this.currentPageIndex < this.totalPagesInChapter - 1) {
        this.goToPage(this.currentPageIndex + 1);
      } else if (this.currentChapterIndex < this.book.chapters.length - 1) {
        this.currentPageIndex = 0;
        this.renderChapter(this.currentChapterIndex + 1);
      }
    } else {
      // Scroll down by 80% screen
      this.content.scrollBy({ top: this.content.clientHeight * 0.8, behavior: 'smooth' });
    }
  }

  prevPage() {
    if (this.settings.readingMode === 'paginate') {
      if (this.currentPageIndex > 0) {
        this.goToPage(this.currentPageIndex - 1);
      } else if (this.currentChapterIndex > 0) {
        this.renderChapter(this.currentChapterIndex - 1);
        this.currentPageIndex = this.totalPagesInChapter - 1;
        this.goToPage(this.currentPageIndex);
      }
    } else {
      // Scroll up by 80% screen
      this.content.scrollBy({ top: -this.content.clientHeight * 0.8, behavior: 'smooth' });
    }
  }

  async renderOriginalPdfPages() {
    this.pdfOriginalContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">Рендеринг страниц PDF...</div>';
    
    // Retrieve raw blob
    const rawData = await storage.getFileBlob(this.book.id);
    if (!rawData || !window.pdfjsLib) {
      this.pdfOriginalContainer.innerHTML = '<div style="padding:20px;text-align:center;">Оригинал PDF недоступен</div>';
      return;
    }

    try {
      const pdf = await window.pdfjsLib.getDocument({ data: rawData }).promise;
      this.pdfOriginalContainer.innerHTML = '';

      for (let pNum = 1; pNum <= pdf.numPages; pNum++) {
        const page = await pdf.getPage(pNum);
        // Mobile-fit scale (based on viewport width)
        const baseVp = page.getViewport({ scale: 1.0 });
        const scale = Math.min(2.0, (window.innerWidth - 20) / baseVp.width);
        const vp = page.getViewport({ scale });

        const wrap = document.createElement('div');
        wrap.className = 'pdf-page-canvas-wrap';

        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext('2d');

        wrap.appendChild(canvas);
        this.pdfOriginalContainer.appendChild(wrap);

        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      }
    } catch (e) {
      this.pdfOriginalContainer.innerHTML = `<div style="padding:20px;color:red;">Ошибка загрузки оригинала: ${e.message}</div>`;
    }
  }

  togglePdfMode() {
    this.pdfMode = this.pdfMode === 'reformat' ? 'original' : 'reformat';
    this.book.settings = this.book.settings || {};
    this.book.settings.pdfMode = this.pdfMode;
    storage.saveBook(this.book);
    this.updatePdfModeButton();
    this.renderCurrentView();
    this.haptic('impact');
  }

  updatePdfModeButton() {
    if (this.pdfMode === 'reformat') {
      this.modeToggleBtn.innerHTML = '<span>📄 Реформат</span>';
    } else {
      this.modeToggleBtn.innerHTML = '<span>📑 Оригинал</span>';
    }
  }

  toggleBars() {
    this.barsVisible = !this.barsVisible;
    if (this.barsVisible) {
      this.header.classList.remove('hidden-bar');
      this.footer.classList.remove('hidden-bar');
    } else {
      this.header.classList.add('hidden-bar');
      this.footer.classList.add('hidden-bar');
    }
  }

  updateFooterInfo() {
    if (!this.book) return;

    const totalChapters = this.book.chapters?.length || 1;
    const chNum = this.currentChapterIndex + 1;

    // Calculate percentage
    let overallPercent = Math.round((this.currentChapterIndex / totalChapters) * 100);
    if (this.settings.readingMode === 'paginate' && this.totalPagesInChapter > 1) {
      const chFraction = this.currentPageIndex / this.totalPagesInChapter;
      overallPercent = Math.min(100, Math.round(((this.currentChapterIndex + chFraction) / totalChapters) * 100));
    }

    if (this.settings.readingMode === 'paginate') {
      this.progressText.textContent = `Глава ${chNum} из ${totalChapters} • стр. ${this.currentPageIndex + 1}/${this.totalPagesInChapter}`;
    } else {
      this.progressText.textContent = `Глава ${chNum} из ${totalChapters} • ${overallPercent}%`;
    }

    // Time remaining estimation (based on 200 words/min)
    const totalWords = this.book.totalWords || 1000;
    const remainingWords = Math.max(0, Math.round(totalWords * (1 - overallPercent / 100)));
    const minutesLeft = Math.ceil(remainingWords / 200);
    this.timeLeftText.textContent = minutesLeft > 0 ? `~${minutesLeft} мин осталось` : 'Прочитано';

    // Scrubber
    this.progressBar.value = overallPercent;

    if (overallPercent >= 98 && this.book.status !== 'completed') {
      this.book.status = 'completed';
      storage.saveBook(this.book);
    }
  }

  saveProgress() {
    if (!this.book) return;

    const totalChapters = this.book.chapters?.length || 1;
    let percent = Math.round((this.currentChapterIndex / totalChapters) * 100);
    if (this.settings.readingMode === 'paginate' && this.totalPagesInChapter > 1) {
      const chFraction = this.currentPageIndex / this.totalPagesInChapter;
      percent = Math.min(100, Math.round(((this.currentChapterIndex + chFraction) / totalChapters) * 100));
    }

    this.book.progress = {
      chapterIndex: this.currentChapterIndex,
      pageIndex: this.currentPageIndex,
      totalPages: this.totalPagesInChapter,
      frac: this.totalPagesInChapter > 0 ? this.currentPageIndex / this.totalPagesInChapter : 0,
      percent,
      lastReadAt: Date.now()
    };

    storage.saveBook(this.book);
    cloud.pushProgress(this.book.id, this.book.progress);
  }

  // --- Typography & Appearance Settings ---
  applySettings() {
    const s = this.settings;
    const root = document.documentElement;

    // Theme
    let themeToApply = s.theme;
    if (themeToApply === 'auto') {
      const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      themeToApply = isDark ? 'dark' : 'light';
    }
    root.setAttribute('data-theme', themeToApply);

    // Font Family
    let fontFamily = '"PT Serif", Georgia, serif';
    if (s.fontFamily === 'sans') {
      fontFamily = '-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", sans-serif';
    } else if (s.fontFamily === 'dyslexic') {
      fontFamily = '"Lexend", "Atkinson Hyperlegible", "Comic Sans MS", sans-serif';
    }
    root.style.setProperty('--reader-font-family', fontFamily);

    // Font size & line height & margin
    root.style.setProperty('--reader-font-size', `${s.fontSize}px`);
    root.style.setProperty('--reader-line-height', s.lineHeight);

    let margin = '20px';
    if (s.margin === 'compact') margin = '12px';
    else if (s.margin === 'spacious') margin = '30px';
    root.style.setProperty('--reader-margin-inline', margin);

    root.style.setProperty('--reader-text-align', s.textAlign);

    // Brightness overlay
    const brightnessVal = s.brightness || 100;
    const dimAlpha = (100 - brightnessVal) / 100 * 0.75; // max 75% dark overlay
    this.brightnessOverlay.style.opacity = dimAlpha.toString();
  }

  async updateSettings(partial) {
    this.settings = await storage.saveSettings(partial);
    this.applySettings();
    if (partial.readingMode || partial.fontSize || partial.margin) {
      // Re-calculate layout
      if (this.settings.readingMode === 'paginate') {
        this.content.classList.add('mode-paginate');
        this.content.classList.remove('mode-scroll');
        this.calculatePagination();
        this.goToPage(this.currentPageIndex);
      } else {
        this.content.classList.remove('mode-paginate');
        this.content.classList.add('mode-scroll');
        this.content.style.transform = 'none';
      }
    }
  }

  // --- Highlights & Bookmarks ---
  addBookmark() {
    if (!this.book) return;
    const ch = this.book.chapters[this.currentChapterIndex];
    const bId = 'bm_' + Date.now();
    const snippet = this.content.textContent.slice(0, 120).trim() + '...';

    this.book.bookmarks = this.book.bookmarks || [];
    this.book.bookmarks.push({
      id: bId,
      chapterIndex: this.currentChapterIndex,
      pageIndex: this.currentPageIndex,
      title: ch?.title || `Глава ${this.currentChapterIndex + 1}`,
      snippet,
      createdAt: Date.now()
    });

    storage.saveBook(this.book);
    this.haptic('notification_success');
    this.app.toast('🔖 Закладка добавлена');
  }

  addHighlight(color = 'yellow', note = '') {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    const text = sel.toString().trim();
    if (!text) return;

    this.book.highlights = this.book.highlights || [];
    this.book.highlights.push({
      id: 'hl_' + Date.now(),
      chapterIndex: this.currentChapterIndex,
      text,
      note,
      color,
      createdAt: Date.now()
    });

    storage.saveBook(this.book);
    this.applyHighlightsToDom();
    sel.removeAllRanges();
    this.haptic('impact');
    this.app.toast('Цитата сохранена');
  }

  applyHighlightsToDom() {
    if (!this.book?.highlights?.length) return;
    const chapterHighlights = this.book.highlights.filter(h => h.chapterIndex === this.currentChapterIndex);
    if (!chapterHighlights.length) return;

    let html = this.content.innerHTML;
    chapterHighlights.forEach(hl => {
      // Escape for regex
      const safeText = hl.text.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const reg = new RegExp(`(${safeText})`, 'gi');
      html = html.replace(reg, `<mark class="book-highlight color-${hl.color}">$1</mark>`);
    });
    this.content.innerHTML = html;
  }

  // --- Haptic Feedback Helper ---
  haptic(type = 'impact') {
    if (window.Telegram?.WebApp?.HapticFeedback) {
      try {
        if (type === 'impact') {
          window.Telegram.WebApp.HapticFeedback.impactOccurred('light');
        } else if (type === 'selection_changed') {
          window.Telegram.WebApp.HapticFeedback.selectionChanged();
        } else if (type === 'notification_success') {
          window.Telegram.WebApp.HapticFeedback.notificationOccurred('success');
        }
      } catch (e) {}
    }
  }

  initEvents() {
    // Tap Zones
    const tapLeft = document.getElementById('tap-left');
    const tapCenter = document.getElementById('tap-center');
    const tapRight = document.getElementById('tap-right');

    tapLeft?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.prevPage();
    });

    tapRight?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.nextPage();
    });

    tapCenter?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleBars();
    });

    // Keyboard navigation
    window.addEventListener('keydown', (e) => {
      if (this.view.classList.contains('hidden')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        this.nextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        this.prevPage();
      } else if (e.key === 'Escape') {
        this.closeReader();
      }
    });

    // Scrubber
    this.progressBar?.addEventListener('input', (e) => {
      const targetPercent = parseInt(e.target.value, 10);
      const totalCh = this.book.chapters?.length || 1;
      const targetChapter = Math.min(totalCh - 1, Math.floor((targetPercent / 100) * totalCh));
      if (targetChapter !== this.currentChapterIndex) {
        this.renderChapter(targetChapter);
      }
    });

    // Mode Toggle
    this.modeToggleBtn?.addEventListener('click', () => {
      this.togglePdfMode();
    });

    // Back button in reader header
    document.getElementById('reader-back-btn')?.addEventListener('click', () => {
      this.closeReader();
    });

    // Resize listener to recalculate columns
    window.addEventListener('resize', () => {
      if (this.settings?.readingMode === 'paginate') {
        this.calculatePagination();
        this.goToPage(this.currentPageIndex);
      }
    });
  }
}
