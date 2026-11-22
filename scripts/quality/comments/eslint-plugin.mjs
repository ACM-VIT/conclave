import { ESLINT_LANGUAGE, classifyComments, normalizeNewlines } from "./policy.mjs";

export { vendoredIgnores } from "./policy.mjs";

const noComments = {
  meta: {
    type: "suggestion",
    docs: { description: "Disallow comments other than tool directives and license headers" },
    schema: [],
    messages: {
      comment:
        "Delete this comment. Say it with names, types or tests, or record the decision in an ADR under docs/adr.",
      directiveReason:
        "This directive needs a reason: `eslint-disable <rule> -- <reason>` or `@ts-expect-error <description>`.",
      selfDisable: "conclave/no-comments cannot be switched off inline. Name the rules a disable directive covers.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        const { text, toNormalized } = normalizeNewlines(sourceCode.text);
        const verdicts = classifyComments(
          text,
          comments.map((comment) => ({
            start: toNormalized(comment.range[0]),
            end: toNormalized(comment.range[1]),
            text: sourceCode.getText(comment).replace(/\r\n?/g, "\n"),
          })),
          ESLINT_LANGUAGE,
        );
        verdicts.forEach((verdict, index) => {
          if (verdict.problem) context.report({ loc: comments[index].loc, messageId: verdict.problem });
        });
      },
    };
  },
};

export default {
  meta: { name: "conclave" },
  rules: { "no-comments": noComments },
};
