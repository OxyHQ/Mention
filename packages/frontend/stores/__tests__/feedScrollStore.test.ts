import {
    clearAllFeedMemoryCaches,
    getFeedScrollOffset,
    setFeedScrollOffset,
} from '../feedScrollStore';

describe('feedScrollStore native offsets', () => {
    beforeEach(() => {
        clearAllFeedMemoryCaches();
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
        clearAllFeedMemoryCaches();
        expect(getFeedScrollOffset('viewer-a|explore')).toBe(0);
    });
});
