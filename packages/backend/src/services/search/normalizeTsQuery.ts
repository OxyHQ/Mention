/**
 * Remove duplicate boolean operands after PostgreSQL has parsed/stemmed a web
 * search. PostgreSQL otherwise estimates `word & word` as independent matches,
 * underestimates its frequency and can scan the entire archive for a recent page.
 * Operate on tsquery output, never user syntax: quoted phrases retain positions,
 * and different spellings that stem to the same lexeme are handled together.
 */
export function normalizeTsQuery(query: string): string {
  if (!query) return query;
  const tokens = query.match(/'(?:[^'\\]|\\.|'')*'(?::[A-D*]+)?|<->|<\d+>|[!&|()]/g) ?? [];
  type Node = { operator: string; children: Node[]; text: string };
  const nodes: Node[] = [];
  const operators: string[] = [];
  const precedence: Record<string, number> = { '|': 1, '&': 2, '!': 4 };
  function priority(operator: string): number {
    return operator.startsWith('<') ? 3 : (precedence[operator] ?? 0);
  }
  function reduce(): void {
    const operator = operators.pop();
    const right = nodes.pop();
    if (!operator || !right) throw new Error('Invalid PostgreSQL tsquery operand');
    if (operator === '!') {
      nodes.push({ operator, children: [right], text: `!(${right.text})` });
      return;
    }
    const left = nodes.pop();
    if (!left) throw new Error('Invalid PostgreSQL tsquery operand');
    let children = [left, right];
    if (operator === '&' || operator === '|') {
      children = children.flatMap((child) =>
        child.operator === operator ? child.children : [child],
      );
      children = [...new Map(children.map((child) => [child.text, child])).values()];
    }
    nodes.push(
      children.length === 1
        ? children[0]
        : {
            operator,
            children,
            text: `(${children.map((child) => child.text).join(` ${operator} `)})`,
          },
    );
  }
  // Iterative precedence parsing avoids a JavaScript call-stack limit for long
  // searches. PostgreSQL, rather than a second user-facing parser, owns syntax.
  for (const token of tokens) {
    if (token.startsWith("'")) {
      nodes.push({ operator: '', children: [], text: token });
    } else if (token === '(' || token === '!') {
      operators.push(token);
    } else if (token === ')') {
      while (operators.length && operators[operators.length - 1] !== '(') reduce();
      if (operators.pop() !== '(') throw new Error('Invalid PostgreSQL tsquery group');
    } else {
      while (operators.length && priority(operators[operators.length - 1]) >= priority(token)) {
        reduce();
      }
      operators.push(token);
    }
  }
  while (operators.length) {
    if (operators[operators.length - 1] === '(')
      throw new Error('Invalid PostgreSQL tsquery group');
    reduce();
  }
  if (nodes.length !== 1) throw new Error('Invalid PostgreSQL tsquery expression');
  return nodes[0].text;
}
