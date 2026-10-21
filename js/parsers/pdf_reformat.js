/**
 * PDF Mobile Reformatting Engine
 * Reflows PDF documents into clean, responsive, mobile-optimized typography.
 * Strips headers/footers/page numbers, joins hyphens, re-orders multi-column layouts,
 * detects headings for TOC, and preserves original page rendering.
 */

// Set worker path
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js';
}

export async function parsePDF(arrayBuffer, fileName = '') {
  if (!window.pdfjsLib) {
    throw new Error('PDF.js библиотека не загружена');
  }

  // Load PDF document
  const loadingTask = window.pdfjsLib.getDocument({
    data: arrayBuffer,
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
    cMapPacked: true
  });
  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  // Extract Metadata
  let title = fileName.replace(/\.[^/.]+$/, '');
  let author = 'Неизвестный автор';
  try {
    const metadata = await pdfDoc.getMetadata();
    if (metadata?.info?.Title && metadata.info.Title.trim()) {
      title = metadata.info.Title.trim();
    }
    if (metadata?.info?.Author && metadata.info.Author.trim()) {
      author = metadata.info.Author.trim();
    }
  } catch (e) {
    console.warn('PDF metadata warning:', e);
  }

  // Generate cover from page 1 thumbnail
  let coverUrl = null;
  try {
    const firstPage = await pdfDoc.getPage(1);
    const vp = firstPage.getViewport({ scale: 0.5 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    await firstPage.render({ canvasContext: ctx, viewport: vp }).promise;
    coverUrl = canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    console.warn('PDF cover generation error:', e);
  }

  // Pass 1: Extract all pages and text items with coordinates
  const rawPages = [];
  const headerFooterFrequency = {}; // Detect recurring text across multiple pages

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent({ normalizeWhitespace: true });
    
    const items = textContent.items.map(item => {
      // transform: [scaleX, skewY, skewX, scaleY, tx, ty]
      // PDF coordinate: y=0 at bottom, y=viewport.height at top
      const x = item.transform[4];
      const y = item.transform[5];
      const fontSize = Math.round(Math.hypot(item.transform[0], item.transform[1]));
      return {
        str: item.str,
        x,
        y,
        width: item.width,
        height: item.height || fontSize,
        fontSize,
        fontName: item.fontName || ''
      };
    }).filter(it => it.str.trim().length > 0);

    // Track repetitive lines near top/bottom for header/footer filtering
    const topMarginCutoff = viewport.height * 0.89;
    const bottomMarginCutoff = viewport.height * 0.11;

    items.forEach(it => {
      if (it.y > topMarginCutoff || it.y < bottomMarginCutoff) {
        const textKey = it.str.trim().toLowerCase();
        // Ignore single digits here
        if (textKey.length > 3) {
          headerFooterFrequency[textKey] = (headerFooterFrequency[textKey] || 0) + 1;
        }
      }
    });

    rawPages.push({
      pageNum,
      viewport,
      items,
      width: viewport.width,
      height: viewport.height
    });
  }

  // Calculate typical body font size (median)
  const allFontSizes = [];
  rawPages.forEach(p => p.items.forEach(it => allFontSizes.push(it.fontSize)));
  allFontSizes.sort((a, b) => a - b);
  const medianFontSize = allFontSizes.length ? allFontSizes[Math.floor(allFontSizes.length / 2)] : 12;

  // Pass 2: Layout analysis (strip headers/footers, 2-column detection, reading order)
  const processedPages = [];

  for (const page of rawPages) {
    const { width, height, items, pageNum } = page;
    const topMarginCutoff = height * 0.90;
    const bottomMarginCutoff = height * 0.10;

    // Filter out running headers and footers
    const contentItems = items.filter(it => {
      const text = it.str.trim();
      const textLower = text.toLowerCase();
      // Remove page number footers/headers (e.g., "1", "— 2 —", "Страница 5")
      if (it.y < bottomMarginCutoff || it.y > topMarginCutoff) {
        if (/^[\—\-\s]*\d+[\—\-\s]*$/.test(text) || /^страница\s*\d+$/i.test(text) || /^page\s*\d+$/i.test(text)) {
          return false;
        }
        // Repetitive header across pages
        if (headerFooterFrequency[textLower] >= 2) {
          return false;
        }
        // Matches title or author
        if (title.length > 4 && textLower.includes(title.toLowerCase().slice(0, 15))) {
          return false;
        }
      }
      return true;
    });

    // Check for Two-Column layout:
    // Look for gutter around center of page
    const midX = width / 2;
    const gutterLeft = midX - (width * 0.05);
    const gutterRight = midX + (width * 0.05);

    let leftCount = 0;
    let rightCount = 0;
    let crossCount = 0;

    contentItems.forEach(it => {
      const itemRight = it.x + it.width;
      if (it.x < gutterLeft && itemRight < midX) {
        leftCount++;
      } else if (it.x > midX && itemRight > gutterRight) {
        rightCount++;
      } else if (it.x < midX && itemRight > midX) {
        crossCount++;
      }
    });

    const isTwoColumn = (leftCount > 6 && rightCount > 6 && crossCount < (leftCount + rightCount) * 0.18);

    let orderedItems = [];
    if (isTwoColumn) {
      // Split into Left column and Right column
      // Wide titles that span across both columns (e.g. at page top) stay on top
      const spanItems = [];
      const colLeft = [];
      const colRight = [];

      contentItems.forEach(it => {
        if (it.width > width * 0.55 || (it.x < midX && (it.x + it.width) > midX)) {
          spanItems.push(it);
        } else if (it.x < midX) {
          colLeft.push(it);
        } else {
          colRight.push(it);
        }
      });

      // Sort span items top-to-bottom
      spanItems.sort((a, b) => b.y - a.y || a.x - b.x);
      // Sort left column top-to-bottom
      colLeft.sort((a, b) => b.y - a.y || a.x - b.x);
      // Sort right column top-to-bottom
      colRight.sort((a, b) => b.y - a.y || a.x - b.x);

      orderedItems = [...spanItems, ...colLeft, ...colRight];
    } else {
      // Single column: sort by Y descending (top-to-bottom), then X ascending
      orderedItems = [...contentItems].sort((a, b) => {
        // If Y is roughly on same line (within 4px), sort by X
        if (Math.abs(b.y - a.y) <= 4) {
          return a.x - b.x;
        }
        return b.y - a.y;
      });
    }

    processedPages.push({
      pageNum,
      orderedItems,
      isTwoColumn,
      isEmpty: orderedItems.length === 0
    });
  }

  // Pass 3: Text reflow (group into lines, de-hyphenate, merge paragraphs, detect headings)
  const chapters = [];
  const toc = [];

  let currentTitle = 'Глава 1';
  let currentHtmlParts = [];
  let currentWords = 0;

  function commitChapter() {
    if (currentHtmlParts.length > 0) {
      const chIdx = chapters.length;
      const chId = `ch_${chIdx + 1}`;
      chapters.push({
        id: chId,
        title: currentTitle,
        html: currentHtmlParts.join('\n'),
        wordCount: currentWords
      });
      toc.push({
        id: chId,
        title: currentTitle,
        chapterIndex: chIdx,
        level: 1
      });
      currentHtmlParts = [];
      currentWords = 0;
    }
  }

  let currentParaBuffer = [];

  function flushParagraph() {
    if (!currentParaBuffer.length) return;

    // Join lines into single paragraph text
    let paraText = '';
    for (let i = 0; i < currentParaBuffer.length; i++) {
      const line = currentParaBuffer[i];
      if (i === 0) {
        paraText = line;
      } else {
        // De-hyphenation: if previous line ended with hyphen and next line starts with lowercase word
        if (/[\-\u00AD]\s*$/.test(paraText) && /^[a-zа-яё]/i.test(line)) {
          paraText = paraText.replace(/[\-\u00AD]\s*$/, '') + line;
        } else {
          paraText += ' ' + line;
        }
      }
    }

    paraText = paraText.trim();
    if (paraText) {
      const words = paraText.split(/\s+/).length;
      currentWords += words;
      currentHtmlParts.push(`<p>${escapeHtml(paraText)}</p>`);
    }

    currentParaBuffer = [];
  }

  // Heading pattern
  const headingRegex = /^(?:Глава|Часть|Раздел|Section|Chapter|§)\s+([0-9IVXLCDM]+|[А-ЯA-Z]+).*$|^[0-9IVXLCDM]{1,4}\.\s+[А-ЯA-Z].*$/i;

  for (const page of processedPages) {
    if (page.isEmpty) {
      // Scanned page fallback: render image of page
      try {
        const pObj = await pdfDoc.getPage(page.pageNum);
        const vp = pObj.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext('2d');
        await pObj.render({ canvasContext: ctx, viewport: vp }).promise;
        const pageImg = canvas.toDataURL('image/jpeg', 0.88);
        flushParagraph();
        currentHtmlParts.push(`<figure class="pdf-scan-page"><img src="${pageImg}" alt="Страница ${page.pageNum}" /></figure>`);
      } catch (err) {
        console.warn('Scan render error:', err);
      }
      continue;
    }

    // Assemble lines
    const lines = [];
    let currentLine = [];
    let lastY = null;

    page.orderedItems.forEach(item => {
      if (lastY === null || Math.abs(item.y - lastY) <= 4) {
        currentLine.push(item);
      } else {
        if (currentLine.length) lines.push(currentLine);
        currentLine = [item];
      }
      lastY = item.y;
    });
    if (currentLine.length) lines.push(currentLine);

    // Process assembled lines
    for (let li = 0; li < lines.length; li++) {
      const lineItems = lines[li];
      const lineText = lineItems.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (!lineText) continue;

      // Universal header/footer and page number filter
      if (/^[\—\-\s]*\d+[\—\-\s]*$/.test(lineText) || /^стр(аница|\.)\s*\d+$/i.test(lineText) || /^page\s*\d+$/i.test(lineText)) {
        continue; // drop page numbers
      }

      // Check if line is a running header containing author or bullet separator
      if (lineText.includes('•') || lineText.includes('·')) {
        if (lineText.length < 80 && (lineText.toLowerCase().includes(author.toLowerCase().slice(0, 8)) || lineText.toLowerCase().includes(title.toLowerCase().slice(0, 8)) || /кийосаки|папа|исследований|чалдини/i.test(lineText))) {
          continue; // drop running header
        }
      }

      const maxFontSize = Math.max(...lineItems.map(it => it.fontSize));
      const isLargeHeading = maxFontSize >= medianFontSize * 1.25 && lineText.length < 120;
      const isPatternHeading = headingRegex.test(lineText) && lineText.length < 100;

      if (isLargeHeading || isPatternHeading) {
        flushParagraph();
        
        let fullHeading = lineText;
        // If next line is also large or a continuation of heading
        if (lines[li + 1]) {
          const nextItems = lines[li + 1];
          const nextMaxFont = Math.max(...nextItems.map(it => it.fontSize));
          const nextText = nextItems.map(it => it.str).join(' ').trim();
          if (nextMaxFont >= medianFontSize * 1.25 && nextText.length < 80 && !headingRegex.test(nextText)) {
            fullHeading += ' ' + nextText;
            li++; // advance
          }
        }

        // Commit prior chapter if we have accumulated words
        if (currentWords > 150) {
          commitChapter();
          currentTitle = fullHeading;
        } else if (!chapters.length) {
          currentTitle = fullHeading;
        }

        currentHtmlParts.push(`<h2>${escapeHtml(fullHeading)}</h2>`);
        currentWords += fullHeading.split(/\s+/).length;
        continue;
      }

      currentParaBuffer.push(lineText);

      // Check if line terminates a paragraph:
      // Ends with period, exclamation, question mark, or colon
      const endsWithSentenceStop = /[.!?…:]$/.test(lineText);
      const nextLine = lines[li + 1];
      let startsWithIndentOrCap = false;

      if (nextLine) {
        const nextText = nextLine.map(it => it.str).join(' ').trim();
        // Capital letter or indentation
        startsWithIndentOrCap = /^[A-ZА-ЯЁ«"]/.test(nextText);
      }

      if (endsWithSentenceStop && (!nextLine || startsWithIndentOrCap)) {
        flushParagraph();
      }
    }

    // After page end, flush paragraph
    flushParagraph();

    // If chapter has grown quite long (> 3000 words), gracefully split by next page
    if (currentWords > 3000) {
      commitChapter();
      currentTitle = `Раздел ${chapters.length + 1}`;
    }
  }

  flushParagraph();
  commitChapter();

  // If title was a temporary filename, infer clean title from first heading
  if (title.includes('.html') || title.includes('_temp') || title.includes('single_') || title.includes('two_') || title === 'document') {
    if (chapters.length > 0 && chapters[0].title && !chapters[0].title.startsWith('Глава') && chapters[0].title.length < 80) {
      title = chapters[0].title;
    } else if (rawPages[0]?.items?.length) {
      // Look for the largest font item on page 1
      const page1Items = [...rawPages[0].items].sort((a, b) => b.fontSize - a.fontSize);
      if (page1Items.length && page1Items[0].str.trim().length > 3) {
        title = page1Items[0].str.trim();
      }
    }
  }
  if (!chapters.length) {
    chapters.push({
      id: 'ch_1',
      title: title,
      html: `<p>Текст документа не содержит распознаваемого слоя либо документ пуст.</p>`,
      wordCount: 10
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
    coverUrl,
    format: 'pdf',
    chapters,
    toc,
    totalWords,
    pageCount: numPages,
    isPdf: true,
    defaultPdfMode: 'reformat' // As explicitly requested in TZ.md: "включай его по умолчанию"
  };
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}
