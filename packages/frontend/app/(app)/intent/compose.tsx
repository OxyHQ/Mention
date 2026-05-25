/**
 * Public alias for the compose screen, used as the canonical third-party
 * intent URL: `https://mention.earth/intent/compose?text=...`.
 *
 * All params are parsed by the compose screen itself; this file is a thin
 * re-export so the route exists in the router tree.
 */
export { default } from '../compose';
