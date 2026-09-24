/**
 * Babel plugin for the row-cost harness only: `import(x)` → a promise of
 * `require(x)`. Metro splits lazy imports itself, so babel-preset-expo leaves
 * `import()` untouched under the `metro` caller, and Node refuses it inside a
 * Jest vm context. Rows lazy-load real children (the quoted post's nested
 * `PostItem`), and the harness must mount those, not a fallback.
 */
module.exports = function perfDynamicImport({ types: t }) {
  return {
    name: 'perf-dynamic-import',
    visitor: {
      CallExpression(path) {
        if (path.node.callee.type !== 'Import') return;
        const requireCall = t.callExpression(t.identifier('require'), path.node.arguments);
        path.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), []),
              t.identifier('then'),
            ),
            [t.arrowFunctionExpression([], requireCall)],
          ),
        );
      },
    },
  };
};
