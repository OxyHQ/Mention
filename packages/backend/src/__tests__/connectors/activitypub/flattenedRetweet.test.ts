/**
 * A retweet a bridge flattened into an ordinary post cannot be rendered as the
 * repost it is, so it is dropped until it can.
 *
 * The object carries nothing to reconstruct from — verified field by field on
 * live notes from both bridges: `inReplyTo` null, `tag` empty, no `quoteUrl`,
 * no link to the upstream post, no id. The retweeter is `attributedTo`, so the
 * post would publish under a byline that did not write the text.
 *
 * This is the ONLY place a body is read to decide something, and the rule is
 * narrow because the two directions of failure are not alike: a missed retweet
 * stores what we store today, while a false match discards a real post.
 */

import { isBridgeFlattenedRetweet } from '../../../connectors/activitypub/flattenedRetweet';

describe('isBridgeFlattenedRetweet', () => {
  it.each([
    ['mastox, the post reported', 'RT: @Julio_Rodr_ ¡Tres años de Canal Red navegando a contracorriente!'],
    ['bird.makeup, the other one', 'RT: @BoGardiner1 Remember this early press briefing from Trump on covid?'],
    ['no space after the colon', 'RT:@someone hello'],
  ])('matches %s', (_case, body) => {
    expect(isBridgeFlattenedRetweet(body)).toBe(true);
  });

  /**
   * Every one of these is a post we would DESTROY on a false match, which is why
   * the rule is anchored and requires the `@`.
   */
  it.each([
    ['a sentence that merely mentions RT', 'Vi el RT: @alguien lo dijo ayer'],
    ['RT not at the start', 'Interesante — RT: @alguien'],
    ['a real word beginning with RT', 'RTVE ha publicado esto'],
    ['RT without a handle after it', 'RT: esto es una cita famosa'],
    ['a post about retweets', 'La función de RT se inventó en Twitter'],
    ['an ordinary post', 'Buenos días a todos'],
    ['an empty body', ''],
  ])('does NOT match %s', (_case, body) => {
    expect(isBridgeFlattenedRetweet(body)).toBe(false);
  });

  it('is case-sensitive on the RT marker', () => {
    // The bridges emit uppercase `RT:`. Matching `rt:` too would start claiming
    // ordinary prose in languages where that is a word fragment.
    expect(isBridgeFlattenedRetweet('rt: @alguien hola')).toBe(false);
  });
});
