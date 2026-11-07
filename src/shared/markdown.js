// Shared between the Node server and the browser editor.
// Converts between Markdown and the flat block list a page is stored as.

export const BLOCK_TYPES = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list',
  'numbered_list',
  'to_do',
  'quote',
  'callout',
  'code',
  'divider',
  'image',
  'page',
  'database_view',
];

/** Blocks that are not text-editable in the editor. */
export const ATOMIC_TYPES = ['divider', 'page', 'database_view'];

/** A sub-page reference, written in Markdown as `[Title](page:ID)` on its own line. */
const PAGE_LINK = /^\[([^\]]*)\]\(page:([\w-]+)\)\s*$/;

/** A linked database view, written `[View name](database_view:BLOCK_ID)`; its settings live on the block. */
const DB_VIEW_LINK = /^\[([^\]]*)\]\(database_view:([\w-]+)\)\s*$/;

export const LIST_TYPES = ['bulleted_list', 'numbered_list', 'to_do'];

const CALLOUT_ICONS = {
  note: '💡',
  info: 'ℹ️',
  tip: '💡',
  important: '❗',
  warning: '⚠️',
  caution: '🚫',
  danger: '🚫',
  success: '✅',
  question: '❓',
};

export function newId() {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

const indentOf = (ws) => Math.min(4, Math.floor(ws.replace(/\t/g, '  ').length / 2));

function isBlockStart(line) {
  return (
    /^\s*(```+|~~~+)/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s/.test(line) ||
    /^\s*\d+[.)]\s/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    /^!\[[^\]]*\]\([^)]+\)\s*$/.test(line) ||
    PAGE_LINK.test(line) ||
    DB_VIEW_LINK.test(line)
  );
}

/** Markdown string -> array of blocks. */
export function markdownToBlocks(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const push = (b) => blocks.push({ id: newId(), text: '', ...b });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence
      push({ type: 'code', text: body.join('\n'), language: fence[2] || '' });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      push({ type: 'divider' });
      i++;
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      push({ type: 'heading_' + Math.min(m[1].length, 3), text: m[2].replace(/\s+#+\s*$/, '') });
      i++;
      continue;
    }
    if ((m = line.match(PAGE_LINK))) {
      push({ type: 'page', pageId: m[2], text: m[1] });
      i++;
      continue;
    }
    if ((m = line.match(DB_VIEW_LINK))) {
      // refers to an existing block by id; the page model restores its settings
      push({ type: 'database_view', ref: m[2], text: m[1] });
      i++;
      continue;
    }
    if ((m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/))) {
      push({ type: 'image', url: m[2], text: m[1] });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const group = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) group.push(lines[i++].replace(/^\s*>\s?/, ''));
      const cm = group[0].match(/^\[!([^\]]+)\]\s*(.*)$/);
      if (cm) {
        const key = cm[1].trim();
        const icon = CALLOUT_ICONS[key.toLowerCase()] || (/^[\x00-\x7f]+$/.test(key) ? '💡' : key);
        const rest = [cm[2], ...group.slice(1)];
        if (!rest[0]) rest.shift();
        push({ type: 'callout', icon, text: rest.join('\n') });
      } else {
        push({ type: 'quote', text: group.join('\n') });
      }
      continue;
    }
    if ((m = line.match(/^(\s*)[-*+]\s+\[([ xX])\](?:\s+(.*))?$/))) {
      push({ type: 'to_do', checked: m[2] !== ' ', text: m[3] || '', indent: indentOf(m[1]) });
      i++;
      continue;
    }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
      push({ type: 'bulleted_list', text: m[2], indent: indentOf(m[1]) });
      i++;
      continue;
    }
    if ((m = line.match(/^(\s*)\d+[.)]\s+(.*)$/))) {
      push({ type: 'numbered_list', text: m[2], indent: indentOf(m[1]) });
      i++;
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

/** One block -> its Markdown line(s), without trailing newline. */
export function blockToMarkdown(b, number = 1) {
  const ind = '  '.repeat(b.indent || 0);
  const text = b.text || '';
  switch (b.type) {
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list':
      return `${ind}- ${text}`;
    case 'numbered_list':
      return `${ind}${number}. ${text}`;
    case 'to_do':
      return `${ind}- [${b.checked ? 'x' : ' '}] ${text}`;
    case 'quote':
      return text.split('\n').map((l) => `> ${l}`).join('\n');
    case 'callout':
      return [`> [!${b.icon || '💡'}]`, ...text.split('\n').map((l) => `> ${l}`)].join('\n');
    case 'code': {
      const fence = text.includes('```') ? '~~~' : '```';
      return `${fence}${b.language || ''}\n${text}\n${fence}`;
    }
    case 'divider':
      return '---';
    case 'image':
      return `![${text}](${b.url || ''})`;
    case 'page':
      return `[${text.replace(/[[\]\n]/g, '') || 'Untitled'}](page:${b.pageId})`;
    case 'database_view':
      return `[${String(b.view?.name || text || 'Linked view').replace(/[[\]\n]/g, '')}](database_view:${b.id})`;
    default:
      return text;
  }
}

/** Array of blocks -> Markdown string. */
export function blocksToMarkdown(blocks) {
  let out = '';
  let prev = null;
  const counters = [];
  for (const b of blocks || []) {
    const indent = b.indent || 0;
    let number = 1;
    if (b.type === 'numbered_list') {
      if (prev && LIST_TYPES.includes(prev.type)) {
        counters.length = indent + 1;
        counters[indent] = (counters[indent] || 0) + 1;
      } else {
        counters.length = 0;
        counters[indent] = 1;
      }
      number = counters[indent];
    } else if (!LIST_TYPES.includes(b.type)) {
      counters.length = 0;
    } else {
      counters.length = indent + 1;
      counters[indent] = 0;
    }
    if (prev) out += LIST_TYPES.includes(b.type) && LIST_TYPES.includes(prev.type) ? '\n' : '\n\n';
    out += blockToMarkdown(b, number);
    prev = b;
  }
  return out ? out + '\n' : '';
}

/** Ensure a block coming from an untrusted client has a valid shape. */
export function sanitizeBlock(b) {
  const type = BLOCK_TYPES.includes(b?.type) ? b.type : 'paragraph';
  const out = { id: typeof b?.id === 'string' && b.id ? b.id.slice(0, 40) : newId(), type, text: String(b?.text ?? '') };
  if (LIST_TYPES.includes(type)) out.indent = Math.max(0, Math.min(4, Number(b.indent) || 0));
  if (type === 'to_do') out.checked = !!b.checked;
  if (type === 'code') out.language = String(b.language || '');
  if (type === 'callout') out.icon = String(b.icon || '💡');
  if (type === 'image') out.url = String(b.url || '');
  if (type === 'page') out.pageId = String(b.pageId || '');
  if (type === 'database_view') {
    out.databaseId = String(b.databaseId || '');
    const view = b.view && typeof b.view === 'object' ? JSON.parse(JSON.stringify(b.view)) : null;
    out.view = view && JSON.stringify(view).length < 20000 ? view : null;
  }
  return out;
}
