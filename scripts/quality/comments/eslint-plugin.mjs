import { ESLINT_LANGUAGE, classifyComments } from "./policy.mjs";

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
      selfDisable: "Name the rules this directive disables. conclave/no-comments cannot be disabled inline.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        const verdicts = classifyComments(
          sourceCode.text,
          comments.map((comment) => ({
            start: comment.range[0],
            end: comment.range[1],
            text: sourceCode.getText(comment),
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
