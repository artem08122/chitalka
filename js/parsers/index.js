/**
 * Universal Book Parser Dispatcher
 */
import { parseFB2 } from './fb2.js';
import { parseEPUB } from './epub.js';
import { parseDOCX } from './docx.js';
import { parseTXT } from './txt.js';
import { parsePDF } from './pdf_reformat.js';

export async function parseBookFile(file, activeShelfId = 'shelf_none') {
  const fileName = file.name || 'document';
  const ext = fileName.split('.').pop().toLowerCase();
  const isFb2Zip = fileName.toLowerCase().endsWith('.fb2.zip');

  const arrayBuffer = await file.arrayBuffer();
  let parsed = null;

  if (isFb2Zip || ext === 'fb2') {
    parsed = await parseFB2(arrayBuffer, fileName);
  } else if (ext === 'epub') {
    parsed = await parseEPUB(arrayBuffer, fileName);
  } else if (ext === 'pdf') {
    parsed = await parsePDF(arrayBuffer, fileName);
  } else if (ext === 'docx') {
    parsed = await parseDOCX(arrayBuffer, fileName);
  } else if (ext === 'txt') {
    parsed = await parseTXT(arrayBuffer, fileName);
  } else if (ext === 'html' || ext === 'htm') {
    parsed = await parseHTML(arrayBuffer, fileName);
  } else if (ext === 'rtf') {
    parsed = await parseRTF(arrayBuffer, fileName);
  } else {
    // Attempt fallback to text/fb2
    try {
      parsed = await parseFB2(arrayBuffer, fileName);
    } catch (e) {
      parsed = await parseTXT(arrayBuffer, fileName);
    }
  }

  // Create unified book record
  const bookId = 'book_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

  return {
    id: bookId,
    title: parsed.title || fileName.replace(/\.[^/.]+$/, ''),
    author: parsed.author || 'Неизвестный автор',
    genre: parsed.genre || '',
    format: parsed.format || ext,
    shelfId: activeShelfId,
    status: 'not_started', // 'not_started' | 'reading' | 'completed'
    coverUrl: parsed.coverUrl || null,
    addedAt: Date.now(),
    lastReadAt: null,
    totalWords: parsed.totalWords || 0,
    pageCount: parsed.pageCount || null,
    progress: {
      chapterIndex: 0,
      scrollRatio: 0,
      pageIndex: 0,
      totalPages: 1,
      percent: 0,
      wordsRead: 0,
      estimatedMinutesRemaining: Math.ceil((parsed.totalWords || 0) / 200)
    },
    toc: parsed.toc || [],
    chapters: parsed.chapters || [],
    bookmarks: [],
    highlights: [],
    settings: {
      pdfMode: parsed.defaultPdfMode || 'reformat'
    },
    fileName: fileName,
    fileSize: file.size || arrayBuffer.byteLength
  };
}

async function parseHTML(arrayBuffer, fileName) {
  const text = new TextDecoder().decode(arrayBuffer);
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/html');

  const title = doc.querySelector('title, h1')?.textContent?.trim() || fileName.replace(/\.[^/.]+$/, '');
  const author = doc.querySelector('meta[name="author"]')?.getAttribute('content') || 'Неизвестный автор';

  doc.querySelectorAll('script, style, link').forEach(el => el.remove());
  const body = doc.body;

  const chapters = [{
    id: 'ch_1',
    title: title,
    html: body.innerHTML,
    wordCount: body.textContent.trim().split(/\s+/).length
  }];

  return {
    title,
    author,
    coverUrl: null,
    format: 'html',
    chapters,
    toc: [{ id: 'ch_1', title, chapterIndex: 0, level: 1 }],
    totalWords: chapters[0].wordCount
  };
}

async function parseRTF(arrayBuffer, fileName) {
  const rawText = new TextDecoder('windows-1251').decode(arrayBuffer);
  // Basic RTF stripping
  let text = rawText
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\[a-z0-9\-]+/gi, '')
    .replace(/[{}\\]/g, '')
    .trim();

  return parseTXT(text, fileName);
}
