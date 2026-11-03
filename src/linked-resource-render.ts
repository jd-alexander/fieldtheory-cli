import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import type { LinkedResource } from './bookmark-enrich.js';
import { isSafeUrl } from './bookmark-enrich.js';

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function linkedResourceMarkdown(resources: LinkedResource[] = []): string[] {
  return resources.flatMap((resource) => {
    const content = resource.content;
    const lines = [`### ${content?.title?.replace(/[\r\n]/g, ' ') || 'Linked Resource'}`, '',
      `Source: ${resource.resolvedUrl ?? resource.url}`, `Capture: ${resource.status}${resource.reason ? ` - ${resource.reason}` : ''}`];
    if (resource.nextRetryAt) lines.push(`Retry after: ${resource.nextRetryAt}`);
    if (resource.status === 'failed' || resource.status === 'partial') lines.push(`Attempts: ${resource.attempts}/3`);
    if (content) lines.push('', content.markdown ?? content.text.replace(/([\\`*_{}\[\]()#+.!|<>])/g, '\\$1'));
    return [...lines, ''];
  });
}

export function linkedResourceHtml(resources: LinkedResource[] = []): string {
  return resources.map((resource) => {
    const content = resource.content;
    const dom = new JSDOM(content?.markdown ? marked.parse(content.markdown, { async: false }) : `<p>${escape(content?.text ?? '').replace(/\n/g, '<br>')}</p>`);
    try {
      const document = dom.window.document;
      document.querySelectorAll('script,style,iframe,object,embed,img,video,audio,source,svg,math,form,template').forEach((node) => node.remove());
      const allowed = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'CODE', 'UL', 'OL', 'LI', 'EM', 'STRONG', 'BLOCKQUOTE', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'HR', 'DEL']);
      for (const node of [...document.body.querySelectorAll('*')]) {
        if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
        const href = node.tagName === 'A' ? node.getAttribute('href') : null;
        for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
        if (href && isSafeUrl(href)) node.setAttribute('href', href);
      }
      return `<section><h3>${escape(content?.title ?? 'Linked Resource')}</h3><p>${escape(resource.resolvedUrl ?? resource.url)}</p><p>Capture: ${escape(resource.status)}${resource.reason ? ` - ${escape(resource.reason)}` : ''}</p><div class="resource-body">${document.body.innerHTML}</div></section>`;
    } finally { dom.window.close(); }
  }).join('\n');
}
