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

MIT licensed. Part of [naulon](https://naulon.app).
