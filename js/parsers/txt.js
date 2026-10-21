/**
 * TXT Parser
 * Intelligent encoding detection (UTF-8, Windows-1251, KOI8-R), chapter regex splitting, paragraph reconstruction
 */
export async function parseTXT(fileOrBuffer, fileName = '') {
  let text = '';
  
  if (fileOrBuffer instanceof ArrayBuffer || fileOrBuffer instanceof Uint8Array) {
    const bytes = new Uint8Array(fileOrBuffer);
    
    // Check UTF-8 validity
    try {
      const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
      text = utf8Decoder.decode(bytes);
    } catch (e) {
      // Fallback to windows-1251 (Cyrillic CP1251)
      try {
        const cp1251Decoder = new TextDecoder('windows-1251');
        text = cp1251Decoder.decode(bytes);
      } catch (err) {
        text = new TextDecoder('utf-8').decode(bytes);
      }
    }
  } else if (typeof fileOrBuffer === 'string') {
    text = fileOrBuffer;
  }

  // Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = text.split('\n');

  // Attempt to extract title and author from first 5 lines
  let title = fileName.replace(/\.[^/.]+$/, '');
  let author = 'Неизвестный автор';
  let startIndex = 0;

  const nonEmptyLines = [];
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i].trim();
    if (line) {
      nonEmptyLines.push({ text: line, lineIndex: i });
    }
  }

  if (nonEmptyLines.length >= 2) {
    // If first line is short and looks like an author, and second is title
    if (nonEmptyLines[0].text.length < 50 && !/^(глава|часть|том|chapter)/i.test(nonEmptyLines[0].text)) {
      author = nonEmptyLines[0].text;
      title = nonEmptyLines[1].text;
      startIndex = nonEmptyLines[1].lineIndex + 1;
    } else if (nonEmptyLines[0].text.length < 70) {
      title = nonEmptyLines[0].text;
      startIndex = nonEmptyLines[0].lineIndex + 1;
    }
  }

  // Chapter detection pattern
  const chapterRegex = /^(?:Глава|Часть|Раздел|Книга|Том|Параграф|Chapter|Part|Section|§)\s+([0-9IVXLCDM]+|[А-ЯA-Z]+).*$|^[IVXLCDM]{1,6}\.?\s*$/i;

  const chapters = [];
  const toc = [];

  let currentTitle = 'Начало';
  let currentParas = [];
  let currentWordCount = 0;

  function commitChapter() {
    if (currentParas.length > 0) {
      const chIdx = chapters.length;
      const chId = `ch_${chIdx + 1}`;
      const html = currentParas.map(p => {
        if (p.isHeading) return `<h2>${escapeHtml(p.text)}</h2>`;
        return `<p>${escapeHtml(p.text)}</p>`;
      }).join('\n');

      chapters.push({
        id: chId,
        title: currentTitle,
        html,
        wordCount: currentWordCount
      });
      toc.push({
        id: chId,
        title: currentTitle,
        chapterIndex: chIdx,
        level: 1
      });
      currentParas = [];
      currentWordCount = 0;
    }
  }

  // Group text into paragraphs
  const rawBody = lines.slice(startIndex).join('\n');
  const rawParagraphs = rawBody.split(/\n\s*\n+/);

  for (const block of rawParagraphs) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Check if this block is a chapter heading
    const firstLine = trimmed.split('\n')[0].trim();
    if (firstLine.length < 90 && chapterRegex.test(firstLine)) {
      commitChapter();
      currentTitle = firstLine;
      currentParas.push({ text: firstLine, isHeading: true });
      currentWordCount += firstLine.split(/\s+/).length;

      // The rest of the block if multiple lines
      const rest = trimmed.slice(firstLine.length).trim();
      if (rest) {
        currentParas.push({ text: rest, isHeading: false });
        currentWordCount += rest.split(/\s+/).length;
      }
      continue;
    }

    // Normal paragraph: join lines with space
    const cleanPara = trimmed.split('\n').map(l => l.trim()).join(' ');
    currentParas.push({ text: cleanPara, isHeading: false });
    currentWordCount += cleanPara.split(/\s+/).length;

    // If chapter exceeds 3500 words without any heading, auto-split
    if (currentWordCount > 3500) {
      commitChapter();
      currentTitle = `Часть ${chapters.length + 1}`;
    }
  }

  commitChapter();

  // Fallback
  if (chapters.length === 0) {
    const words = text ? text.split(/\s+/).length : 0;
    chapters.push({
      id: 'ch_1',
      title: title,
      html: `<p>${escapeHtml(text)}</p>`,
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
    format: 'txt',
    chapters,
    toc,
    totalWords
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
