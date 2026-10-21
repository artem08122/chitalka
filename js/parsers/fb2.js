/**
 * FB2 and FB2.zip parser
 * FictionBook 2.0 XML parser with image extraction and section hierarchy
 */
export async function parseFB2(fileOrBuffer, fileName = '') {
  let xmlString = '';
  let jszipInstance = null;

  // Handle FB2.zip or ArrayBuffer
  if (fileOrBuffer instanceof ArrayBuffer || fileOrBuffer instanceof Uint8Array) {
    const bytes = new Uint8Array(fileOrBuffer);
    // Check for ZIP magic PK\x03\x04
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
      if (window.JSZip) {
        jszipInstance = await window.JSZip.loadAsync(fileOrBuffer);
        // Find .fb2 file inside zip
        const fb2File = Object.values(jszipInstance.files).find(f => !f.dir && f.name.toLowerCase().endsWith('.fb2'))
                     || Object.values(jszipInstance.files).find(f => !f.dir);
        if (!fb2File) throw new Error('Не найден FB2 файл внутри ZIP архива');
        xmlString = await fb2File.async('text');
      } else {
        throw new Error('JSZip не загружен');
      }
    } else {
      xmlString = new TextDecoder('utf-8').decode(bytes);
    }
  } else if (typeof fileOrBuffer === 'string') {
    xmlString = fileOrBuffer;
  }

  // Parse XML
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    // Try windows-1251 if utf-8 failed
    if (fileOrBuffer instanceof ArrayBuffer || fileOrBuffer instanceof Uint8Array) {
      try {
        xmlString = new TextDecoder('windows-1251').decode(fileOrBuffer);
        const retryDoc = parser.parseFromString(xmlString, 'application/xml');
        if (!retryDoc.querySelector('parsererror')) {
          return processFB2Doc(retryDoc, fileName);
        }
      } catch (e) {
        // ignore
      }
    }
    throw new Error('Ошибка парсинга FB2 XML: ' + parserError.textContent.slice(0, 100));
  }

  return processFB2Doc(doc, fileName);
}

function processFB2Doc(doc, fileName) {
  // 1. Metadata
  const titleInfo = doc.querySelector('description title-info') || doc.querySelector('title-info');
  let title = titleInfo?.querySelector('book-title')?.textContent?.trim() || fileName.replace(/\.[^/.]+$/, '');
  
  // Author
  let author = '';
  const authorNode = titleInfo?.querySelector('author');
  if (authorNode) {
    const firstName = authorNode.querySelector('first-name')?.textContent?.trim() || '';
    const middleName = authorNode.querySelector('middle-name')?.textContent?.trim() || '';
    const lastName = authorNode.querySelector('last-name')?.textContent?.trim() || '';
    author = [firstName, middleName, lastName].filter(Boolean).join(' ');
  }
  if (!author) author = 'Неизвестный автор';

  // Genre
  const genre = titleInfo?.querySelector('genre')?.textContent?.trim() || '';

  // Annotation
  const annotation = titleInfo?.querySelector('annotation')?.textContent?.trim() || '';

  // 2. Binaries (images)
  const binaries = {};
  doc.querySelectorAll('binary').forEach(bin => {
    const id = bin.getAttribute('id') || '';
    const contentType = bin.getAttribute('content-type') || 'image/jpeg';
    const b64 = bin.textContent.replace(/\s+/g, '');
    if (id && b64) {
      binaries[id] = `data:${contentType};base64,${b64}`;
    }
  });

  // Cover image
  let coverUrl = null;
  const coverImage = titleInfo?.querySelector('coverpage image');
  if (coverImage) {
    const href = coverImage.getAttribute('l:href') || coverImage.getAttribute('xlink:href') || coverImage.getAttribute('href') || '';
    const coverId = href.replace(/^#/, '');
    if (binaries[coverId]) {
      coverUrl = binaries[coverId];
    }
  }
  // Fallback cover if coverpage image wasn't found but binary exists
  if (!coverUrl && Object.keys(binaries).length > 0) {
    const firstBinId = Object.keys(binaries).find(k => /cover/i.test(k)) || Object.keys(binaries)[0];
    coverUrl = binaries[firstBinId];
  }

  // 3. Chapters extraction
  const chapters = [];
  const toc = [];

  const bodies = doc.querySelectorAll('body');
  // First body is usually main text, subsequent bodies may be notes
  const mainBody = bodies[0] || doc;
  const sections = mainBody.querySelectorAll(':scope > section');

  if (sections.length > 0) {
    sections.forEach((sec, idx) => {
      const { title: chTitle, html, wordCount } = processSection(sec, binaries, idx + 1);
      chapters.push({
        id: `ch_${idx + 1}`,
        title: chTitle || `Раздел ${idx + 1}`,
        html,
        wordCount
      });
      toc.push({
        id: `ch_${idx + 1}`,
        title: chTitle || `Раздел ${idx + 1}`,
        chapterIndex: idx,
        level: 1
      });
    });
  } else {
    // No top-level sections: entire body is one chapter
    const { title: chTitle, html, wordCount } = processSection(mainBody, binaries, 1);
    chapters.push({
      id: 'ch_1',
      title: chTitle || title || 'Глава 1',
      html,
      wordCount
    });
    toc.push({
      id: 'ch_1',
      title: chTitle || title || 'Глава 1',
      chapterIndex: 0,
      level: 1
    });
  }

  // Calculate total words
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);

  return {
    title,
    author,
    genre,
    annotation,
    coverUrl,
    format: 'fb2',
    chapters,
    toc,
    totalWords
  };
}

function processSection(sectionNode, binaries, fallbackNum) {
  let chTitle = '';
  const titleNode = sectionNode.querySelector(':scope > title');
  if (titleNode) {
    chTitle = Array.from(titleNode.querySelectorAll('p'))
      .map(p => p.textContent.trim())
      .filter(Boolean)
      .join(' ') || titleNode.textContent.trim();
  }

  let htmlParts = [];
  if (chTitle) {
    htmlParts.push(`<h2>${escapeHtml(chTitle)}</h2>`);
  }

  let wordCount = 0;

  function renderNodes(parent) {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'title' && child === titleNode) {
          continue; // already rendered
        }
        if (tag === 'p') {
          const text = child.textContent.trim();
          if (text) {
            wordCount += text.split(/\s+/).length;
            htmlParts.push(`<p>${escapeHtml(text)}</p>`);
          }
        } else if (tag === 'empty-line') {
          htmlParts.push('<div class="spacer"></div>');
        } else if (tag === 'subtitle') {
          htmlParts.push(`<h3>${escapeHtml(child.textContent.trim())}</h3>`);
        } else if (tag === 'cite' || tag === 'blockquote') {
          const text = child.textContent.trim();
          wordCount += text.split(/\s+/).length;
          htmlParts.push(`<blockquote>${escapeHtml(text)}</blockquote>`);
        } else if (tag === 'poem') {
          htmlParts.push('<div class="poem">');
          renderNodes(child);
          htmlParts.push('</div>');
        } else if (tag === 'stanza') {
          htmlParts.push('<div class="stanza">');
          renderNodes(child);
          htmlParts.push('</div>');
        } else if (tag === 'v') {
          htmlParts.push(`<p class="verse">${escapeHtml(child.textContent.trim())}</p>`);
        } else if (tag === 'image') {
          const href = child.getAttribute('l:href') || child.getAttribute('xlink:href') || child.getAttribute('href') || '';
          const imgId = href.replace(/^#/, '');
          if (binaries[imgId]) {
            htmlParts.push(`<figure class="book-fig"><img src="${binaries[imgId]}" alt="Рисунок" /></figure>`);
          }
        } else if (tag === 'section') {
          // Nested section
          const subTitleNode = child.querySelector(':scope > title');
          if (subTitleNode) {
            const subTitle = subTitleNode.textContent.trim();
            htmlParts.push(`<h3>${escapeHtml(subTitle)}</h3>`);
          }
          renderNodes(child);
        } else {
          renderNodes(child);
        }
      }
    }
  }

  renderNodes(sectionNode);

  if (!htmlParts.length) {
    const rawText = sectionNode.textContent.trim();
    if (rawText) {
      wordCount = rawText.split(/\s+/).length;
      htmlParts.push(`<p>${escapeHtml(rawText)}</p>`);
    }
  }

  return {
    title: chTitle || `Раздел ${fallbackNum}`,
    html: htmlParts.join('\n'),
    wordCount
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
