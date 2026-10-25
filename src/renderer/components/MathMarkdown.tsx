import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { preserveCurrencyMath } from "../lib/markdown.js";

export default function MathMarkdown({
  text,
  components,
}: {
  text: string;
  components: Components;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath, preserveCurrencyMath]}
      rehypePlugins={[rehypeKatex]}
      skipHtml
      components={components}
    >
      {text}
    </Markdown>
  );
}
