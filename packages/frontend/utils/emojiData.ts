/**
 * Curated emoji dataset organized by category.
 * Covers the most commonly used emojis in social media contexts.
 */

export interface EmojiCategory {
  id: string;
  name: string;
  icon: string;
  emojis: string[];
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: 'recent',
    name: 'Recently Used',
    icon: '\u{1F552}',
    emojis: [], // Populated at runtime from storage
  },
  {
    id: 'smileys',
    name: 'Smileys & People',
    icon: '\u{1F600}',
    emojis: [
      '\u{1F600}', '\u{1F603}', '\u{1F604}', '\u{1F601}', '\u{1F606}', '\u{1F605}', '\u{1F602}', '\u{1F923}',
      '\u{1F60A}', '\u{1F607}', '\u{1F642}', '\u{1F643}', '\u{1F609}', '\u{1F60C}', '\u{1F60D}', '\u{1F970}',
      '\u{1F618}', '\u{1F617}', '\u{1F619}', '\u{1F61A}', '\u{1F60B}', '\u{1F61B}', '\u{1F61C}', '\u{1F92A}',
      '\u{1F61D}', '\u{1F911}', '\u{1F917}', '\u{1F92D}', '\u{1F92B}', '\u{1F914}', '\u{1F910}', '\u{1F928}',
      '\u{1F610}', '\u{1F611}', '\u{1F636}', '\u{1F60F}', '\u{1F612}', '\u{1F644}', '\u{1F62C}', '\u{1F925}',
      '\u{1F60E}', '\u{1F929}', '\u{1F973}', '\u{1F978}', '\u{1F974}', '\u{1F61E}', '\u{1F61F}', '\u{1F620}',
      '\u{1F621}', '\u{1F622}', '\u{1F62D}', '\u{1F624}', '\u{1F616}', '\u{1F623}', '\u{1F625}', '\u{1F630}',
      '\u{1F628}', '\u{1F631}', '\u{1F633}', '\u{1F92F}', '\u{1F626}', '\u{1F627}', '\u{1F62E}', '\u{1F632}',
      '\u{1F634}', '\u{1F62A}', '\u{1F924}', '\u{1F635}', '\u{1F910}', '\u{1F974}', '\u{1F922}', '\u{1F92E}',
      '\u{1F927}', '\u{1F975}', '\u{1F976}', '\u{1F637}', '\u{1F912}', '\u{1F915}', '\u{1F47B}', '\u{1F4A9}',
      '\u{1F921}', '\u{1F47E}', '\u{1F47D}', '\u{1F916}', '\u{1F383}', '\u{1F648}', '\u{1F649}', '\u{1F64A}',
    ],
  },
  {
    id: 'gestures',
    name: 'Hands & Gestures',
    icon: '\u{1F44D}',
    emojis: [
      '\u{1F44F}', '\u{1F44D}', '\u{1F44E}', '\u{1F44A}', '\u270A', '\u{1F91B}', '\u{1F91C}', '\u{1F91E}',
      '\u270C\uFE0F', '\u{1F91F}', '\u{1F918}', '\u{1F44C}', '\u{1F90F}', '\u{1F448}', '\u{1F449}', '\u{1F446}',
      '\u{1F447}', '\u261D\uFE0F', '\u270B', '\u{1F91A}', '\u{1F590}\uFE0F', '\u{1F596}', '\u{1F44B}', '\u{1F919}',
      '\u{1F4AA}', '\u{1F9BE}', '\u{1F64F}', '\u{1F91D}', '\u270D\uFE0F', '\u{1F485}', '\u{1F933}', '\u{1F4AA}',
    ],
  },
  {
    id: 'hearts',
    name: 'Hearts & Love',
    icon: '\u2764\uFE0F',
    emojis: [
      '\u2764\uFE0F', '\u{1F9E1}', '\u{1F49B}', '\u{1F49A}', '\u{1F499}', '\u{1F49C}', '\u{1F5A4}', '\u{1F90D}',
      '\u{1F90E}', '\u{1F498}', '\u{1F49D}', '\u{1F496}', '\u{1F497}', '\u{1F493}', '\u{1F49E}', '\u{1F495}',
      '\u{1F48C}', '\u{1F48B}', '\u{1F48D}', '\u{1F490}', '\u{1F339}', '\u{1F33A}', '\u{1F33B}', '\u{1F337}',
    ],
  },
  {
    id: 'nature',
    name: 'Animals & Nature',
    icon: '\u{1F436}',
    emojis: [
      '\u{1F436}', '\u{1F431}', '\u{1F42D}', '\u{1F439}', '\u{1F430}', '\u{1F43B}', '\u{1F43C}', '\u{1F428}',
      '\u{1F42F}', '\u{1F981}', '\u{1F42E}', '\u{1F437}', '\u{1F438}', '\u{1F435}', '\u{1F412}', '\u{1F414}',
      '\u{1F427}', '\u{1F426}', '\u{1F985}', '\u{1F98B}', '\u{1F41B}', '\u{1F41D}', '\u{1F422}', '\u{1F40D}',
      '\u{1F433}', '\u{1F420}', '\u{1F419}', '\u{1F41A}', '\u{1F980}', '\u{1F990}', '\u{1F984}', '\u{1F98E}',
      '\u{1F332}', '\u{1F333}', '\u{1F334}', '\u{1F335}', '\u{1F33F}', '\u{1F340}', '\u{1F341}', '\u{1F342}',
    ],
  },
  {
    id: 'food',
    name: 'Food & Drink',
    icon: '\u{1F354}',
    emojis: [
      '\u{1F34E}', '\u{1F34A}', '\u{1F34B}', '\u{1F34C}', '\u{1F349}', '\u{1F347}', '\u{1F353}', '\u{1F352}',
      '\u{1F351}', '\u{1F34D}', '\u{1F951}', '\u{1F96D}', '\u{1F954}', '\u{1F955}', '\u{1F33D}', '\u{1F336}\uFE0F',
      '\u{1F354}', '\u{1F355}', '\u{1F32E}', '\u{1F32F}', '\u{1F37F}', '\u{1F96A}', '\u{1F373}', '\u{1F370}',
      '\u{1F382}', '\u{1F36D}', '\u{1F36B}', '\u{1F369}', '\u{1F366}', '\u{1F377}', '\u{1F37A}', '\u2615',
    ],
  },
  {
    id: 'activities',
    name: 'Activities',
    icon: '\u26BD',
    emojis: [
      '\u26BD', '\u{1F3C0}', '\u{1F3C8}', '\u26BE', '\u{1F3BE}', '\u{1F3D0}', '\u{1F3B1}', '\u{1F3D3}',
      '\u{1F3B8}', '\u{1F3B5}', '\u{1F3B6}', '\u{1F3A4}', '\u{1F3AC}', '\u{1F3A8}', '\u{1F3AE}', '\u{1F3B2}',
      '\u{1F3C6}', '\u{1F3C5}', '\u{1F947}', '\u{1F948}', '\u{1F949}', '\u{1F3AF}', '\u{1F9E9}', '\u{1F3AD}',
    ],
  },
  {
    id: 'objects',
    name: 'Objects',
    icon: '\u{1F4A1}',
    emojis: [
      '\u{1F4A1}', '\u{1F4F1}', '\u{1F4BB}', '\u{1F4F7}', '\u{1F4F9}', '\u{1F4FA}', '\u{1F4E3}', '\u{1F514}',
      '\u{1F4E7}', '\u{1F4DD}', '\u{1F4D6}', '\u{1F4DA}', '\u{1F4B0}', '\u{1F48E}', '\u{1F52E}', '\u{1F52D}',
      '\u{1F4A3}', '\u{1F52A}', '\u{1F6E1}\uFE0F', '\u{1F511}', '\u{1F512}', '\u{1F4E6}', '\u{1F381}', '\u{1F388}',
      '\u{1F389}', '\u{1F38A}', '\u{1F3C1}', '\u{1F6A9}', '\u{1F3F3}\uFE0F', '\u{1F3F4}', '\u2709\uFE0F', '\u{1F4CC}',
    ],
  },
  {
    id: 'symbols',
    name: 'Symbols',
    icon: '\u2728',
    emojis: [
      '\u2728', '\u{1F31F}', '\u{1F4AB}', '\u{1F525}', '\u{1F4A5}', '\u{1F4AF}', '\u2757', '\u2753',
      '\u2705', '\u274C', '\u{1F6AB}', '\u{1F4A4}', '\u{1F4A8}', '\u{1F4A6}', '\u{1F3B5}', '\u{1F3B6}',
      '\u267B\uFE0F', '\u269B\uFE0F', '\u{1F52F}', '\u262E\uFE0F', '\u2622\uFE0F', '\u2623\uFE0F', '\u{1F4F4}', '\u{1F508}',
      '\u2B50', '\u{1F320}', '\u26A1', '\u{1F308}', '\u2600\uFE0F', '\u{1F324}\uFE0F', '\u26C5', '\u{1F327}\uFE0F',
    ],
  },
];

/** Maximum number of recently used emojis to store */
export const MAX_RECENT_EMOJIS = 32;
