# @naulon/extract

The article inside a web page, as markdown.

An agent that pays to read a page wants the article, not the navigation, sidebars, cookie banner,
comment widget and scripts around it. On a typical themed blog post those are over 95% of the
bytes. This package runs Mozilla's Readability over the page and writes what it finds as markdown
with turndown, so headings, lists, links, tables and code blocks survive.

It is deterministic and offline. There is no network call and no model: the output is the
author's text, never a paraphrase of it.

```ts
import { extractArticle } from "@naulon/extract";

const article = extractArticle(html, "https://your-site.example/posts/hello/");
if (article) {
  article.markdown;      // the article, as markdown
  article.title;         // plus byline, published, canonical, lang when the page states them
  article.words;
  article.approxTokens;  // characters / 4, for budgeting
} else {
  // No readable article on this page. Serve it as it was and say so.
}
```

`null` means the page had less than 200 characters of article text or could not be parsed. It
never returns a guess.

Relative links and image sources are resolved against the URL you pass, so the text still points
somewhere once it leaves the page.

Three helpers cover content negotiation: `prefersMarkdown(accept)` is true only when an `Accept`
header ranks `text/markdown` above every HTML type it names, and `isHtml` / `isMarkdown` read a
`Content-Type`.

## Sentences and proofs

A reader that quotes a document can prove each quoted sentence against one published hash without
disclosing the rest of the text. `segmentSentences` splits normalized text the same way for
everyone, `merkleRoot` commits to every sentence, and `verifyInclusion` checks one sentence with
its proof, offline, from its index and the sentence count alone.

```ts
import { inclusionProof, leafHash, merkleRoot, segmentSentences, verifyInclusion } from "@naulon/extract";

const sentences = segmentSentences(text);
const leaves = sentences.map((s, i) => leafHash(i, s));
const root = merkleRoot(leaves);                  // publish this
const proof = inclusionProof(leaves, 3);          // ship this beside sentence 3
verifyInclusion(root, 3, sentences.length, sentences[3], proof); // true
```

The splitting rules are frozen per version of this package. A quote proved under one version is
checked with that version's rules, which is why `EXTRACT_VERSION` is exported.

MIT licensed. Part of [naulon](https://naulon.app).
