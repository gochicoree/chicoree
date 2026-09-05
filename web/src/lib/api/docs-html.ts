// Markdown → HTML for the in-app API guide. The source is our own constant
// text (lib/api/docs.ts), so it is rendered without the README sanitiser
// and headings keep ids for in-page links. Server only.
import { Marked } from "marked";

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = text
        .replace(/<[^>]+>/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
  },
});

export function renderApiDocs(markdown: string): string {
  return md.parse(markdown, { async: false }) as string;
}
