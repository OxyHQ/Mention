import {
    applyOperatorCompletion,
    buildOperatorValueSuggestions,
    filterRecentSearches,
    findActiveOperatorToken,
    toProfileHandleSuggestion,
    type ActiveOperatorToken,
} from '../searchSuggestions';

/** Position the caret at the end of the query, the way typing does. */
function atEnd(query: string): ActiveOperatorToken | null {
    return findActiveOperatorToken(query, query.length);
}

describe('findActiveOperatorToken', () => {
    it('finds the operator being typed at the end of the query', () => {
        expect(atEnd('cats from:al')).toEqual({ prefix: 'from', value: 'al', start: 5, end: 12 });
    });

    it('finds an operator with no value yet', () => {
        expect(atEnd('from:')).toEqual({ prefix: 'from', value: '', start: 0, end: 5 });
    });

    it('finds the token the caret sits in, not merely the last one', () => {
        const query = 'from:al cats';
        expect(findActiveOperatorToken(query, 7)).toMatchObject({ prefix: 'from', value: 'al' });
        // Caret in the trailing word — that token is not an operator.
        expect(findActiveOperatorToken(query, query.length)).toBeNull();
    });

    it('lowercases the prefix so FROM: completes like from:', () => {
        expect(atEnd('FROM:a')).toMatchObject({ prefix: 'from', value: 'a' });
    });

    it('ignores plain words and operators with no closed value set', () => {
        expect(atEnd('cats')).toBeNull();
        expect(atEnd('since:2026')).toBeNull();
        expect(atEnd('min_likes:1')).toBeNull();
    });

    it('clamps an out-of-range caret instead of reading past the query', () => {
        // Either bound lands inside the sole token, so both resolve it whole.
        expect(findActiveOperatorToken('from:al', 999)).toMatchObject({ prefix: 'from', value: 'al' });
        expect(findActiveOperatorToken('from:al', -5)).toMatchObject({ prefix: 'from', value: 'al' });
    });
});

describe('buildOperatorValueSuggestions', () => {
    const history = ['from:alice cats', 'to:@bob hello', 'from:alice dogs', 'plain query'];

    it('leads a user operator with me', () => {
        const token = atEnd('from:');
        expect(token).not.toBeNull();
        expect(buildOperatorValueSuggestions(token as ActiveOperatorToken, history, 6)[0]).toBe('me');
    });

    it('offers previously-searched people, deduped and @-stripped, across BOTH user operators', () => {
        const token = atEnd('to:');
        // `alice` was only ever used with `from:`, and is still the right suggestion
        // for `to:` — the useful set is people, not per-operator operands.
        expect(buildOperatorValueSuggestions(token as ActiveOperatorToken, history, 6)).toEqual(['me', 'alice', 'bob']);
    });

    it('narrows to what has been typed so far', () => {
        const token = atEnd('from:al');
        expect(buildOperatorValueSuggestions(token as ActiveOperatorToken, history, 6)).toEqual(['alice']);
    });

    it('drops a value the viewer already typed in full', () => {
        const token = atEnd('from:me');
        expect(buildOperatorValueSuggestions(token as ActiveOperatorToken, history, 6)).not.toContain('me');
    });

    it('offers the closed value set for has:', () => {
        const token = atEnd('has:');
        expect(buildOperatorValueSuggestions(token as ActiveOperatorToken, history, 6)).toEqual(['media', 'links']);
    });

    it('honours the cap', () => {
        const token = atEnd('to:');
        expect(buildOperatorValueSuggestions(token as ActiveOperatorToken, history, 2)).toHaveLength(2);
    });
});

describe('applyOperatorCompletion', () => {
    it('completes the token and leaves the rest of the query alone', () => {
        const query = 'cats from:al dogs';
        const token = findActiveOperatorToken(query, 12);
        expect(applyOperatorCompletion(query, token as ActiveOperatorToken, 'alice')).toBe('cats from:alice dogs');
    });

    it('appends a separator so the next keystroke starts a new token', () => {
        const query = 'from:';
        expect(applyOperatorCompletion(query, atEnd(query) as ActiveOperatorToken, 'me')).toBe('from:me ');
    });

    it('does not double a space that is already there', () => {
        const query = 'from: cats';
        const token = findActiveOperatorToken(query, 5);
        expect(applyOperatorCompletion(query, token as ActiveOperatorToken, 'me')).toBe('from:me cats');
    });

    it('leaves exactly one space in every position', () => {
        for (const query of ['from:', 'cats from:al', 'from: cats', 'cats from:al dogs']) {
            const token = findActiveOperatorToken(query, query.indexOf('from:') + 5);
            const completed = applyOperatorCompletion(query, token as ActiveOperatorToken, 'me');
            expect(completed).not.toMatch(/ {2}/);
            expect(completed).toContain('from:me ');
        }
    });
});

describe('toProfileHandleSuggestion', () => {
    it('accepts an explicit @handle', () => {
        expect(toProfileHandleSuggestion('@nate')).toBe('nate');
        expect(toProfileHandleSuggestion('  @nate  ')).toBe('nate');
    });

    it('accepts a federated user@domain without the leading @', () => {
        expect(toProfileHandleSuggestion('nate@mention.earth')).toBe('nate@mention.earth');
        expect(toProfileHandleSuggestion('@nate@mention.earth')).toBe('nate@mention.earth');
    });

    it('does NOT treat a bare word as a handle', () => {
        expect(toProfileHandleSuggestion('coffee')).toBeNull();
    });

    it('rejects anything that could not be a handle', () => {
        expect(toProfileHandleSuggestion('@two words')).toBeNull();
        expect(toProfileHandleSuggestion('from:me')).toBeNull();
        expect(toProfileHandleSuggestion('@')).toBeNull();
        expect(toProfileHandleSuggestion('nate@nodot')).toBeNull();
    });
});

describe('filterRecentSearches', () => {
    const history = ['cats', 'cat food', 'dogs'];

    it('returns the head of the history when nothing is typed', () => {
        expect(filterRecentSearches(history, '', 2)).toEqual(['cats', 'cat food']);
    });

    it('keeps matching entries instead of hiding the history', () => {
        expect(filterRecentSearches(history, 'cat', 5)).toEqual(['cats', 'cat food']);
    });

    it('drops the query itself — offering it back suggests nothing', () => {
        expect(filterRecentSearches(history, 'cats', 5)).toEqual([]);
    });

    it('matches case-insensitively and honours the cap', () => {
        expect(filterRecentSearches(history, 'CAT', 1)).toEqual(['cats']);
    });
});
