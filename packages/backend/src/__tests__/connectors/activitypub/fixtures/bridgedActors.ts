/**
 * REAL bridged actors, captured from production on 2026-08-02.
 *
 * Each record is a `NetworkIdentityCandidate` built from the actor row Mention's
 * ingest pipeline actually stored — the sanitized profile fields and the
 * plain-text bio, not the raw ActivityPub document — because that is precisely
 * what a derivation rule is handed at runtime. Capturing the raw document instead
 * would test the rule against an input it never sees.
 *
 * These exist so that no bridge entry can be written from memory. A rule invented
 * from a half-remembered profile shape mislabels a whole domain confidently, and
 * the only thing that catches it is a real actor asserting otherwise. If a bridge
 * changes its layout these fixtures go stale and the round-trip test fails, which
 * is the intended alarm: the entry needs re-verifying against the live actor, not
 * a looser pattern.
 *
 * They live beside Mention's bridge ENTRIES rather than in the shared package:
 * each one asserts that a specific domain mirrors a specific network, which is
 * the reviewed judgement this app makes and answers for, not a protocol fact.
 *
 * Do not hand-edit. Re-capture from production if a bridge changes shape.
 */

import type { NetworkIdentityCandidate } from '@oxyhq/federation';

export const BRIDGED_ACTOR_FIXTURES: readonly NetworkIdentityCandidate[] = [
  {
    "host": "bird.makeup",
    "acct": "typecache@bird.makeup",
    "preferredUsername": "typecache",
    "actorUri": "https://bird.makeup/users/typecache",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "Location",
        "value": "Tokyo, Japan"
      },
      {
        "name": "Official",
        "value": "<a href=\"https://twitter.com/typecache\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>twitter.com/typecache</span></a>"
      },
      {
        "name": "Support this service",
        "value": "<a href=\"https://www.patreon.com/birddotmakeup\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.patreon.com/birddotmakeup</span></a>"
      }
    ],
    "bio": "TypeCache is an online index for type foundries, sellers, and showcases their collections of type. We’ll keep posting new font releases, font lists & sale info.\nThis account is a replica from Twitter. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon."
  },
  {
    "host": "bird.makeup",
    "acct": "gorskon@bird.makeup",
    "preferredUsername": "gorskon",
    "actorUri": "https://bird.makeup/users/gorskon",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "Location",
        "value": "Detroit, Michigan, USA"
      },
      {
        "name": "Official",
        "value": "<a href=\"https://twitter.com/gorskon\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>twitter.com/gorskon</span></a>"
      },
      {
        "name": "Support this service",
        "value": "<a href=\"https://www.patreon.com/birddotmakeup\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.patreon.com/birddotmakeup</span></a>"
      }
    ],
    "bio": "Surgeon/scientist promoting science-based medicine and deconstructing quackery. Editor, Science-Based Medicine blog. Also: @gorskon.bsky.social. (He/him.)\nThis account is a replica from Twitter. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon."
  },
  {
    "host": "bird.makeup",
    "acct": "giswqs@bird.makeup",
    "preferredUsername": "giswqs",
    "actorUri": "https://bird.makeup/users/giswqs",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "Location",
        "value": "Knoxville, Tennessee, USA"
      },
      {
        "name": "Official",
        "value": "<a href=\"https://twitter.com/giswqs\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>twitter.com/giswqs</span></a>"
      },
      {
        "name": "Support this service",
        "value": "<a href=\"https://www.patreon.com/birddotmakeup\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.patreon.com/birddotmakeup</span></a>"
      },
      {
        "name": "⁂",
        "value": "<span><a href=\"https://fosstodon.org/users/giswqs\">@<span>giswqs@fosstodon.org</span></a></span>"
      }
    ],
    "bio": "Associate Professor @utkgeography | @amazon Scholar | Talk about #opensource #geospatial #dataviz #GeoAI\nThis account is a replica from Twitter. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon."
  },
  {
    "host": "kilogram.makeup",
    "acct": "robert.habeck@kilogram.makeup",
    "preferredUsername": "robert.habeck",
    "actorUri": "https://kilogram.makeup/users/robert.habeck",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "🔗",
        "value": "https://linktr.ee/roberthabeck"
      },
      {
        "name": "Official",
        "value": "<a href=\"https://www.instagram.com/robert.habeck\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.instagram.com/robert.habeck</span></a>"
      },
      {
        "name": "Support this service",
        "value": "<a href=\"https://www.patreon.com/birddotmakeup\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.patreon.com/birddotmakeup</span></a>"
      },
      {
        "name": "Twitter",
        "value": "<span><a href=\"https://bird.makeup/users/roberthabeck\">@<span>roberthabeck@bird.makeup</span></a></span>"
      }
    ],
    "bio": "„There is a crack in everything. That's how the light gets in.“ ~ Leonard Cohen\nThis account is a replica from Instagram. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon."
  },
  {
    "host": "kilogram.makeup",
    "acct": "umwelthilfe@kilogram.makeup",
    "preferredUsername": "umwelthilfe",
    "actorUri": "https://kilogram.makeup/users/umwelthilfe",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "🔗",
        "value": "https://www.duh.de/engagementpreis-druckmachen/?wc=IG"
      },
      {
        "name": "Official",
        "value": "<a href=\"https://www.instagram.com/umwelthilfe\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.instagram.com/umwelthilfe</span></a>"
      },
      {
        "name": "Support this service",
        "value": "<a href=\"https://www.patreon.com/birddotmakeup\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.patreon.com/birddotmakeup</span></a>"
      },
      {
        "name": "Twitter",
        "value": "<span><a href=\"https://bird.makeup/users/umwelthilfe\">@<span>umwelthilfe@bird.makeup</span></a></span>"
      }
    ],
    "bio": "Lass uns gemeinsam für Umwelt, Klima und Natur kämpfen. Dafür machen wir uns stark. Unterstütze uns dabei! 💚🌍\nThis account is a replica from Instagram. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon."
  },
  {
    "host": "kilogram.makeup",
    "acct": "plex@kilogram.makeup",
    "preferredUsername": "plex",
    "actorUri": "https://kilogram.makeup/users/plex",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "🔗",
        "value": "http://youtube.com/@YoSoyPlex"
      },
      {
        "name": "Official",
        "value": "<a href=\"https://www.instagram.com/plex\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.instagram.com/plex</span></a>"
      },
      {
        "name": "Support this service",
        "value": "<a href=\"https://www.patreon.com/birddotmakeup\" rel=\"me nofollow noopener noreferrer\"><span>https://</span><span>www.patreon.com/birddotmakeup</span></a>"
      }
    ],
    "bio": "💬\nThis account is a replica from Instagram. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon."
  },
  {
    "host": "mastox.eu",
    "acct": "mehdirhasan@mastox.eu",
    "preferredUsername": "mehdirhasan",
    "actorUri": "https://mastox.eu/ap/users/116193264000459783",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "Website",
        "value": "<a href=\"http://zeteo.com\" rel=\"nofollow noopener me\"><span>http://</span><span>zeteo.com</span><span></span></a>"
      }
    ],
    "bio": "British-American journalist. Editor-in-chief and CEO of new media company @zeteo_news. Subscribe here: https://t.co/sEC1ETzeiV.\n\n(bot from x to mastodon managed by mastox.eu, contact @admin for any information)"
  },
  {
    "host": "mastox.eu",
    "acct": "franceskalbs@mastox.eu",
    "preferredUsername": "FranceskAlbs",
    "actorUri": "https://mastox.eu/users/FranceskAlbs",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "Website",
        "value": "<a href=\"http://www.ohchr.org/en/special-procedures/sr-palestine\" rel=\"nofollow noopener me\"><span>http://www.</span><span>ohchr.org/en/special-procedure</span><span>s/sr-palestine</span></a>"
      }
    ],
    "bio": "Int'l Lawyer | Scholar | Former UN Official | Sen.Adviser @ARDD @ar_renaissance\n\n#Ahimsa: non-violence toward all beings.\n\n(bot from x to mastodon managed by mastox.eu, contact @admin for any information)"
  },
  {
    "host": "mastox.eu",
    "acct": "gbsumudflotilla@mastox.eu",
    "preferredUsername": "gbsumudflotilla",
    "actorUri": "https://mastox.eu/users/gbsumudflotilla",
    "actorType": "Service",
    "alsoKnownAs": [],
    "fields": [
      {
        "name": "Website",
        "value": "<a href=\"https://linktr.ee/globalsumudflotilla\" rel=\"nofollow noopener me\"><span>https://</span><span>linktr.ee/globalsumudflotilla</span><span></span></a>"
      }
    ],
    "bio": "The World’s Biggest Maritime Mission to Break the Illegal Israeli Siege on Gaza. This is our only official account. Registrations open ↓\n\n(bot from x to mastodon managed by mastox.eu, contact @admin for any information)"
  },
  {
    "host": "bsky.brid.gy",
    "acct": "thistleandmoss.com@bsky.brid.gy",
    "preferredUsername": "thistleandmoss.com",
    "actorUri": "https://bsky.brid.gy/ap/did:plc:m4jmanw3astpwhqp54g6yslu",
    "actorType": "Person",
    "alsoKnownAs": [
      "did:plc:m4jmanw3astpwhqp54g6yslu"
    ],
    "fields": [
      {
        "name": "Web site",
        "value": "<a rel=\"me\" href=\"https://bsky.app/profile/thistleandmoss.com\"><span>https://</span>bsky.app/profile/thistleandmoss.com</a>"
      },
      {
        "name": "Link",
        "value": "<a rel=\"me\" href=\"https://thistleandmoss.com\"><span>https://</span>thistleandmoss.com</a>"
      }
    ],
    "bio": "Trans woman, Druid priestess, polyam queer kin 🌾\nTending a hearth for the burned-out and the becoming. Earth magic, queer joy, dispatches from the edges.\n📜 http://thistleandmoss.com\n#Trans #LGBTQIA #Pagan #Druid #Witch #Polyam #Progressive\n\n🌉 https://fed.brid.gy/bsky/thistleandmoss.com from 🦋 https://bsky.app/profile/thistleandmoss.com, follow https://bsky.brid.gy/bsky.brid.gy to interact"
  },
  {
    "host": "bsky.brid.gy",
    "acct": "georgemonbiot.bsky.social@bsky.brid.gy",
    "preferredUsername": "georgemonbiot.bsky.social",
    "actorUri": "https://bsky.brid.gy/ap/did:plc:codfx2epdduamfycuyi5fjpb",
    "actorType": "Person",
    "alsoKnownAs": [
      "did:plc:codfx2epdduamfycuyi5fjpb"
    ],
    "fields": [
      {
        "name": "Web site",
        "value": "<a rel=\"me\" href=\"https://bsky.app/profile/georgemonbiot.bsky.social\"><span>https://</span>bsky.app/profile/georgemonbiot.bsky.social</a>"
      }
    ],
    "bio": "Ungainly on land\n\n🌉 https://fed.brid.gy/bsky/georgemonbiot.bsky.social from 🦋 https://bsky.app/profile/georgemonbiot.bsky.social, follow @bsky.brid.gy to interact"
  },
  {
    "host": "bsky.brid.gy",
    "acct": "assignedmale.bsky.social@bsky.brid.gy",
    "preferredUsername": "assignedmale.bsky.social",
    "actorUri": "https://bsky.brid.gy/ap/did:plc:vcmpg73bt2wudku3nqgx33yx",
    "actorType": "Person",
    "alsoKnownAs": [
      "did:plc:vcmpg73bt2wudku3nqgx33yx"
    ],
    "fields": [
      {
        "name": "Web site",
        "value": "<a rel=\"me\" href=\"https://bsky.app/profile/assignedmale.bsky.social\"><span>https://</span>bsky.app/profile/assignedmale.bsky.social</a>"
      },
      {
        "name": "Link",
        "value": "<a rel=\"me\" href=\"http://www.patreon.com/assignedmale\"><span>http://</span>www.patreon.com/assignedmale</a>"
      },
      {
        "name": "Link",
        "value": "<a rel=\"me\" href=\"http://www.ko-fi.com/sophielabelle\"><span>http://</span>www.ko-fi.com/sophielabelle</a>"
      }
    ],
    "bio": "The first openly French-Canadian author to be banned in Texas. 🏳️‍⚧️\n\nPatreon : http://www.patreon.com/assignedmale\nTipjar : http://www.ko-fi.com/sophielabelle\n\n🌉 https://fed.brid.gy/bsky/assignedmale.bsky.social from 🦋 https://bsky.app/profile/assignedmale.bsky.social, follow @bsky.brid.gy to interact"
  }
];
