import {
    advanceLocalPostRevision,
    clearFeedScrollOffsets,
    getFeedScrollOffset,
    getLocalPostRevision,
    setFeedScrollOffset,
    subscribeToLocalPostRevision,
} from '../feedScrollStore';

describe('feedScrollStore native offsets', () => {
    beforeEach(() => {
        clearFeedScrollOffsets();
    });

    it('keeps offsets isolated by feed identity', () => {
        setFeedScrollOffset('viewer-a|explore', 420);
        setFeedScrollOffset('viewer-a|following', 80);

        expect(getFeedScrollOffset('viewer-a|explore')).toBe(420);
        expect(getFeedScrollOffset('viewer-a|following')).toBe(80);
        expect(getFeedScrollOffset('viewer-b|explore')).toBe(0);
    });

    it('clamps negative offsets and clears them at the account boundary', () => {
        setFeedScrollOffset('viewer-a|explore', -10);
        expect(getFeedScrollOffset('viewer-a|explore')).toBe(0);

        setFeedScrollOffset('viewer-a|explore', 200);
        clearFeedScrollOffsets();
        expect(getFeedScrollOffset('viewer-a|explore')).toBe(0);
    });
});

describe('feedScrollStore local-post revision', () => {
    it('advances once per published post and tells its subscribers until they leave', () => {
        const listener = jest.fn();
        const unsubscribe = subscribeToLocalPostRevision(listener);
        const before = getLocalPostRevision();

        advanceLocalPostRevision();
        expect(getLocalPostRevision()).toBe(before + 1);
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        advanceLocalPostRevision();
        expect(getLocalPostRevision()).toBe(before + 2);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
