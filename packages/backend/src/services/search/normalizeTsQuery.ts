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
  let position = 0;
  type Node = { operator: string; children: Node[]; text: string };
  const precedence: Record<string, number> = { '|': 1, '&': 2 };
  function priority(operator: string): number {
    return operator.startsWith('<') ? 3 : (precedence[operator] ?? 0);
  }
  function parse(minimum: number): Node {
    const token = tokens[position++];
    let left: Node;
    if (token === '!') {
      const child = parse(4);
      left = { operator: '!', children: [child], text: `!(${child.text})` };
    } else if (token === '(') {
      left = parse(1);
      if (tokens[position++] !== ')') throw new Error('Invalid PostgreSQL tsquery group');
    } else if (token?.startsWith("'")) {
      left = { operator: '', children: [], text: token };
    } else {
      throw new Error('Invalid PostgreSQL tsquery operand');
    }
    while (position < tokens.length) {
      const operator = tokens[position];
      const rank = priority(operator);
      if (rank < minimum) break;
      position++;
      const right = parse(rank + 1);
      let children = [left, right];
      if (operator === '&' || operator === '|') {
        children = children.flatMap((child) =>
          child.operator === operator ? child.children : [child],
        );
        children = [...new Map(children.map((child) => [child.text, child])).values()];
      }
      left =
        children.length === 1
          ? children[0]
          : {
              operator,
              children,
              text: `(${children.map((child) => child.text).join(` ${operator} `)})`,
            };
    }
    return left;
  }
  const result = parse(1);
  if (position !== tokens.length) throw new Error('Invalid PostgreSQL tsquery suffix');
  return result.text;
}
