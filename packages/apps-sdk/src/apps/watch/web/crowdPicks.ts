import type { WatchSearchResult } from "./youtubeMeta";

// Evergreen, embeddable crowd pleasers for when trending has nothing to offer
// (no API key on the server, or a hiccup). Thumbnails come from the keyless
// ytimg CDN, so this whole shelf works with zero YouTube configuration.
// Rows are [videoId, title, channel].
const PICK_ROWS: [string, string, string][] = [
  ["jNQXAC9IVRw", "Me at the zoo", "jawed"],
  ["dQw4w9WgXcQ", "Rick Astley - Never Gonna Give You Up", "Rick Astley"],
  ["9bZkp7q19f0", "PSY - GANGNAM STYLE", "officialpsy"],
  ["kJQP7kiw5Fk", "Luis Fonsi - Despacito ft. Daddy Yankee", "Luis Fonsi"],
  ["OPf0YbXqDm0", "Mark Ronson - Uptown Funk ft. Bruno Mars", "Mark Ronson"],
  ["4NRXx6U8ABQ", "The Weeknd - Blinding Lights", "The Weeknd"],
  ["JGwWNGJdvx8", "Ed Sheeran - Shape of You", "Ed Sheeran"],
  ["RgKAFK5djSk", "Wiz Khalifa - See You Again ft. Charlie Puth", "Wiz Khalifa"],
  ["fJ9rUzIMcZQ", "Queen - Bohemian Rhapsody", "Queen Official"],
  ["djV11Xbc914", "a-ha - Take On Me", "a-ha"],
  ["FTQbiNvZqaY", "Toto - Africa", "Toto"],
  ["hTWKbfoikeg", "Nirvana - Smells Like Teen Spirit", "Nirvana"],
  ["1w7OgIMMRc4", "Guns N' Roses - Sweet Child O' Mine", "Guns N' Roses"],
  ["btPJPFnesV4", "Survivor - Eye of the Tiger", "Survivor"],
  ["Gs069dndIYk", "Earth, Wind & Fire - September", "Earth, Wind & Fire"],
  ["ZbZSe6N_BXs", "Pharrell Williams - Happy", "Pharrell Williams"],
  ["8UVNT4wvIGY", "Gotye - Somebody That I Used to Know", "Gotye"],
  ["L_jWHffIx5E", "Smash Mouth - All Star", "Smash Mouth"],
  ["dTAAsCNK7RA", "OK Go - Here It Goes Again", "OK Go"],
  ["xuCn8ux2gbs", "history of the entire world, i guess", "bill wurtz"],
  ["dMH0bHeiRNg", "Evolution of Dance", "Judson Laipply"],
  ["jofNR_WkoCE", "Ylvis - The Fox (What Does The Fox Say?)", "TVNorge"],
  ["h6fcK_fRYaI", "The Egg - A Short Story", "Kurzgesagt"],
  ["Ks-_Mh1QhMc", "Your body language may shape who you are | Amy Cuddy", "TED"],
  ["aqz-KE-bpKQ", "Big Buck Bunny", "Blender"],
  ["LXb3EKWsInQ", "Costa Rica in 4K 60fps HDR (ULTRA HD)", "Jacob + Katie Schwarz"],
  ["YQHsXMglC9A", "Adele - Hello", "Adele"],
  ["rYEDA3JcQqw", "Adele - Rolling in the Deep", "Adele"],
  ["IcrbM1l_BoI", "Avicii - Wake Me Up", "Avicii"],
  ["YqeW9_5kURI", "Major Lazer & DJ Snake - Lean On ft. MO", "Major Lazer"],
  ["2vjPBrBU-TM", "Sia - Chandelier", "Sia"],
  ["PVjiKRfKpPI", "Hozier - Take Me To Church", "Hozier"],
  ["RBumgq5yVrA", "Passenger - Let Her Go", "Passenger"],
  ["_Yhyp-_hX2s", "Eminem - Lose Yourself", "Eminem"],
  ["VYOjWnS4cMY", "Childish Gambino - This Is America", "Donald Glover"],
  ["DyDfgMOUjCI", "Billie Eilish - bad guy", "Billie Eilish"],
  ["HyHNuVaZJ-k", "Gorillaz - Feel Good Inc.", "Gorillaz"],
  ["3JWTaaS7LdU", "Whitney Houston - I Will Always Love You", "Whitney Houston"],
  ["1k8craCGpgs", "Journey - Don't Stop Believin'", "Journey"],
  ["lDK9QqIzhwk", "Bon Jovi - Livin' On A Prayer", "Bon Jovi"],
];

export const CROWD_PICKS: WatchSearchResult[] = PICK_ROWS.map(
  ([videoId, title, channel]) => ({
    videoId,
    title,
    channel,
    thumbnail: null,
    durationSeconds: null,
    views: null,
    publishedAt: null,
  }),
);
