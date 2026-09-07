/**
 * The RAW `<license>` source, per `<content>` block.
 *
 * OLP's `/token` takes `license` = "the URL-encoded RSL `<license>` XML element". Not a summary of
 * it, and not our re-serialization of it: the server is being asked about the licence the publisher
 * actually published, and a byte-comparing server would reject anything we rebuilt. `fast-xml-parser`
 * gives a tree and throws the source away, so the source is recovered here by a scan that runs over
 * the same document.
 *
 * A regex would do this in one line and be wrong: a `<accepts>` body is CDATA, and CDATA may
 * legally contain the characters `</license>`. The scanner below skips CDATA sections and comments
 * outright, which removes that class rather than making it unlikely.
 *
 * Pairing is BY INDEX — the Nth content block's Mth licence. Both this scan and the parser walk the
 * document in order, so the indices line up by construction; `raw.test.ts` pins that against a
 * document whose blocks are deliberately not interchangeable.
 */

/** Where a tag's local name starts, ignoring any namespace prefix. */
function localNameAt(s: string, i: number): string {
  // i points just past "<"
  let j = i;
  while (j < s.length && /[A-Za-z0-9_.:-]/.test(s[j]!)) j++;
  const name = s.slice(i, j);
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Scan `xml`, returning each top-level element's raw source for the elements named `name`,
 *  starting the search at `from` and stopping at `until`. CDATA and comments are skipped. */
function rawElements(xml: string, name: string, from = 0, until = xml.length): string[] {
  const out: string[] = [];
  let i = from;
  while (i < until) {
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i);
      i = end === -1 ? until : end + 3;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i);
      i = end === -1 ? until : end + 3;
      continue;
    }
    if (xml[i] !== "<" || localNameAt(xml, i + 1) !== name) {
      i++;
      continue;
    }
    // Found an opening tag. Find where it closes.
    const openEnd = xml.indexOf(">", i);
    if (openEnd === -1 || openEnd >= until) break;
    if (xml[openEnd - 1] === "/") {
      // Self-closing: `<content url="/"/>` — a real shape, and it has no licences inside it.
      out.push(xml.slice(i, openEnd + 1));
      i = openEnd + 1;
      continue;
    }
    // Walk to the matching close, counting nested elements of the same name (RSL nests none, but a
    // scanner that assumes so is a scanner that silently truncates the day one does).
    let depth = 1;
    let j = openEnd + 1;
    while (j < until && depth > 0) {
      if (xml.startsWith("<![CDATA[", j)) {
        const end = xml.indexOf("]]>", j);
        j = end === -1 ? until : end + 3;
        continue;
      }
      if (xml.startsWith("<!--", j)) {
        const end = xml.indexOf("-->", j);
        j = end === -1 ? until : end + 3;
        continue;
      }
      if (xml[j] === "<") {
        if (xml[j + 1] === "/" && localNameAt(xml, j + 2) === name) {
          depth--;
          const close = xml.indexOf(">", j);
          j = close === -1 ? until : close + 1;
          continue;
        }
        if (localNameAt(xml, j + 1) === name) {
          const e = xml.indexOf(">", j);
          if (e !== -1 && xml[e - 1] !== "/") depth++;
          j = e === -1 ? until : e + 1;
          continue;
        }
      }
      j++;
    }
    out.push(xml.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * For each `<content>` block in document order, the raw source of each of its `<license>` children.
 *
 * Returns `[]` for a document with no content blocks — the same answer the parser gives, so a
 * caller pairing the two never indexes past the end.
 */
export function rawLicensesByContent(xml: string): string[][] {
  return rawElements(xml, "content").map((block) => rawElements(block, "license"));
}
