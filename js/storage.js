/**
 * Storage Layer
 * IndexedDB for full book data + files
 * Telegram CloudStorage / localStorage for sync (shelves, progress, settings)
 */

const DB_NAME = 'AntigravityReaderDB';
const DB_VERSION = 1;

export const DEFAULT_SHELVES = [
  { id: 'shelf_economics', name: 'Экономика', emoji: '📈', color: '#10b981', isSystem: true, order: 1 },
  { id: 'shelf_psychology', name: 'Психология', emoji: '🧠', color: '#8b5cf6', isSystem: true, order: 2 },
  { id: 'shelf_none', name: 'Без полки', emoji: '📁', color: '#6b7280', isSystem: true, order: 3 }
];

export const DEFAULT_SETTINGS = {
  theme: 'auto', // 'light' | 'sepia' | 'dark' | 'amoled' | 'auto'
  fontFamily: 'serif', // 'serif' | 'sans' | 'dyslexic'
  fontSize: 18, // px
  lineHeight: 1.6,
  margin: 'normal', // 'compact' | 'normal' | 'spacious'
  textAlign: 'justify', // 'justify' | 'left'
  readingMode: 'paginate', // 'paginate' | 'scroll'
  brightness: 100 // 30 - 100 (%)
};

class StorageManager {
  constructor() {
    this.db = null;
    this.dbPromise = this.initDB();
  }

  initDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('shelves')) {
          db.createObjectStore('shelves', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      req.onerror = (e) => {
        console.error('IndexedDB open error:', e);
        reject(e);
      };
    });
  }

  async getDB() {
    if (!this.db) {
      await this.dbPromise;
    }
    return this.db;
  }

  // --- Books ---
  async getAllBooks() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', 'readonly');
      const store = tx.objectStore('books');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getBook(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', 'readonly');
      const store = tx.objectStore('books');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async saveBook(book) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', 'readwrite');
      const store = tx.objectStore('books');
      const req = store.put(book);
      req.onsuccess = () => {
        this.syncProgressToCloud(book.id, book.progress, book.shelfId, book.status);
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteBook(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['books', 'files'], 'readwrite');
      tx.objectStore('books').delete(id);
      tx.objectStore('files').delete(id);
      tx.oncomplete = () => {
        this.removeBookFromCloud(id);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- Raw File Blob (for PDF rendering/export) ---
  async saveFileBlob(id, blobOrBuffer) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ id, data: blobOrBuffer });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getFileBlob(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').get(id);
      req.onsuccess = () => resolve(req.result?.data || null);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Shelves ---
  async getShelves() {
    const db = await this.getDB();
    const storedShelves = await new Promise((resolve, reject) => {
      const tx = db.transaction('shelves', 'readonly');
      const req = tx.objectStore('shelves').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    if (!storedShelves.length) {
      // Seed default shelves
      for (const shelf of DEFAULT_SHELVES) {
        await this.saveShelf(shelf);
      }
      return DEFAULT_SHELVES;
    }

    return storedShelves.sort((a, b) => (a.order || 99) - (b.order || 99));
  }

  async saveShelf(shelf) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('shelves', 'readwrite');
      tx.objectStore('shelves').put(shelf);
      tx.oncomplete = () => {
        this.syncShelvesToCloud();
        resolve(shelf);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteShelf(id) {
    const db = await this.getDB();
    // Re-assign books from this shelf to 'shelf_none'
    const books = await this.getAllBooks();
    for (const b of books) {
      if (b.shelfId === id) {
        b.shelfId = 'shelf_none';
        await this.saveBook(b);
      }
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction('shelves', 'readwrite');
      tx.objectStore('shelves').delete(id);
      tx.oncomplete = () => {
        this.syncShelvesToCloud();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- Settings ---
  async getSettings() {
    const local = localStorage.getItem('agy_reader_settings');
    if (local) {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(local) };
      } catch (e) {}
    }
    return { ...DEFAULT_SETTINGS };
  }

  async saveSettings(settings) {
    const current = await this.getSettings();
    const updated = { ...current, ...settings };
    localStorage.setItem('agy_reader_settings', JSON.stringify(updated));
    this.cloudSet('reader_settings', JSON.stringify(updated));
    return updated;
  }

  // --- Cloud Storage Sync ---
  cloudSet(key, value) {
    if (window.Telegram?.WebApp?.CloudStorage) {
      try {
        window.Telegram.WebApp.CloudStorage.setItem(key, value, (err, ok) => {
          if (err) console.warn('TG CloudStorage setItem error:', err);
        });
      } catch (e) {
        console.warn('TG CloudStorage exception:', e);
      }
    }
  }

  cloudGet(key) {
    return new Promise((resolve) => {
      if (window.Telegram?.WebApp?.CloudStorage) {
        try {
          window.Telegram.WebApp.CloudStorage.getItem(key, (err, value) => {
            if (!err && value) resolve(value);
            else resolve(null);
          });
          return;
        } catch (e) {}
      }
      resolve(null);
    });
  }

  async syncProgressToCloud(bookId, progress, shelfId, status) {
    const key = `prog_${bookId}`;
    const payload = JSON.stringify({ progress, shelfId, status, updatedAt: Date.now() });
    this.cloudSet(key, payload);
  }

  async removeBookFromCloud(bookId) {
    if (window.Telegram?.WebApp?.CloudStorage) {
      try {
        window.Telegram.WebApp.CloudStorage.removeItem(`prog_${bookId}`, () => {});
      } catch (e) {}
    }
  }

  async syncShelvesToCloud() {
    const shelves = await this.getShelves();
    const custom = shelves.filter(s => !s.isSystem);
    this.cloudSet('custom_shelves', JSON.stringify(custom));
  }
}

export const storage = new StorageManager();
