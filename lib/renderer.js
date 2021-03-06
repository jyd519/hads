'use strict';

const path = require('path');
const fs = require('fs-extra');
const normalizePath = require('normalize-path');
const marked = require('marked');
const highlight = require('highlight.js');
const removeMd = require('remove-markdown');
const humanize = require('string-humanize');

const SEARCH_EXTRACT_LENGTH = 400;
const SEARCH_RESULTS_MAX = 10;

class Renderer {
  constructor(indexer, options) {
    this.indexer = indexer;
    this.seen = {};
    this.searchResults = null;
    this.options = options;
  }

  renderRaw(file) {
    return fs.readFile(file, 'utf8');
  }

  renderFile(file) {
    return this.renderRaw(file).then(content => this.renderMarkdown(content + '\n[[itoc]]'));
  }

  renderCode(file) {
    const lang = path.extname(file).replace('.', '');
    return this.renderRaw(file).then(content => this.renderMarkdown(`\`\`\`${lang}\n${content}\n\`\`\``));
  }

  renderSearch(search) {
    const results = this.indexer.search(search);
    const total = results.length;
    let content = total ? '' : 'No results.';

    this.searchResults = 'Search results (';

    if (total > SEARCH_RESULTS_MAX) {
      results.splice(SEARCH_RESULTS_MAX);
      this.searchResults += `first ${SEARCH_RESULTS_MAX} of `;
    }

    this.searchResults += `${total})`;

    results.forEach(result => {
      let extract = removeMd(this.indexer.getContent(result.ref));
      extract = extract.replace(/\s/g, ' ').replace(/`/g, '');
      extract = extract.replace(/\[\[index]]/g, '&#91;&#91;index]]');

      if (extract.length > SEARCH_EXTRACT_LENGTH) {
        extract = extract.substr(0, SEARCH_EXTRACT_LENGTH) + ' [...]';
      }

      content += `[${result.ref}](${result.ref})\n> ${extract}\n\n`;
    });

    return Promise.resolve(this.renderMarkdown(content));
  }

  renderIndex() {
    const files = this.indexer.getFiles();
    const nav = {};

    files.forEach(file => {
      file = normalizePath(file);
      const dir = path.dirname(file);
      const components = dir.split(path.sep);
      const name = path.basename(file);
      let parent = nav;

      if (components[0] === '.') {
        components.splice(0, 1);
      }

      components.forEach(component => {
        const current = parent[component] || {};
        parent[component] = current;
        parent = current;
      });

      parent[name] = path.join(this.options.basePath, file);
    });

    const content = Renderer.renderIndexLevel(nav, 0);
    return this.renderMarkdown(content);
  }

  // Copied from marked Slugger.slug
  slug(value) {
    let slug = value
      .toLowerCase()
      .trim()
      .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
      .replace(/\s/g, '-');

    if (this.seen.hasOwnProperty(slug)) {
      const originalSlug = slug;
      do {
        this.seen[originalSlug]++;
        slug = originalSlug + '-' + this.seen[originalSlug];
      } while (this.seen.hasOwnProperty(slug));
    }

    this.seen[slug] = 0;
    return slug;
  }

  renderTableOfContents(content, skipFirst) {
    this.seen = {};
    let toc = '';
    const renderer = new marked.Renderer();
    renderer.heading = (text, level, raw) => {
      text = Renderer.removeLinks(text);
      const slug = this.slug(raw);
      if (skipFirst) {
        // Skip first level 1 header
        skipFirst = false;
        if (level === 1) {
          return;
        }
      }

      toc += '  '.repeat(level - 1) + `- [${text}](#${slug})\n`;
    };

    marked(content, {
      renderer
    });

    const md = this.renderMarkdown(toc);
    if (Object.keys(this.seen).length > 1) {
      return md;
    }

    return '';
  }

  renderMarkdown(content) {
    const renderer = new marked.Renderer();

    renderer.code = (code, language) => {
      if (language === 'mermaid') {
        return `<p class="mermaid">${code}</p>`;
      }

      return marked.Renderer.prototype.code.call(renderer, code, language);
    };

    renderer.paragraph = text => {
      text = text.replace(/^\[\[toc]]/img, () => this.renderTableOfContents(content, true));
      text = text.replace(/^\[\[itoc]]/img, () => {
        const toc = this.renderTableOfContents(content, false);
        return toc.length > 0 ? '<div id="_toc">' + toc + '</div>' : '';
      });
      text = text.replace(/^\[\[index]]/img, () => this.renderIndex());
      return marked.Renderer.prototype.paragraph.call(renderer, text);
    };

    renderer.link = (href, title, text) => {
      text = Renderer.removeLinks(text);
      href = Renderer.formatHref(href, this.options.isExport);
      return marked.Renderer.prototype.link.call(renderer, href, title, text);
    };

    renderer.image = (href, title, text) => {
      let out = marked.Renderer.prototype.image.call(renderer, href, title, text);
      out = `<a href="${href}" target="_new">${out}</a>`;
      return out;
    };

    return marked(content, {
      renderer,
      gfm: true,
      smartLists: true,
      breaks: false,
      smartypants: true,
      highlight: (code, lang) => {
        try {
          code = lang && lang !== 'no-highlight' ? highlight.highlight(lang, code, true).value : code;
        } catch (_err) {
          console.error(`Unsupported language for highlighting: ${lang}`);
        }

        return code;
      }
    });
  }

  static removeLinks(text) {
    return text.replace(/<a\b[^>]*>/gi, '')
      .replace(/<\/a>/gi, '');
  }

  static formatHref(href, isExport) {
    const isExternal = !href.startsWith('/') && path.dirname(href) !== '.';
    const isHash = href.startsWith('#');

    if (!isExport || isExternal || isHash) {
      return href;
    }

    const ext = path.extname(href);
    const dir = path.dirname(href);
    const base = path.basename(href, ext);
    return normalizePath(path.join(dir, `${base}.html`));
  }

  static renderIndexLevel(index, level) {
    let content = '';
    const indent = '  '.repeat(level);
    const keys = Object.keys(index).sort((a, b) => {
      const aType = typeof index[a];
      const bType = typeof index[b];
      if (aType === bType) {
        return a.localeCompare(b);
      }

      if (aType === 'string') {
        // Display files before folders
        return -1;
      }

      return 1;
    });

    keys.forEach(key => {
      const value = index[key];
      content += indent;

      if (typeof value === 'string') {
        const link = value.split('/')
          .map(part => encodeURIComponent(part))
          .join('/');
        key = path.basename(key, path.extname(key));
        content += `- [${humanize(key)}](/${link})\n`;
      } else {
        content += `- ${humanize(key)}\n`;
        content += Renderer.renderIndexLevel(value, level + 1);
      }
    });

    return content;
  }
}

module.exports = Renderer;
