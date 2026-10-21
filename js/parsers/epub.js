/**
 * EPUB Parser
 * Parses EPUB 2/3 containers, resolves images, spine and TOC
 */
export async function parseEPUB(arrayBuffer, fileName = '') {
  if (!window.JSZip) {
    throw new Error('JSZip библиотека не загружена');
  }

  const zip = await window.JSZip.loadAsync(arrayBuffer);

  // 1. Find root OPF file from META-INF/container.xml
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Некорректный EPUB: отсутствует META-INF/container.xml');
  
  const containerXml = await containerFile.async('text');
  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml, 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile');
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('Не найден full-path в container.xml');

  // Directory of the OPF file
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2. Read OPF file
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('Файл пакета не найден: ' + opfPath);
  const opfXml = await opfFile.async('text');
  const opfDoc = parser.parseFromString(opfXml, 'application/xml');

  // Metadata
  const title = opfDoc.querySelector('metadata title, metadata dc\\:title')?.textContent?.trim()
             || fileName.replace(/\.[^/.]+$/, '');
  const author = opfDoc.querySelector('metadata creator, metadata dc\\:creator')?.textContent?.trim()
              || 'Неизвестный автор';

  // Manifest items: id -> { href, mediaType }
  const manifest = {};
  opfDoc.querySelectorAll('manifest item').forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type');
    if (id && href) {
      manifest[id] = { href, mediaType };
    }
  });

  // Extract cover image if present
  let coverUrl = null;
  const coverMeta = opfDoc.querySelector('metadata meta[name="cover"]');
  const coverId = coverMeta?.getAttribute('content');
  let coverHref = coverId && manifest[coverId]?.href;
  if (!coverHref) {
    // Look for item with 'cover' in id or properties
    const coverItem = Object.values(manifest).find(m => 
      /cover/i.test(m.href) && /image/i.test(m.mediaType)
    );
    if (coverItem) coverHref = coverItem.href;
  }

  if (coverHref) {
    const fullCoverPath = resolveZipPath(opfDir, coverHref);
    const coverZipFile = zip.file(fullCoverPath);
    if (coverZipFile) {
      const coverBlob = await coverZipFile.async('blob');
      coverUrl = URL.createObjectURL(coverBlob);
    }
  }

  // Pre-load images inside zip for inlining in chapters
  const imageCache = {};
  for (const [id, item] of Object.entries(manifest)) {
    if (item.mediaType && item.mediaType.startsWith('image/')) {
      const imgPath = resolveZipPath(opfDir, item.href);
      const imgZipFile = zip.file(imgPath);
      if (imgZipFile) {
        try {
          const imgBlob = await imgZipFile.async('blob');
          const blobUrl = URL.createObjectURL(imgBlob);
          imageCache[imgPath] = blobUrl;
          imageCache[item.href] = blobUrl;
          // Also by filename only
          const baseName = item.href.split('/').pop();
          if (baseName) imageCache[baseName] = blobUrl;
        } catch (e) {
          // ignore error for single image
        }
      }
    }
  }

  // 3. Read TOC
  const tocMap = {};
  const tocItem = Object.values(manifest).find(m => m.mediaType === 'application/x-dtbncx+xml')
               || manifest['ncx'] || manifest['toc'];
  if (tocItem) {
    const ncxPath = resolveZipPath(opfDir, tocItem.href);
    const ncxFile = zip.file(ncxPath);
    if (ncxFile) {
      const ncxXml = await ncxFile.async('text');
      const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
      ncxDoc.querySelectorAll('navPoint').forEach(np => {
        const navLabel = np.querySelector('navLabel text')?.textContent?.trim();
        const contentSrc = np.querySelector('content')?.getAttribute('src');
        if (contentSrc && navLabel) {
          const baseSrc = contentSrc.split('#')[0];
          tocMap[baseSrc] = navLabel;
        }
      });
    }
  }

  // 4. Spine items (reading order)
  const chapters = [];
  const toc = [];
  const spineItems = opfDoc.querySelectorAll('spine itemref');

  for (let idx = 0; idx < spineItems.length; idx++) {
    const itemref = spineItems[idx];
    const idref = itemref.getAttribute('idref');
    const item = manifest[idref];
    if (!item) continue;

    const chapterPath = resolveZipPath(opfDir, item.href);
    const chapterFile = zip.file(chapterPath);
    if (!chapterFile) continue;

    const chapterHtml = await chapterFile.async('text');
    const chDoc = parser.parseFromString(chapterHtml, 'text/html');

    // Title from TOC or headings or <title>
    const baseHref = item.href.split('#')[0];
    let chTitle = tocMap[baseHref]
               || chDoc.querySelector('h1, h2')?.textContent?.trim()
               || chDoc.querySelector('title')?.textContent?.trim()
               || `Глава ${idx + 1}`;

    // Clean body HTML and replace images
    const body = chDoc.querySelector('body') || chDoc.documentElement;
    // Replace <img> src with cached object URLs
    body.querySelectorAll('img, image').forEach(img => {
      const src = img.getAttribute('src') || img.getAttribute('xlink:href') || '';
      if (src) {
        const resolvedSrc = resolveZipPath(chapterPath.substring(0, chapterPath.lastIndexOf('/') + 1), src);
        const baseName = src.split('/').pop();
        const replacement = imageCache[resolvedSrc] || imageCache[src] || imageCache[baseName];
        if (replacement) {
          img.setAttribute('src', replacement);
        }
      }
    });

    // Remove scripts and styles for clean formatting
    body.querySelectorAll('script, style, link').forEach(el => el.remove());

    const cleanHtml = sanitizeHtml(body.innerHTML);
    const textContent = body.textContent || '';
    const wordCount = textContent.trim() ? textContent.trim().split(/\s+/).length : 0;

    // Skip completely empty chapters
    if (wordCount < 3 && !body.querySelector('img')) continue;

    chapters.push({
      id: `ch_${idx + 1}`,
      title: chTitle,
      html: cleanHtml,
      wordCount
    });

    toc.push({
      id: `ch_${idx + 1}`,
      title: chTitle,
      chapterIndex: chapters.length - 1,
      level: 1
    });
  }

  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);

  return {
    title,
    author,
    coverUrl,
    format: 'epub',
    chapters,
    toc,
    totalWords
  };
}

function resolveZipPath(baseDir, relativePath) {
  if (relativePath.startsWith('/')) relativePath = relativePath.slice(1);
  const parts = (baseDir + relativePath).split('/');
  const resolved = [];
  for (const p of parts) {
    if (p === '.' || !p) continue;
    if (p === '..') {
      if (resolved.length) resolved.pop();
    } else {
      resolved.push(p);
    }
  }
  return resolved.join('/');
}

function sanitizeHtml(html) {
  // Retain clean semantic reading tags
  return html
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/gi, '');
}
