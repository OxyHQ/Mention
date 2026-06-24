import React from 'react';

// Dynamic import to break circular dependency: PostItem -> PostAttachmentNested -> PostItem
let PostItemComponent: React.ComponentType<any> | null = null;
const getPostItem = () => {
  if (!PostItemComponent) {
    PostItemComponent = require('../../Feed/PostItem').default;
  }
  return PostItemComponent;
};

interface PostAttachmentNestedProps {
  nestedPost: any;
  nestingDepth: number;
}

// Renders the embedded original (a boost's original post or a quoted post) as a
// nested `PostItem`. This is a standalone VERTICAL body block rendered directly
// by `PostItem` — it is NOT an item inside the horizontal attachments carousel.
// The bordered nested-card chrome (border, radius, padding) lives in `PostItem`'s
// `nestedPostContainer` style; this component just fills the width of the body
// content column it is placed in.
const PostAttachmentNested: React.FC<PostAttachmentNestedProps> = ({
  nestedPost,
  nestingDepth,
}) => {
  const PostItem = getPostItem();
  if (!PostItem) return null;

  return <PostItem post={nestedPost} isNested={true} nestingDepth={nestingDepth + 1} />;
};

export default PostAttachmentNested;

