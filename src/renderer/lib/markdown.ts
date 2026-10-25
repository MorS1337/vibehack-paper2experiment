interface MarkdownNode {
  type: string;
  value?: string;
  data?: unknown;
  children?: MarkdownNode[];
}

/** Prices such as "$0/h, $0 total" must not become accidental inline formulas. */
export function preserveCurrencyMath() {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode) => {
      if (
        node.type === "inlineMath" &&
        /^\d+(?:[.,]\d+)?(?:\s*\/\s*(?:h|hr|hour)\b|\s+(?:USD|EUR|total|and|per|budget|cap)\b)/i.test(
          node.value ?? "",
        )
      ) {
        node.type = "text";
        node.value = `$${node.value}$`;
        delete node.data;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
