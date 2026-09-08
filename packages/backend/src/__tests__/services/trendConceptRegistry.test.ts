import { describe, expect, it } from 'vitest';
import {
  conceptLabels,
  localizedConceptLabel,
  resolveTrendConcept,
} from '../../services/trending/conceptRegistry';
import { resolveTrendScope } from '../../services/trending/trendItems';

describe('multilingual trend concept identity', () => {
  it('resolves reviewed spellings across languages to one identity', () => {
    expect(resolveTrendConcept('oil', ['en'])?.id).toBe('topic:petroleum');
    expect(resolveTrendConcept('Petróleo', ['es'])?.id).toBe('topic:petroleum');
    expect(resolveTrendConcept('Pétrole', ['fr'])?.id).toBe('topic:petroleum');
  });

  it('does not guess an unregistered translation', () => {
    expect(resolveTrendConcept('aceite', ['es'])).toBeUndefined();
  });

  it('keeps unrelated entities separate', () => {
    expect(resolveTrendConcept('Fanta', ['es'])?.id).not.toBe(
      resolveTrendConcept('Casa Blanca', ['es'])?.id,
    );
  });

  it('serves a reviewed audience label without changing identity', () => {
    const concept = resolveTrendConcept('oil', ['en']);
    expect(concept).toBeDefined();
    if (!concept) return;
    expect(localizedConceptLabel(concept, 'es', 'oil')).toBe('Petróleo');
    expect(conceptLabels(concept).en).toBe('Oil');
  });
});

describe('trend audience scope', () => {
  it('keeps language and geography independent', () => {
    expect(resolveTrendScope(['es', 'en'], ['US', 'MX'])).toBe('global');
    expect(resolveTrendScope(['es', 'en'], [])).toBe('multilingual');
    expect(resolveTrendScope(['es'], ['MX'])).toBe('regional');
    expect(resolveTrendScope(['es'], [])).toBe('language');
    expect(resolveTrendScope([], [])).toBe('community');
  });
});
