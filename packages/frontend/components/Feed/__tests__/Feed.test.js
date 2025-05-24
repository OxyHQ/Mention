"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var react_native_1 = require("@testing-library/react-native");
var index_1 = require("../index");
var useFeed_1 = require("@/hooks/useFeed");
var react_native_2 = require("react-native");
// Mocking dependencies
jest.mock('@/hooks/useFeed');
jest.mock('../../Post', function () { return function (_a) {
    var postData = _a.postData;
    return (<react_native_2.Text testID={"post-".concat(postData.id)}>{postData.text}</react_native_2.Text>);
}; });
jest.mock('../../ErrorBoundary', function () { return function (_a) {
    var children = _a.children;
    return <>{children}</>;
}; });
jest.mock('../../Post/CreatePost', function () { return function (_a) {
    var onPress = _a.onPress;
    return (<react_native_2.Text testID="create-post" onPress={onPress}>Create Post</react_native_2.Text>);
}; });
jest.mock('react-i18next', function () { return ({
    useTranslation: function () { return ({
        t: function (key) { return key; }
    }); }
}); });
describe('Feed Component', function () {
    beforeEach(function () {
        jest.clearAllMocks();
        useFeed_1.useFeed.mockReturnValue({
            posts: [],
            loading: false,
            refreshing: false,
            error: null,
            hasMore: false,
            fetchMore: jest.fn(),
            refresh: jest.fn()
        });
    });
    it('renders correctly with posts', function () {
        var mockPosts = [
            { id: '1', text: 'Test post 1' },
            { id: '2', text: 'Test post 2' }
        ];
        useFeed_1.useFeed.mockReturnValue({
            posts: mockPosts,
            loading: false,
            refreshing: false,
            error: null,
            hasMore: false,
            fetchMore: jest.fn(),
            refresh: jest.fn()
        });
        (0, react_native_1.render)(<index_1.default />);
        expect(react_native_1.screen.getByTestId('post-1')).toBeTruthy();
        expect(react_native_1.screen.getByTestId('post-2')).toBeTruthy();
    });
    it('renders create post when showCreatePost is true', function () {
        (0, react_native_1.render)(<index_1.default showCreatePost={true}/>);
        expect(react_native_1.screen.getByTestId('create-post')).toBeTruthy();
    });
    it('calls onCreatePostPress when create post is pressed', function () {
        var mockOnCreatePostPress = jest.fn();
        (0, react_native_1.render)(<index_1.default showCreatePost={true} onCreatePostPress={mockOnCreatePostPress}/>);
        react_native_1.fireEvent.press(react_native_1.screen.getByTestId('create-post'));
        expect(mockOnCreatePostPress).toHaveBeenCalled();
    });
    it('shows error message when there is an error', function () {
        useFeed_1.useFeed.mockReturnValue({
            posts: [],
            loading: false,
            refreshing: false,
            error: 'Failed to load feed',
            hasMore: false,
            fetchMore: jest.fn(),
            refresh: jest.fn()
        });
        (0, react_native_1.render)(<index_1.default />);
        expect(react_native_1.screen.getByText('Failed to load feed')).toBeTruthy();
        expect(react_native_1.screen.getByText('Tap to retry')).toBeTruthy();
    });
    it('shows empty message for following feed when no posts', function () {
        useFeed_1.useFeed.mockReturnValue({
            posts: [],
            loading: false,
            refreshing: false,
            error: null,
            hasMore: false,
            fetchMore: jest.fn(),
            refresh: jest.fn()
        });
        (0, react_native_1.render)(<index_1.default type="following"/>);
        expect(react_native_1.screen.getByText('No posts from people you follow yet')).toBeTruthy();
    });
    it('passes the correct feed type to useFeed', function () {
        (0, react_native_1.render)(<index_1.default type="following"/>);
        expect(useFeed_1.useFeed).toHaveBeenCalledWith({ type: 'following', parentId: undefined });
        (0, react_native_1.render)(<index_1.default type="media"/>);
        expect(useFeed_1.useFeed).toHaveBeenCalledWith({ type: 'media', parentId: undefined });
    });
    it('fetches more posts when reaching the end', function () {
        var mockFetchMore = jest.fn();
        useFeed_1.useFeed.mockReturnValue({
            posts: [{ id: '1', text: 'Test post 1' }],
            loading: false,
            refreshing: false,
            error: null,
            hasMore: true,
            fetchMore: mockFetchMore,
            refresh: jest.fn()
        });
        var getByTestId = (0, react_native_1.render)(<index_1.default />).getByTestId;
        // Simulate reaching the end of the list
        (0, react_native_1.fireEvent)(getByTestId('post-1'), 'onEndReached');
        expect(mockFetchMore).toHaveBeenCalled();
    });
    it('refreshes the feed when pulled down', function () {
        var mockRefresh = jest.fn();
        useFeed_1.useFeed.mockReturnValue({
            posts: [{ id: '1', text: 'Test post 1' }],
            loading: false,
            refreshing: false,
            error: null,
            hasMore: true,
            fetchMore: jest.fn(),
            refresh: mockRefresh
        });
        (0, react_native_1.render)(<index_1.default />);
        // Get the refresh control and trigger refresh
        var flatList = react_native_1.screen.UNSAFE_getByType('RCTScrollView');
        var refreshControl = flatList.props.refreshControl;
        (0, react_native_1.fireEvent)(refreshControl, 'refresh');
        expect(mockRefresh).toHaveBeenCalled();
    });
});
