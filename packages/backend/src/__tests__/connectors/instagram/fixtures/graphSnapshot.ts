/**
 * REAL Instagram Graph API (Business Discovery, v23.0) response data for @zuck
 * and @plex, captured by `~/ig-business-discovery/ig_discovery.py` into
 * `snapshot.json`. Copied VERBATIM — do not hand-edit; re-capture instead. The
 * signed CDN URLs have long expired, which is fine: no test fetches them.
 *
 * Chosen to cover every media shape the mapper distinguishes:
 *  - IMAGE               @zuck  /p/DaX_K4yxa65/
 *  - REEL_WITH_VIDEO     @plex  /reel/DbOuHlpskDi/   (media_url + thumbnail_url)
 *  - REEL_WITHOUT_VIDEO  @plex  /reel/DbMRPUwsBVT/   (licensed audio: thumbnail only)
 *  - BIG_IMAGE_CAROUSEL  @plex  /p/DaGZM5XjJpr/      (18 IMAGE children)
 *  - MIXED_CAROUSEL      @zuck  /p/DZ7eUsUEbOs/      (8 children, IMAGE + VIDEO)
 */
import type { GraphMedia } from '../../../../connectors/instagram/graphClient';

export const ZUCK_PROFILE = {
  id: '17841401746480004',
  username: 'zuck',
  name: 'Mark Zuckerberg',
  biography: 'I build stuff',
  website: 'http://muse.ai/join',
  profile_picture_url:
    'https://scontent-lga3-2.xx.fbcdn.net/v/t51.82787-15/825351924_18634676146058217_2225710527213743691_n.jpg?_nc_cat=1&ccb=1-7&_nc_sid=7d201b&_nc_ohc=uz1eZ7jCU1IQ7kNvwGca1tT&_nc_oc=Adr-WaWvskrx8P2U4t_78Y748Naz_yEeU3BuG-ACkKGeLBzhUGnwXpPNAYkJi0PM6Hk&_nc_zt=23&_nc_ht=scontent-lga3-2.xx&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&oh=00_AQKSo1E-OGXEyl7wgwwxDCml8bm5JkDypfXNITLpqr_Low&oe=6ABE1D31',
  followers_count: 17249838,
  follows_count: 624,
  media_count: 444,
} as const;

export const PLEX_PROFILE = {
  id: '17841408799798652',
  username: 'plex',
  name: 'YoSoyPlex',
  biography: '💬',
  website: 'http://youtube.com/@YoSoyPlex',
  profile_picture_url:
    'https://scontent-lga3-2.xx.fbcdn.net/v/t51.75761-15/504395228_18228465874293327_6233438861677572763_n.jpg?_nc_cat=1&ccb=1-7&_nc_sid=7d201b&_nc_ohc=B2rHwNdoxtAQ7kNvwH29lUW&_nc_oc=AdrSXENCPGYUkZSvbEzlSea7_VqpoQzH9gHmPwy8CHhW09FBaPJePwYsBVFVaPyqxdY&_nc_zt=23&_nc_ht=scontent-lga3-2.xx&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQIw5LWZa_1dkEH09jAzAcqp_OIFtY014kd7oPFA4xlp4Q&oe=6ABE26B2',
  followers_count: 3352113,
  follows_count: 386,
  media_count: 38,
} as const;

export const IMAGE: GraphMedia = {
  id: '18006384212753272',
  caption: "Benny's first 4th. Welcome to the fam 🇺🇸",
  media_type: 'IMAGE',
  media_product_type: 'FEED',
  media_url:
    'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/731397625_18607365256058217_2061680228377786771_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=107&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiRkVFRC5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=RQGRPuKwvNwQ7kNvwG246DJ&_nc_oc=Adq5G12DK0HK1eVjMRLX93dYqMWla7j4BAi9Zso7jY0FDpiGAdc9tmrj5-2muLmnZ_0&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&oh=00_AQJby-L3B714QLT6s-da401ulZCXUtJO8agVjR_LX_v9Xw&oe=6ABE26FD',
  permalink: 'https://www.instagram.com/p/DaX_K4yxa65/',
  timestamp: '2026-07-04T14:47:06+0000',
  like_count: 171300,
  comments_count: 5909,
};

export const REEL_WITH_VIDEO: GraphMedia = {
  id: '18106413383239146',
  caption: 'llegamos',
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  media_url:
    'https://scontent-lga3-2.cdninstagram.com/o1/v/t2/f2/m86/AQPTbwvUOHNaOGOj-G-MFfMLXrUlJoWmdjZLvSRK800YzEtAQHBo2WQvJwNVvm5w1pXBUB94jDIAEUvyccO91BUr7OLMu7mrtUBUYcg.mp4?_nc_cat=101&_nc_sid=5e9851&_nc_ht=scontent-lga3-2.cdninstagram.com&_nc_ohc=t7pN_1AkOekQ7kNvwERA_93&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5JTlNUQUdSQU0uQ0xJUFMuQzMuNzIwLmRhc2hfYmFzZWxpbmVfMV92MSIsInhwdl9hc3NldF9pZCI6OTI4MzAxNjE2OTU4NTgyLCJhc3NldF9hZ2VfZGF5cyI6NjMsInZpX3VzZWNhc2VfaWQiOjEwMDk5LCJkdXJhdGlvbl9zIjo3LCJ1cmxnZW5fc291cmNlIjoid3d3In0%3D&ccb=17-1&vs=111a4e525a98c9c9&_nc_vs=HBksFQIYUmlnX3hwdl9yZWVsc19wZXJtYW5lbnRfc3JfcHJvZC83NTQ0ODY4N0FFODNFRTJFOTRBOTI4REVCMjgyMDVCRl92aWRlb19kYXNoaW5pdC5tcDQVAALIARIAFQIYUWlnX3hwdl9wbGFjZW1lbnRfcGVybWFuZW50X3YyLzdDNDQxMzM2MkQ4NDJFOThDQzVGMURDRTUyQUMyRDg0X2F1ZGlvX2Rhc2hpbml0Lm1wNBUCAsgBEgAoABgAGwKIB3VzZV9vaWwBMRJwcm9ncmVzc2l2ZV9yZWNpcGUBMRUAACbssfyBopKmAxUCKAJDMywXQB1U_fO2RaIYEmRhc2hfYmFzZWxpbmVfMV92MREAdf4HZeadAQA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&edm=AL-3X8kEAAAA&_nc_zt=28&oh=00_AQKcsXut28YgHvNGlt1kvH55AcIy5jplSPKcIsVsmxMwAQ&oe=6ABA3EAA',
  thumbnail_url:
    'https://scontent-lga3-3.cdninstagram.com/v/t51.82787-15/758253935_18275613253293327_9204532853643430100_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=106&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0xJUFMuYmVzdF9pbWFnZV91cmxnZW4uQzMifQ%3D%3D&_nc_ohc=ICYOhK4_2SgQ7kNvwHCuJlb&_nc_oc=AdqqPmudYySt92hd4pngXAzJvdWRkkRmX9MHikLAK2MU_enESJBD4qJyJC8t_QvoxsQ&_nc_zt=23&_nc_ht=scontent-lga3-3.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&_nc_tpa=Q5bMBQLhly_uSdmISOow03bt4iXnsoeVnyZHx4kCBp0SfFTIqBYTBXo-7cynVoL_kL0AtVqA_YBwmanuDQ&oh=00_AQK28HzVFMVWq62c7EATJSLYnib68oqTNvsK1H4MAhzpQA&oe=6ABE24EC',
  permalink: 'https://www.instagram.com/reel/DbOuHlpskDi/',
  timestamp: '2026-07-25T20:56:06+0000',
  like_count: 835788,
  comments_count: 2672,
};

export const REEL_WITHOUT_VIDEO: GraphMedia = {
  id: '18099731624350188',
  caption: 'readys🪽',
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  thumbnail_url:
    'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/756139094_18275502610293327_4169594033526167635_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=100&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0xJUFMuYmVzdF9pbWFnZV91cmxnZW4uQzMifQ%3D%3D&_nc_ohc=qG1V4_nTfIUQ7kNvwFurCa8&_nc_oc=AdqGpcwg0nPX4jRJl-zfABcJp_UDcmqMt_TsZ2dVensO60O1xIiTxcnIXjuZ_uUvKDc&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&_nc_tpa=Q5bMBQIoGTu7ASrAzsyHw_Y_a8NziGIZE4t8m_f839MMxqOb2yXiRFVXkYbgoQ7QbOExDlaJC90DxBAlVQ&oh=00_AQJPYlfqzUvdHsUTZsAFILejlLEr_J-JUHc14SuTFIfOiQ&oe=6ABE1F03',
  permalink: 'https://www.instagram.com/reel/DbMRPUwsBVT/',
  timestamp: '2026-07-24T22:06:15+0000',
  like_count: 710900,
  comments_count: 3141,
};

export const BIG_IMAGE_CAROUSEL: GraphMedia = {
  id: '18330480799251116',
  caption: 'feliz día al amor de mis vidas 🩶 aitana',
  media_type: 'CAROUSEL_ALBUM',
  media_product_type: 'FEED',
  media_url:
    'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/731677122_18272253454293327_7375949718358225693_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=111&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=_7y-jWJ1j3oQ7kNvwFlRNkt&_nc_oc=AdrqrVVOcwYscxZAw7USbZD-UuHxL07UUE58eepMFZpaX0v9vi6CYDHGsXJNYY4vA9Y&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQJXnPYq5PFKrQFXf2UJoIqBAmBPtjlLbN7dH_C5VbU-6A&oe=6ABE43B1',
  permalink: 'https://www.instagram.com/p/DaGZM5XjJpr/',
  timestamp: '2026-06-27T18:46:36+0000',
  like_count: 1473902,
  comments_count: 4009,
  children: {
    data: [
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/731677122_18272253454293327_7375949718358225693_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=111&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=_7y-jWJ1j3oQ7kNvwFlRNkt&_nc_oc=AdrqrVVOcwYscxZAw7USbZD-UuHxL07UUE58eepMFZpaX0v9vi6CYDHGsXJNYY4vA9Y&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQJXnPYq5PFKrQFXf2UJoIqBAmBPtjlLbN7dH_C5VbU-6A&oe=6ABE43B1',
        id: '18299409094303721',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/730833642_18272253472293327_8774354844593085081_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=109&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=2GE2q8p9UTAQ7kNvwHYW0wA&_nc_oc=Adq-opFDn8pelS08m6jmysbnjmiqR-HUwXJkR_t3rzQhHF50ugsKSzTtYf6r4kmfHbQ&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQLG6ZBt548C9vtCj-aFlkJWwTKPL2Kt5o2jz9tMguYdvw&oe=6ABE3766',
        id: '18036958859802972',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/731031363_18272253445293327_2296441476995123709_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=107&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=21eHtIdC8g8Q7kNvwE-BzZG&_nc_oc=AdoGr9Hp76QeeF3XchxGAJxIHTBZ9KSqoCx84J3P9k5WKY1KUr0QlSBPwOnUhTrJCEA&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQLySu3GBx2WZydx1lx2EhszLj50J1F-zVkKwOH6w2T75g&oe=6ABE4091',
        id: '17930633934317872',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/731761169_18272253469293327_5617076425864436769_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=f6T-kflCeT8Q7kNvwEjRT2_&_nc_oc=AdpmeqffIWJexyg8yWSLC91m5-iPDkeRKqSm6U8YhSB7mpqYPDivK6mIanTyhWJkLws&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQLzIVVYbfTS7jXcIMUydWXoSjfmS_q0Nz4SXEIB49CG_Q&oe=6ABE260A',
        id: '18216806557329239',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/730774661_18272253481293327_7637820245642321417_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=101&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=PgiH2duAaj4Q7kNvwENURBJ&_nc_oc=AdqtTrz8tNRu6IGqfPRZ2_pKonbVaLyXYsAQkkw9iacfcb_hmy6vCitMy-mJPooOT5o&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQI2ajt0NQC1Chnjs2vpAEVVJb0D8-jSsO4ttpJ3X6AOJA&oe=6ABE3456',
        id: '18472507318108641',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/730905440_18272253508293327_4594121112735886506_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=P6T9z9J7Wn0Q7kNvwEj2r_l&_nc_oc=AdrswPDX3RuP4l-hQfgU2tMZ4RFgGatgP_hbXNnHT3IAz8p3IFQqJTRvQAZclhDAHJI&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQKiKPhxAIbGHxNnTgr6L24Vu9IOlJmAnfBNhxnbXK5X5g&oe=6ABE36DF',
        id: '17884367217662706',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/731677131_18272253499293327_5247406635120395971_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=-6ke523wXzsQ7kNvwFxdxFk&_nc_oc=AdqfUUCFZiMQea6bNw16mrgu0FzWwa70ymTdXeM-LmN6a2zr27Nxa9bFKg_jaxV9o-Q&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQKdvAJtqe-o8oa_-_wc2gOfhLGAI-Tqyn7s1V1hpfyMOQ&oe=6ABE4019',
        id: '18035021705805527',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/730695301_18272253490293327_6408102831618538136_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=XfGybIox9xMQ7kNvwH-RPup&_nc_oc=AdoozMOMyx7mdhsznaFdApTtWZ72hFH9ZbYpfkTWotk6MV8KQMa5QNrWZLR8RemxoPY&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQKcAGXBpwCJmq4Elvn7Ioyg5U_XSBw0QhfiwBFY54uODQ&oe=6ABE1E5E',
        id: '18139844137559095',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/730880687_18272253526293327_1497068509537903530_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=105&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=KlSYzG6S7q8Q7kNvwFrnnI0&_nc_oc=Adr0zPka-o2uj0Wwznc-3N2mJRpM4Umza8V0E2MOvE4-evuY9ox8Xq6McshxMFpMR9w&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQKkRh8E34BEoVzNG4AMEy2-GErej1OX0a8Ji41nPlQJyw&oe=6ABE3BA5',
        id: '18205859842357333',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/730893325_18272253517293327_4141593970364660107_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=107&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=RkBpTvuG4XMQ7kNvwHUTQzG&_nc_oc=Adp_wQCnzVwwGps4uAcoCo6f3wzHAMrTLfjAD1P8E95aMjWAXG-dSBfojnruEbAv-q4&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQIJKJpWTzY-110owpITF2wL20hd7wN5P0Oh72zObgxS7A&oe=6ABE3A36',
        id: '17872270785626337',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/730856992_18272253535293327_8613094450797702233_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=111&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=QTftdfa8VPMQ7kNvwFHxJi3&_nc_oc=AdrUDJSu15onLoQPS885XtfUba0p_9LOBA7rL1ZM8oSV8sSA6e92u3lanWl7FJ3um28&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQIjc7KTsCrSjXQlDftI7TGjlP_p9X_6im4bgn7FhQdFOA&oe=6ABE3CEB',
        id: '17893460532557597',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/730083612_18272253559293327_785101269591248925_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=D8_8t22eqecQ7kNvwH6M5bC&_nc_oc=AdoDdy3GKV0htWJxf1ef7Hicqi92pCJXIXRCeNmZATU7F0f4jhr8oRU-UDCDgjwotnw&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQLX9PWogrxHoISGjGB7EYnkHL1uK5yrHja1KdbWsso4bg&oe=6ABE321E',
        id: '17934591147289325',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/730811440_18272253574293327_8372527386380473203_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=105&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=fGm9xJHBY8UQ7kNvwF-3FnO&_nc_oc=AdqKA1RNWX-_yy7CSNOcmlX5Cwe8U4103yBx2gDZtbfhsSzB2QHwuGnFzhp0ub1ywEo&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQJ6SDlDrePtgNhrpTCyFanLCjrQ6lR9ZdCyNg6OvxRAtQ&oe=6ABE349B',
        id: '18051187358784848',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/730734632_18272253583293327_5844722797996518216_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=101&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=QfXNCBokDBQQ7kNvwGDXwxZ&_nc_oc=Adp9nrcyBcEi6iDorsx7_959TwhnKFB3I05eC7cV7QPxSjzCoVnsYOfXf7cnvpjkD10&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQJezez7FqHotUC3IHP5zieTrBz32WeNR4TiuLYgZ6T4Ow&oe=6ABE43AF',
        id: '18125272603679886',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-3.cdninstagram.com/v/t51.82787-15/730779057_18272253562293327_3340643280052738603_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=104&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=ZWvigwOQqh0Q7kNvwEhMqh1&_nc_oc=Adq0BJVPqpkcvMh0EMmVNfBHAse3pAVjWBApVIqSw_yFd8SgUs8q_5cNnU0NJ6a7dGg&_nc_zt=23&_nc_ht=scontent-lga3-3.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQJnTfe3Vl-dr8iKWk8UbFItbPCHKK6vfjwTyZL8a-hgtg&oe=6ABE351D',
        id: '18094060481178486',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/730786459_18272253592293327_5175374108759236411_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=107&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=a0tWd8X7txgQ7kNvwEeX3g-&_nc_oc=AdqT7lfhu8HtsfbMm346Y26mXoDyzpijkYNlr1VsW27WAehvXNYtHtCiRuwI6NKWV8Q&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQIhIZyQKDJt8pvoaTdFZqi25y9oktiSrA2O-VCfh-uYfQ&oe=6ABE2610',
        id: '18139856212476995',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/730748537_18272253556293327_3959190955947593701_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=110&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=0LpXNenPN-IQ7kNvwE5eyu_&_nc_oc=Adp62h9FcPRe3iV6-32WagIHr4dNMLn0feDIivuQ3MM6nFK6CDOTNg7o-pJENIatjXQ&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQI0iQU1K2uqXqo91eg6ZrofRaE5R2_gqrAPTZh49C81ng&oe=6ABE2BA7',
        id: '18072037592695016',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/731677120_18272253601293327_2290349100838923458_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=100&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=qaoxIwg6k2QQ7kNvwFeiML0&_nc_oc=AdrxIoSEJpE4ErL351toXj_cIEV0uUHA2_nFWj3V0963MlwLjcJgpRR63-hOrwGOrrQ&_nc_zt=23&_nc_ht=scontent-lga3-2.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=XCiPG-p4jX9NetnQCMNHww&oh=00_AQI3iUHCn2d7fSxe1OOJlb3vhO8pjDoOPObQP7VaqjYswQ&oe=6ABE46D8',
        id: '18107115503077689',
      },
    ],
  },
};

export const MIXED_CAROUSEL: GraphMedia = {
  id: '18342704986217065',
  caption:
    'Our new line of metaglasses is available today. Three shapes, 26 style combos, with our most advanced Meta AI built in. Plus, three custom styles designed by kyliejenner',
  media_type: 'CAROUSEL_ALBUM',
  media_product_type: 'FEED',
  media_url:
    'https://scontent-lga3-3.cdninstagram.com/v/t51.82787-15/729840649_18601431373006808_207411964128414321_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=106&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=2J3AZqJrwhoQ7kNvwEO8RHU&_nc_oc=AdrBRtACqVEXgCZofyIFJQFYgFlXI79wakUXsRL8hg2D2Mq60hbJvUdNUfVHuf5q8Og&_nc_zt=23&_nc_ht=scontent-lga3-3.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&oh=00_AQJqph6vNACYZbdYD0JkVmUKXJSZHscVsgXqkMqVpDjl6Q&oe=6ABE4A06',
  permalink: 'https://www.instagram.com/p/DZ7eUsUEbOs/',
  timestamp: '2026-06-23T12:59:43+0000',
  like_count: 241774,
  comments_count: 7511,
  children: {
    data: [
      {
        media_type: 'VIDEO',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m84/AQPqM2jdQAWSl-N21tkfPURApmWlrrBNe7XNuI-g_liZeH4n3Z5xqQsnRLciNN_c_t5LgKW9MkHAEIVUobbO3ieMjGuOw23hlI5nM_8.mp4?_nc_cat=110&_nc_sid=5e9851&_nc_ht=scontent-lga3-1.cdninstagram.com&_nc_ohc=nb7nYQj1VdkQ7kNvwHgkn5a&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5JTlNUQUdSQU0uQ0FST1VTRUxfSVRFTS5DMy43MjAuZGFzaF9iYXNlbGluZV8xX3YxIiwieHB2X2Fzc2V0X2lkIjoxODYwMTQzMTMwNzAwNjgwOCwiYXNzZXRfYWdlX2RheXMiOjk0LCJ2aV91c2VjYXNlX2lkIjoxMDE0NiwiZHVyYXRpb25fcyI6MjQsInVybGdlbl9zb3VyY2UiOiJ3d3cifQ%3D%3D&ccb=17-1&vs=871871a8e3a52012&_nc_vs=HBksFQIYTGlnX2JhY2tmaWxsX3RpbWVsaW5lX3ZvZC80RTQ3QkMwMkU4MEY2MEYyMUU5RUY1REUyNzQxQkJBQV92aWRlb19kYXNoaW5pdC5tcDQVAALIARIAFQIYUWlnX3hwdl9wbGFjZW1lbnRfcGVybWFuZW50X3YyLzk1NDM3QjYzNTI1RDQxQjhFQjExNzBDOTQ4RkYyRjk2X2F1ZGlvX2Rhc2hpbml0Lm1wNBUCAsgBEgAoABgAGwKIB3VzZV9vaWwBMRJwcm9ncmVzc2l2ZV9yZWNpcGUBMRUAACawzfGV5_mKQhUCKAJDMywXQDgF41P3ztkYEmRhc2hfYmFzZWxpbmVfMV92MREAde4HZcSeAQA&_nc_gid=psidOAUam0a2fzD3Bj5gww&edm=AL-3X8kEAAAA&_nc_zt=28&oh=00_AQKRPPmzjmKzvkM0s_GIQugx1RP-hNB4HaPkRbjFCOVoqg&oe=6ABA5702',
        thumbnail_url:
          'https://scontent-lga3-3.cdninstagram.com/v/t51.82787-15/729840649_18601431373006808_207411964128414321_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=106&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=2J3AZqJrwhoQ7kNvwEO8RHU&_nc_oc=AdrBRtACqVEXgCZofyIFJQFYgFlXI79wakUXsRL8hg2D2Mq60hbJvUdNUfVHuf5q8Og&_nc_zt=23&_nc_ht=scontent-lga3-3.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&_nc_tpa=Q5bMBQJxglbzGcIHOc3bRdIi9kZpIYd1VoPw_h6826JJBjoFhwHIxrqb-ArONcGSd0C83wPPLhGHmTwVGA&oh=00_AQIPaC62QVwrzz1clJ41EZ8lkErY6zm5KeU442sOPiBI2w&oe=6ABE4A06',
        id: '18125365435576949',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/729889679_18603766348058217_1839534881254526813_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=109&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=He9YHfncK8wQ7kNvwF9jqeZ&_nc_oc=Ado7OVfpOSW7Vp80LKc6lbpX_Gvp_zhvFTUkwJbEAs16vOjcR4qFL9iK5GOPGT1nO08&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&oh=00_AQLRa9AVOAVb2jEBMFRsJ53jfSlFXTWD_LsukuMDX-hL3Q&oe=6ABE1AAA',
        id: '17919062685383811',
      },
      {
        media_type: 'VIDEO',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m84/AQM1J6ZgCllR1OCoY2nt4rqArh9mRgnXHTwYbRoh7dEBVfLg-FICGSg81J-l4LgOxsQ-OVrqcCkDIHbVs8-MlcFig7vY_GNfJ5OmMiE.mp4?_nc_cat=109&_nc_sid=5e9851&_nc_ht=scontent-lga3-1.cdninstagram.com&_nc_ohc=XCjH9mLu9fEQ7kNvwGT82GB&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5JTlNUQUdSQU0uQ0FST1VTRUxfSVRFTS5DMy43MjAuZGFzaF9iYXNlbGluZV8xX3YxIiwieHB2X2Fzc2V0X2lkIjoxODYwMzc2NjQ4MzA1ODIxNywiYXNzZXRfYWdlX2RheXMiOjk1LCJ2aV91c2VjYXNlX2lkIjoxMDE0NiwiZHVyYXRpb25fcyI6MjgsInVybGdlbl9zb3VyY2UiOiJ3d3cifQ%3D%3D&ccb=17-1&vs=fb5923f4679d1679&_nc_vs=HBksFQIYTGlnX2JhY2tmaWxsX3RpbWVsaW5lX3ZvZC8zNjQ4RDlGNTJGNEQ1NTg1RjNFOUYxRUYyNTc3MEZCOV92aWRlb19kYXNoaW5pdC5tcDQVAALIARIAFQIYUWlnX3hwdl9wbGFjZW1lbnRfcGVybWFuZW50X3YyLzA0NEJDNEZDQTVDMDBBNjJFMjVDMDlCREQ1QUM0QTk4X2F1ZGlvX2Rhc2hpbml0Lm1wNBUCAsgBEgAoABgAGwKIB3VzZV9vaWwBMRJwcm9ncmVzc2l2ZV9yZWNpcGUBMRUAACbS-KfL3YGMQhUCKAJDMywXQDwQ5WBBiTcYEmRhc2hfYmFzZWxpbmVfMV92MREAde4HZcSeAQA&_nc_gid=psidOAUam0a2fzD3Bj5gww&edm=AL-3X8kEAAAA&_nc_zt=28&oh=00_AQI-HaPKCa26lxgito-VpSiTQggnyvTmmU3uUqKQ1KnMXw&oe=6ABA45C3',
        thumbnail_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/728912224_18603766561058217_8716392807401817367_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=109&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=eb_oDuguDYoQ7kNvwGtppaM&_nc_oc=AdrV5L1dmk-zoIpbDUKdvrkKL3jZ866i9YinDMpJszxSvhByN7X4gOw_oUWsVTuNGsU&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&_nc_tpa=Q5bMBQKeQ0ik1_49hDPZLC7ltWtGzdkfjNRKgxJkN07Id7AKWT7wGqnqwueuGU_dJww4Etkxshd1cIW6BA&oh=00_AQIjO4juilGqJe2Jl_MxzGOaJ6yWIqOyvVEHeFHcJi506Q&oe=6ABE2DE8',
        id: '17932562151335790',
      },
      {
        media_type: 'VIDEO',
        media_url:
          'https://scontent-lga3-3.cdninstagram.com/o1/v/t16/f2/m84/AQPZawd_Vjzgw4jw3he9jyo0UShZ_uB7bsutat_ycUV9ooLhD1N_zirXPF96wTZ_xOj7xBEiJ_dCD5qfYLbICsPzMGI9mDEpP538CZk.mp4?_nc_cat=104&_nc_sid=5e9851&_nc_ht=scontent-lga3-3.cdninstagram.com&_nc_ohc=sSvPXIMRUxMQ7kNvwH4QpZG&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5JTlNUQUdSQU0uQ0FST1VTRUxfSVRFTS5DMy43MjAuZGFzaF9iYXNlbGluZV8xX3YxIiwieHB2X2Fzc2V0X2lkIjoxODYwMzc2NjQxNzA1ODIxNywiYXNzZXRfYWdlX2RheXMiOjk1LCJ2aV91c2VjYXNlX2lkIjoxMDE0NiwiZHVyYXRpb25fcyI6MTAsInVybGdlbl9zb3VyY2UiOiJ3d3cifQ%3D%3D&ccb=17-1&vs=8ab05942d0bad248&_nc_vs=HBksFQIYTGlnX2JhY2tmaWxsX3RpbWVsaW5lX3ZvZC9FRDQyNTEwQkIzMEFCQzUxN0U2RDYwQjc0Q0Y2M0JBNF92aWRlb19kYXNoaW5pdC5tcDQVAALIARIAFQIYUWlnX3hwdl9wbGFjZW1lbnRfcGVybWFuZW50X3YyL0ZCNDFGQUZDMzcxRTFCQkI0MTA2QzJFM0Y4ODFGRUJFX2F1ZGlvX2Rhc2hpbml0Lm1wNBUCAsgBEgAoABgAGwKIB3VzZV9vaWwBMRJwcm9ncmVzc2l2ZV9yZWNpcGUBMRUAACbSpq-M3YGMQhUCKAJDMywXQCQAAAAAAAAYEmRhc2hfYmFzZWxpbmVfMV92MREAde4HZcSeAQA&_nc_gid=psidOAUam0a2fzD3Bj5gww&edm=AL-3X8kEAAAA&_nc_zt=28&oh=00_AQLXLnUnPzBAD6kLkHNln8pND8Sg1LNbXPv7aHWgygjzyw&oe=6ABA2740',
        thumbnail_url:
          'https://scontent-lga3-3.cdninstagram.com/v/t51.82787-15/730040639_18603766471058217_4465817439776527890_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=102&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=eHphOFKiqqkQ7kNvwH7P-72&_nc_oc=AdoxG5S_OQk_hk91O-DaQaKT_99qKkUW3ZZh0TmgHGITKewDMZ2qLxQYoFdMfhXb3g8&_nc_zt=23&_nc_ht=scontent-lga3-3.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&_nc_tpa=Q5bMBQKCgv5q4H2-VeUj7juA-ocwNbkEBUEmxzhZMZJJMsKBVdcsO31puOyDoWC94AXJHf8Dn-bqGzW2lA&oh=00_AQJBQ7q2LL8XActc4apVKwO4R_JUTLyUITtXs4ZLlqYt8A&oe=6ABE20D0',
        id: '18169039765441035',
      },
      {
        media_type: 'VIDEO',
        media_url:
          'https://scontent-lga3-3.cdninstagram.com/o1/v/t16/f2/m84/AQPWNoeBEMtSpqLcXBjscTOnWMZ8HULfrb_Rn6U6KomM6rnOJcNhACqNxTdgiiyswRRBRjYSr4vzF20zXj60c8WbieSTRkU49O-gVR4.mp4?_nc_cat=108&_nc_sid=5e9851&_nc_ht=scontent-lga3-3.cdninstagram.com&_nc_ohc=dlqZ_TAarLIQ7kNvwGpDhN5&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5JTlNUQUdSQU0uQ0FST1VTRUxfSVRFTS5DMy43MjAuZGFzaF9iYXNlbGluZV8xX3YxIiwieHB2X2Fzc2V0X2lkIjoxODYwMzc2NjUwNDA1ODIxNywiYXNzZXRfYWdlX2RheXMiOjk1LCJ2aV91c2VjYXNlX2lkIjoxMDE0NiwiZHVyYXRpb25fcyI6MjQsInVybGdlbl9zb3VyY2UiOiJ3d3cifQ%3D%3D&ccb=17-1&vs=1b980e7174bf8ace&_nc_vs=HBksFQIYTGlnX2JhY2tmaWxsX3RpbWVsaW5lX3ZvZC84QTQyMDA2MzgxNjJEOUJGQjYxRDFEQTdERERGN0Y4MF92aWRlb19kYXNoaW5pdC5tcDQVAALIARIAFQIYUWlnX3hwdl9wbGFjZW1lbnRfcGVybWFuZW50X3YyL0VENDQyRjVGQ0NFQzc0RjMzMDUzNzU0MDE4M0I5OEI2X2F1ZGlvX2Rhc2hpbml0Lm1wNBUCAsgBEgAoABgAGwKIB3VzZV9vaWwBMRJwcm9ncmVzc2l2ZV9yZWNpcGUBMRUAACbStavf3YGMQhUCKAJDMywXQDhdsi0OVgQYEmRhc2hfYmFzZWxpbmVfMV92MREAde4HZcSeAQA&_nc_gid=psidOAUam0a2fzD3Bj5gww&edm=AL-3X8kEAAAA&_nc_zt=28&oh=00_AQJB_EQvvc6QU1qcnxKi1l8sYYU33cwUwDnpBNhPrM0dtg&oe=6ABA46B8',
        thumbnail_url:
          'https://scontent-lga3-3.cdninstagram.com/v/t51.82787-15/730515832_18603766570058217_5943997436865574582_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=104&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=KNL-_H5ISuIQ7kNvwFR5UzV&_nc_oc=AdoyWp1X6c46ycZ6z7166VgvzrghC-k_cxdMYErSmLhvg-ntaq8pYrh2Y4yKkIkCWPg&_nc_zt=23&_nc_ht=scontent-lga3-3.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&_nc_tpa=Q5bMBQKdepfqfc0dmD6eS8XMqzF00og8A_4xQFPNDoxkRP5HW8zkW6qje8v8PHFzSiaQO5r83NcwEhWccg&oh=00_AQIfg8Z0oa7WApXbVaxFNW_udjTGF4MVVrqBnba1uWgO6A&oe=6ABE1B47',
        id: '18184656967394552',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/729692053_18603766330058217_1574826979281985185_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=c7kEzV1cv3IQ7kNvwHyuD3e&_nc_oc=AdobzRRx7zZ_EWYBkS8QNPSsKSvF1FZRAQ4yiiEOmdtzXolX_PzupVfE8bE4Pr31Gak&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&oh=00_AQKo0pXqNubNPe4oAR58S2q7ENFaHjbjAA5cmdCCsu28cA&oe=6ABE51C8',
        id: '18101155163329221',
      },
      {
        media_type: 'VIDEO',
        media_url:
          'https://scontent-lga3-2.cdninstagram.com/o1/v/t16/f2/m84/AQOXUY1kUaM2dyAnHdc3ZNiH7uiBqcRtWHsUbuL_5celtTHHT1VQelFTuLqivBan8wJUOBpRaujGlW-jxuf2_wIDQqEKwLFOiMUp4HA.mp4?_nc_cat=107&_nc_sid=5e9851&_nc_ht=scontent-lga3-2.cdninstagram.com&_nc_ohc=GLUf6trUsCUQ7kNvwHPGnGF&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5JTlNUQUdSQU0uQ0FST1VTRUxfSVRFTS5DMy43MjAuZGFzaF9iYXNlbGluZV8xX3YxIiwieHB2X2Fzc2V0X2lkIjoxODYwMzc2NjYzMzA1ODIxNywiYXNzZXRfYWdlX2RheXMiOjk1LCJ2aV91c2VjYXNlX2lkIjoxMDE0NiwiZHVyYXRpb25fcyI6NTgsInVybGdlbl9zb3VyY2UiOiJ3d3cifQ%3D%3D&ccb=17-1&vs=8680f5043d55d597&_nc_vs=HBksFQIYTGlnX2JhY2tmaWxsX3RpbWVsaW5lX3ZvZC8wQTQ2RDJDNjBCQjkwQUM1MDhDRjBFQkYwNTA2MEVCRF92aWRlb19kYXNoaW5pdC5tcDQVAALIARIAFQIYUWlnX3hwdl9wbGFjZW1lbnRfcGVybWFuZW50X3YyL0U4NDdERjU2RjkwMTJEQUNDOUQyNzBGQ0RERjFCM0EwX2F1ZGlvX2Rhc2hpbml0Lm1wNBUCAsgBEgAoABgAGwKIB3VzZV9vaWwBMRJwcm9ncmVzc2l2ZV9yZWNpcGUBMRUAACbSvq7a3oGMQhUCKAJDMywXQE0mZmZmZmYYEmRhc2hfYmFzZWxpbmVfMV92MREAde4HZcSeAQA&_nc_gid=psidOAUam0a2fzD3Bj5gww&edm=AL-3X8kEAAAA&_nc_zt=28&oh=00_AQKsB8VkJHZ645TEFKlYmHxQ5WgUwmvoAIh-EYYrsw2hEA&oe=6ABA2D91',
        thumbnail_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/730275092_18603766705058217_8561639314885058583_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=103&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=O3pFR37y9b8Q7kNvwHVpiOx&_nc_oc=Adp7WVGupYSzD62rNy5kIXmo7W2faz-V6lYMIuTfPLOr3BnLMa_j9n2qRta3E5c5EOc&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&_nc_tpa=Q5bMBQJdJTg3iQYfghEprp5Jct8-8mcPC6p6Xyp-whSH2WZuXlorfDe2r8plMSwnA57ZMeTR4O3AH-9mHQ&oh=00_AQJ-uwZ7R0qvpCfTcX03KkYvbnTOdWm4EWisEG0Tic46KQ&oe=6ABE23A7',
        id: '18106990808053596',
      },
      {
        media_type: 'IMAGE',
        media_url:
          'https://scontent-lga3-1.cdninstagram.com/v/t51.82787-15/729729264_18603766339058217_1497370481737092471_n.jpg?stp=dst-jpg_e35_tt6&_nc_cat=110&ccb=7-5&_nc_sid=18de74&efg=eyJlZmdfdGFnIjoiQ0FST1VTRUxfSVRFTS5iZXN0X2ltYWdlX3VybGdlbi5DMyJ9&_nc_ohc=jEF_AnLa_8cQ7kNvwGgUWIC&_nc_oc=AdruEvAkYwHxUs_HDEA6LIiFVR8-fcx_uWBTbEJPmOr_KrtGR-XPWaVG426RAYg7204&_nc_zt=23&_nc_ht=scontent-lga3-1.cdninstagram.com&edm=AL-3X8kEAAAA&_nc_gid=psidOAUam0a2fzD3Bj5gww&oh=00_AQLZWqUe3uCwORYzWM8F7blbVIvPCctf-hnS_szkFrhUDQ&oe=6ABE48DB',
        id: '18181853995394283',
      },
    ],
  },
};

/** The real `paging` object a Business Discovery media edge returns (no `next`). */
export const REAL_PAGING = {
  cursors: {
    after:
      'QVFIVFFtaEdMR0Q3UGlzLTlqZA05uVUhZAQmV3NC1vVjdtd19qRHBtWDRFOFVKTldVU3FveXR3cHNOZATN3V0pfYlNNS1pwWjcxTU5WbFlaMWFnVWVodGM3eGl3',
  },
};
