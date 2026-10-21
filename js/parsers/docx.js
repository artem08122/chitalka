/**
 * DOCX Parser
 * Uses Mammoth.js for semantic HTML conversion, with docProps metadata extraction
 */
export async function parseDOCX(arrayBuffer, fileName = '') {
  let title = fileName.replace(/\.[^/.]+$/, '');
  let author = 'Неизвестный автор';

  // 1. Try to extract metadata from docProps/core.xml via JSZip
  if (window.JSZip) {
    try {
      const zip = await window.JSZip.loadAsync(arrayBuffer);
      const coreFile = zip.file('docProps/core.xml');
      if (coreFile) {
        const coreXml = await coreFile.async('text');
        const parser = new DOMParser();
        const doc = parser.parseFromString(coreXml, 'application/xml');
        const extractedTitle = doc.querySelector('title, dc\\:title')?.textContent?.trim();
        const extractedCreator = doc.querySelector('creator, dc\\:creator')?.textContent?.trim();
        if (extractedTitle) title = extractedTitle;
        if (extractedCreator) author = extractedCreator;
      }
    } catch (e) {
      console.warn('DOCX core.xml parsing warning:', e);
    }
  }

  // 2. Convert to HTML using Mammoth
  let html = '';
  if (window.mammoth) {
    const result = await window.mammoth.convertToHtml({ arrayBuffer });
    html = result.value;
  } else {
    throw new Error('Mammoth.js библиотека не найдена');
  }

  // 3. Split HTML into chapters by h1, h2, h3
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild || doc.body;

  const chapters = [];
  const toc = [];

  let currentTitle = title;
  let currentParts = [];
  let currentWords = 0;

  function commitChapter() {
    if (currentParts.length > 0) {
      const chIdx = chapters.length;
      const chId = `ch_${chIdx + 1}`;
      chapters.push({
        id: chId,
        title: currentTitle,
        html: currentParts.join('\n'),
        wordCount: currentWords
      });
      toc.push({
        id: chId,
        title: currentTitle,
        chapterIndex: chIdx,
        level: 1
      });
      currentParts = [];
      currentWords = 0;
    }
  }

  for (const child of Array.from(root.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2') {
      const headingText = child.textContent.trim();
      if (headingText) {
        // If we already have content, commit prior chapter
        if (currentParts.length > 0) {
          commitChapter();
        }
        currentTitle = headingText;
        currentParts.push(`<h2>${child.innerHTML}</h2>`);
        currentWords += headingText.split(/\s+/).length;
        continue;
      }
    }

    const text = child.textContent.trim();
    if (text) {
      currentWords += text.split(/\s+/).length;
    }
    currentParts.push(child.outerHTML);

    // If chapter gets too long (> 3000 words) and next element is a heading or separator, chunk it
    if (currentWords > 3500 && tag === 'h3') {
      commitChapter();
      currentTitle = child.textContent.trim() || `Часть ${chapters.length + 1}`;
    }
  }

  commitChapter();

  // If no chapters created (e.g. single small text), create one
  if (chapters.length === 0) {
    const rawText = root.textContent.trim();
    const words = rawText ? rawText.split(/\s+/).length : 0;
    chapters.push({
      id: 'ch_1',
      title: title,
      html: root.innerHTML || `<p>${rawText}</p>`,
      wordCount: words
    });
    toc.push({
      id: 'ch_1',
      title: title,
      chapterIndex: 0,
      level: 1
    });
  }

  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);

  return {
    title,
    author,
    coverUrl: null,
    format: 'docx',
    chapters,
    toc,
    totalWords
  };
}
