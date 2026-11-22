// mend — one CLI that applies AI-written edits in four formats, exactly as SPEC.md says.
//
// Formats: unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
// patch format, and text-editor tool calls as JSON. Every file is changed or nothing is:
// edits apply in order, a failed edit changes nothing, later edits still run, and when
// any edit failed no file is written at all.
//
// Written by the build agent in this session, from SPEC.md alone. Node 22, standard
// library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below); keep that hand-over and runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown when the patch cannot be read in its format; carries the patch line number. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** Thrown when one edit fails; carries the SPEC.md failure code and the path it concerns. */
class EditFailure {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with /, holds no \,
    and none of its /-separated segments is empty, . or .. . */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file as lines: its line break (CRLF when the first line feed follows a carriage return,
    LF otherwise), its lines, and whether it ends with a line break. */
interface FileModel {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function readModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function writeModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read
    from disk; `moves` records the successful move edits, for the R output lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** SPEC.md section 4: detect the format, the first of these that holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** SPEC.md section 5: two lines equal at a tier. */
function linesEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Every 0-based position where the pattern's lines match the file's lines at a tier. */
function occurrencesAt(lines: string[], pattern: string[], tier: number): number[] {
  const out: number[] = [];
  if (pattern.length === 0 || pattern.length > lines.length) return out;
  for (let i = 0; i + pattern.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < pattern.length; k += 1) {
      if (!linesEqualAt(lines[i + k]!, pattern[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which the pattern occurs,
    with every occurrence there; null when it occurs at no tier. */
function firstTierHit(lines: string[], pattern: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, pattern, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Render the replacement lines for one matched occurrence: a context line is written as the
    file's own matched line, never the patch's; at tier 2 every other line is re-indented from
    the old lines' first leading whitespace to the file's first matched line's. `contextOf`
    maps a new-line index to the old-line index it is a context of. */
function renderReplacement(
  file: string[],
  at: number,
  oldLines: string[],
  newLines: string[],
  contextOf: Map<number, number>,
  tier: number,
): string[] {
  const out: string[] = [];
  const reindent = tier === 2 && oldLines.length > 0;
  const leadFile = reindent ? leadingWs(file[at]!) : '';
  const leadOld = reindent ? leadingWs(oldLines[0]!) : '';
  for (let i = 0; i < newLines.length; i += 1) {
    if (contextOf.has(i)) {
      out.push(file[at + contextOf.get(i)!]!);
    } else if (reindent) {
      const line = newLines[i]!;
      if (line !== '' && line.trim() !== '' && line.startsWith(leadOld)) {
        out.push(leadFile + line.slice(leadOld.length));
      } else {
        out.push(line);
      }
    } else {
      out.push(newLines[i]!);
    }
  }
  return out;
}

/** Read a file the tree holds (else the edit fails with `missing`), as a line model. */
function loadModel(tree: Tree, p: string): FileModel {
  const t = tree.get(p);
  if (t === null) throw new EditFailure('missing', p);
  return readModel(t);
}

/** Store a line model back into the tree. */
function storeModel(tree: Tree, p: string, m: FileModel): void {
  tree.now.set(p, writeModel(m));
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface UniHunk {
  oldStart: number;
  body: string[];
}

interface UniSection {
  /** Old path: null means /dev/null (no file). undefined means no --- line named one. */
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

/** A --- or +++ path: the text after the four characters, up to the first tab,
    with surrounding spaces removed; /dev/null means no file; a leading a/ or b/ is removed. */
function parsePatchPath(raw: string): string | null {
  let s = raw;
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** A `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cut = rest.indexOf(' b/', 2);
  if (cut < 0) return null;
  const x = rest.slice(2, cut);
  const y = rest.slice(cut + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A hunk's body: the lines after its header that start with ` `, `-`, `+` or `\`, or are
    empty; it ends at the first other line, and empty lines at its end are not part of it. */
function readHunkBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    // the body ends at a --- line followed by a +++ line, even though --- starts with -
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

/** Split one hunk body into its old lines O and new lines N, the map of which new lines
    are context lines (new index -> old index), and whether a `\` line follows the hunk's
    last context or `+` line. */
function splitHunkBody(body: string[]): {
  oldLines: string[];
  newLines: string[];
  contextOf: Map<number, number>;
  noNewlineAfterLast: boolean;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const contextOf = new Map<number, number>();
  let lastCtxPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const c = body[k] === '' ? ' ' : body[k]![0]!;
    if (c === ' ' || c === '+') lastCtxPlus = k;
  }
  const noNewlineAfterLast =
    lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]![0] === '\\';
  for (const l of body) {
    if (l === '') {
      contextOf.set(newLines.length, oldLines.length);
      oldLines.push('');
      newLines.push('');
    } else if (l[0] === ' ') {
      contextOf.set(newLines.length, oldLines.length);
      oldLines.push(l.slice(1));
      newLines.push(l.slice(1));
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      newLines.push(l.slice(1));
    }
    // a `\` line refers to the body line before it and adds no line of its own
  }
  return { oldLines, newLines, contextOf, noNewlineAfterLast };
}

/** Apply one section's hunks, in order, to a file's lines. Returns the new lines and
    whether the file ends with a line break afterwards. */
function applyUnifiedHunks(
  lines: string[],
  finalBr: boolean,
  hunks: UniHunk[],
  strict: boolean,
  path: string,
): { lines: string[]; finalBr: boolean } {
  let cur = lines;
  let fin = finalBr;
  let d = 0;
  for (const h of hunks) {
    const { oldLines, newLines, contextOf, noNewlineAfterLast } = splitHunkBody(h.body);
    if (oldLines.length > 0) {
      const hit = firstTierHit(cur, oldLines, strict);
      if (hit === null) throw new EditFailure('no-match', path);
      const target = h.oldStart - 1 + d;
      let best = hit.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of hit.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = renderReplacement(cur, best, oldLines, newLines, contextOf, hit.tier);
      const touchesEnd = best + oldLines.length === cur.length;
      cur = [...cur.slice(0, best), ...repl, ...cur.slice(best + oldLines.length)];
      if (touchesEnd) fin = !noNewlineAfterLast;
    } else {
      let idx = h.oldStart + d;
      if (idx < 0) idx = 0;
      if (idx > cur.length) idx = cur.length;
      const touchesEnd = idx === cur.length;
      cur = [...cur.slice(0, idx), ...newLines, ...cur.slice(idx)];
      if (touchesEnd) fin = !noNewlineAfterLast;
    }
    d += newLines.length - oldLines.length;
  }
  return { lines: cur, finalBr: fin };
}

/** Parse a unified patch into one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const fresh = (): UniSection => ({
    hdrOld: undefined,
    hdrNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const pair = parseDiffGit(line);
      if (pair === null) throw new ParseFault(i + 1);
      cur = fresh();
      cur.diffOld = pair[0];
      cur.diffNew = pair[1];
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.hdrOld = parsePatchPath(line.slice(4));
        cur.hdrNew = parsePatchPath(lines[i + 1]!.slice(4));
      } else {
        cur = fresh();
        cur.hdrOld = parsePatchPath(line.slice(4));
        cur.hdrNew = parsePatchPath(lines[i + 1]!.slice(4));
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        // a --- line inside a section's header, not followed by a +++ line
        throw new ParseFault(i + 2);
      }
      if (line.startsWith('+++ ')) {
        cur.hdrNew = parsePatchPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new ParseFault(i + 1);
        const { body, next } = readHunkBody(lines, i + 1);
        cur.hunks.push({ oldStart: parseInt(m[1]!, 10), body });
        inHeader = false;
        i = next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and
      // any other line in a header are ignored
      i += 1;
      continue;
    }
    if (cur !== null && !inHeader) {
      if (line.startsWith('@@')) {
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new ParseFault(i + 1);
        const { body, next } = readHunkBody(lines, i + 1);
        cur.hunks.push({ oldStart: parseInt(m[1]!, 10), body });
        i = next;
        continue;
      }
      // lines outside bodies that are not part of a section header are ignored
      i += 1;
      continue;
    }
    // no section yet: a hunk before any section is a parse fault; anything else is prose
    if (line.startsWith('@@')) throw new ParseFault(i + 1);
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** One unified section as an edit. */
function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldP: string | null =
    sec.hdrOld !== undefined ? sec.hdrOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld !== undefined ? sec.diffOld : null;
  const newP: string | null =
    sec.hdrNew !== undefined ? sec.hdrNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew !== undefined ? sec.diffNew : null;
  return (tree: Tree) => {
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    if (isCreate) {
      if (newP === null) throw new EditFailure('unsafe', '/dev/null');
      if (!isSafePath(newP)) throw new EditFailure('unsafe', newP);
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      // the file is the + lines of all its hunks, in order; an empty creation is empty
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const l of h.body) {
          if (l !== '' && l[0] === '+') plus.push(l.slice(1));
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (creationEndsWithBreak(sec) ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new EditFailure('missing', '/dev/null');
      if (!isSafePath(oldP)) throw new EditFailure('unsafe', oldP);
      if (tree.get(oldP) === null) throw new EditFailure('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    // move or change: both paths are real paths here
    const oldPath = oldP as string;
    const newPath = newP as string;
    if (!isSafePath(oldPath)) throw new EditFailure('unsafe', oldPath);
    if (!isSafePath(newPath)) throw new EditFailure('unsafe', newPath);
    const isMove = oldPath !== newPath;
    if (tree.get(oldPath) === null) throw new EditFailure('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new EditFailure('exists', newPath);
    const model = loadModel(tree, oldPath);
    const out = applyUnifiedHunks(model.lines, model.finalBr, sec.hunks, strict, oldPath);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, writeModel({ lines: out.lines, br: model.br, finalBr: out.finalBr }));
      tree.moves.push([oldPath, newPath]);
    } else {
      storeModel(tree, oldPath, { lines: out.lines, br: model.br, finalBr: out.finalBr });
    }
  };
}

/** Whether a created file ends with a line break: it does unless a \ line follows the
    last + line of the section's last hunk that has one. */
function creationEndsWithBreak(sec: UniSection): boolean {
  for (let h = sec.hunks.length - 1; h >= 0; h -= 1) {
    const body = sec.hunks[h]!.body;
    let lastPlus = -1;
    for (let k = 0; k < body.length; k += 1) {
      if (body[k] !== '' && body[k]![0] === '+') lastPlus = k;
    }
    if (lastPlus >= 0) {
      return !(lastPlus + 1 < body.length && body[lastPlus + 1]![0] === '\\');
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Parse SEARCH/REPLACE blocks into one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    // the path is the nearest line before SEARCH, after the previous block, that is
    // not blank and does not start with three backticks once its whitespace is removed
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchLine + 1);
    // a SEARCH line with no ======= and then >>>>>>> REPLACE after it is a parse fault
    let sep = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep < 0) throw new ParseFault(searchLine + 1);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new ParseFault(searchLine + 1);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

/** One SEARCH/REPLACE block as an edit. */
function searchReplaceEdit(b: SrBlock, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!isSafePath(b.path)) throw new EditFailure('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new EditFailure('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const model = loadModel(tree, b.path);
    const hit = firstTierHit(model.lines, b.oldLines, strict);
    if (hit === null) throw new EditFailure('no-match', b.path);
    if (hit.positions.length > 1) throw new EditFailure('ambiguous', b.path);
    const at = hit.positions[0]!;
    const repl = renderReplacement(model.lines, at, b.oldLines, b.newLines, new Map(), hit.tier);
    const out = [...model.lines.slice(0, at), ...repl, ...model.lines.slice(at + b.oldLines.length)];
    storeModel(tree, b.path, { lines: out, br: model.br, finalBr: model.finalBr });
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** The anchor text, or null when the chunk has none. */
  anchor: string | null;
  /** True when a *** End of File line closed this chunk. */
  eof: boolean;
  body: string[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add: the file's lines. Update: the chunks. Delete: unused. */
  lines: string[];
  chunks: V4aChunk[];
  /** The section header's patch line number (for the no-chunk parse fault). */
  headerLine: number;
}

const V4A_ADD = '*** Add File:';
const V4A_DELETE = '*** Delete File:';
const V4A_UPDATE = '*** Update File:';

function isV4aSectionStart(line: string): boolean {
  return line.startsWith(V4A_ADD) || line.startsWith(V4A_DELETE) || line.startsWith(V4A_UPDATE);
}

/** Parse the body of one Update File section into its chunks. */
function parseV4aChunks(raw: string[], startLine: number, headerLine: number, hasMove: boolean): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let k = 0; k < raw.length; k += 1) {
    const line = raw[k]!;
    const no = startLine + k;
    if (line.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      // the text after @@, its surrounding spaces removed, is the anchor; empty is no anchor
      const anchorText = line.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      continue;
    }
    if (line === '*** End of File') {
      if (cur === null) throw new ParseFault(no + 1);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseFault(no + 1);
        // the first chunk may start at a body line, with no anchor
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(line);
      continue;
    }
    throw new ParseFault(no + 1);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && !hasMove) throw new ParseFault(headerLine);
  return chunks;
}

/** Parse a V4A patch into one edit per section. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  // collect the sections between Begin Patch and End Patch, each line with its number
  interface RawLine {
    text: string;
    no: number;
  }
  interface RawSection {
    header: string;
    headerLine: number;
    lines: RawLine[];
  }
  const rawSections: RawSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (!isV4aSectionStart(line)) throw new ParseFault(i + 1);
    const sec: RawSection = { header: line, headerLine: i + 1, lines: [] };
    rawSections.push(sec);
    i += 1;
    while (i < last && !isV4aSectionStart(lines[i]!)) {
      sec.lines.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    // blank lines at the end of a section are not part of it
    while (sec.lines.length > 0 && isBlank(sec.lines[sec.lines.length - 1]!.text)) sec.lines.pop();
  }
  const edits: Edit[] = [];
  for (const raw of rawSections) {
    const header = raw.header;
    if (header.startsWith(V4A_ADD)) {
      const path = header.slice(V4A_ADD.length).trim();
      for (const l of raw.lines) {
        if (l.text !== '' && l.text[0] !== '+') throw new ParseFault(l.no);
      }
      const fileLines = raw.lines.map((l) => (l.text === '' ? '' : l.text.slice(1)));
      edits.push(v4aAddEdit(path, fileLines));
    } else if (header.startsWith(V4A_DELETE)) {
      const path = header.slice(V4A_DELETE.length).trim();
      for (const l of raw.lines) {
        if (!isBlank(l.text)) throw new ParseFault(l.no);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      const path = header.slice(V4A_UPDATE.length).trim();
      let moveTo: string | null = null;
      let body = raw.lines;
      if (body.length > 0 && body[0]!.text.startsWith('*** Move to:')) {
        moveTo = body[0]!.text.slice('*** Move to:'.length).trim();
        body = body.slice(1);
      }
      const chunks = parseV4aChunks(
        body.map((l) => l.text),
        body.length > 0 ? body[0]!.no : raw.headerLine + 1,
        raw.headerLine,
        moveTo !== null,
      );
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

/** A V4A Add File section as an edit. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree: Tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) !== null) throw new EditFailure('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

/** A V4A Delete File section as an edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) === null) throw new EditFailure('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A chunk's old and new lines, with the context map. */
function v4aChunkOldNew(chunk: V4aChunk): {
  oldLines: string[];
  newLines: string[];
  contextOf: Map<number, number>;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const contextOf = new Map<number, number>();
  for (const l of chunk.body) {
    if (l === '') {
      contextOf.set(newLines.length, oldLines.length);
      oldLines.push('');
      newLines.push('');
    } else if (l[0] === ' ') {
      contextOf.set(newLines.length, oldLines.length);
      oldLines.push(l.slice(1));
      newLines.push(l.slice(1));
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      newLines.push(l.slice(1));
    }
  }
  return { oldLines, newLines, contextOf };
}

/** A V4A Update File section as an edit. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFailure('unsafe', moveTo);
    const model = loadModel(tree, path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFailure('exists', moveTo);
    let lines = model.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const hit = firstTierHit(lines.slice(cursor), [chunk.anchor], strict);
        if (hit === null) throw new EditFailure('no-match', path);
        cursor += hit.positions[0]! + 1;
      }
      const { oldLines, newLines, contextOf } = v4aChunkOldNew(chunk);
      if (oldLines.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at)];
        cursor = at + newLines.length;
        continue;
      }
      // first occurrence of O at or after the cursor, at the first tier with one;
      // an end-of-file chunk takes only an occurrence ending at the file's last line
      const tail = lines.slice(cursor);
      const hit = firstTierHit(tail, oldLines, strict);
      if (hit === null) throw new EditFailure('no-match', path);
      let at: number | null = null;
      for (const p of hit.positions) {
        if (!chunk.eof || cursor + p + oldLines.length === lines.length) {
          at = cursor + p;
          break;
        }
      }
      if (at === null) throw new EditFailure('no-match', path);
      const repl = renderReplacement(lines, at, oldLines, newLines, contextOf, hit.tier);
      lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + oldLines.length)];
      cursor = at + repl.length;
    }
    const out: FileModel = { lines, br: model.br, finalBr: model.finalBr };
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, writeModel(out));
      tree.moves.push([path, moveTo]);
    } else {
      storeModel(tree, path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const mustExist = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree);
      // in a CRLF file the text and both strings are read with every \r\n as \n,
      // and the result is written back with \r\n
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const lineNo = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (tree) => {
      const before = mustExist(tree);
      const model = readModel(before);
      if (lineNo < 0 || lineNo > model.lines.length) throw new EditFailure('no-match', p);
      const out = [...model.lines.slice(0, lineNo), ...add, ...model.lines.slice(lineNo)];
      storeModel(tree, p, { lines: out, br: model.br, finalBr: model.finalBr });
    };
  }
  return null;
}

/** Parse a JSON patch (one array, or JSON Lines) into edits. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                      */
/* ------------------------------------------------------------------ */

function usageResult(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

/** The output rows for a finished run: one line per path whose state changed, in byte
    order of the paths, with a successful move reported as one R line sorting by its new path. */
function outputRows(tree: Tree): string[] {
  const kind = new Map<string, 'A' | 'D' | 'M'>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    kind.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (kind.get(oldP) === 'D' && kind.get(newP) === 'A') {
      kind.delete(oldP);
      kind.delete(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const [p, k] of kind) rows.push({ key: p, text: `${k} ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.text);
}

/** Write every change the tree holds to disk. */
function writeTree(tree: Tree): void {
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) {
      rmSync(p, { force: true });
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
}

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usageResult();
        const v = a.slice('--format='.length);
        if (!FORMAT_NAMES.includes(v)) return usageResult();
        format = v;
      } else if (a === '--check') {
        if (check) return usageResult();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usageResult();
        strict = true;
      } else {
        return usageResult();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usageResult();
  const patchArg = pos.length === 0 ? null : pos[0]!;
  const patchFile = patchArg === null || patchArg === '-' ? null : patchArg;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    const movesAt = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      tree.moves.length = movesAt;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = outputRows(tree);
  if (!check) writeTree(tree);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each
  // one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
