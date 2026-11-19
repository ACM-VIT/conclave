export type LongShotTier = "obvious" | "cliche" | "solid" | "rare" | "longShot" | "pearl";

export type LongShotListTier = Exclude<LongShotTier, "pearl">;

export type LongShotPrompt = {
  category: string;
  prompt: string;
  obvious: string[];
  cliche: string[];
  solid: string[];
  rare: string[];
  longShot: string[];
  pearl: string;
};

export const LONG_SHOT_BANK: LongShotPrompt[] = [
  {
    category: "Food",
    prompt: "Name a fruit",
    obvious: ["Apple", "Banana", "Orange", "Strawberry", "Grape", "Mango", "Watermelon"],
    cliche: ["Durian", "Dragon fruit|Pitaya|Pitahaya", "Star fruit|Carambola", "Jackfruit"],
    solid: ["Pineapple", "Peach", "Pear", "Cherry", "Kiwi|Kiwifruit", "Blueberry", "Lemon", "Lime", "Plum", "Raspberry", "Coconut", "Papaya"],
    rare: ["Pomegranate", "Apricot", "Fig", "Guava", "Lychee|Litchi", "Passion fruit|Passionfruit", "Cantaloupe", "Nectarine", "Cranberry", "Blackberry", "Grapefruit", "Persimmon", "Date", "Tangerine|Mandarin", "Avocado", "Tomato"],
    longShot: ["Rambutan", "Mangosteen", "Quince", "Kumquat", "Feijoa", "Salak|Snake fruit", "Cherimoya|Custard apple", "Loquat", "Soursop|Guanabana", "Physalis|Cape gooseberry", "Ackee", "Longan", "Medlar", "Pawpaw", "Olive", "Breadfruit", "Tamarind"],
    pearl: "Miracle fruit|Miracle berry",
  },
  {
    category: "Geography",
    prompt: "Name a country in Africa",
    obvious: ["Egypt", "Nigeria", "South Africa", "Kenya", "Morocco"],
    cliche: ["Burkina Faso", "Djibouti", "Chad"],
    solid: ["Ethiopia", "Ghana", "Algeria", "Tanzania", "Uganda", "Libya", "Tunisia", "Somalia", "Sudan", "Zimbabwe", "Madagascar", "Senegal"],
    rare: ["Rwanda", "Namibia", "Botswana", "Angola", "Cameroon", "Mali", "Zambia", "Mozambique", "Ivory Coast|Cote d'Ivoire", "Niger", "Congo|Republic of the Congo", "Democratic Republic of the Congo|DRC|DR Congo", "Malawi", "South Sudan"],
    longShot: ["Eswatini|Swaziland", "Lesotho", "Eritrea", "Comoros", "Cape Verde|Cabo Verde", "Equatorial Guinea", "Guinea-Bissau|Guinea Bissau", "Burundi", "Gabon", "Togo", "Benin", "Mauritania", "Seychelles", "Mauritius", "Gambia|The Gambia", "Sierra Leone", "Liberia", "Guinea", "Central African Republic|CAR"],
    pearl: "Sao Tome and Principe|Sao Tome",
  },
  {
    category: "Animals",
    prompt: "Name a dog breed",
    obvious: ["Labrador|Labrador Retriever|Lab", "Golden Retriever", "German Shepherd", "Poodle", "Bulldog", "Chihuahua"],
    cliche: ["Shiba Inu", "Xoloitzcuintli|Xolo", "Basenji"],
    solid: ["Beagle", "Pug", "Husky|Siberian Husky", "Dachshund", "Rottweiler", "Boxer", "Corgi|Welsh Corgi", "Shih Tzu", "Border Collie", "Great Dane", "Dalmatian", "Pomeranian", "Yorkshire Terrier|Yorkie"],
    rare: ["Doberman|Dobermann|Doberman Pinscher", "Greyhound", "Saint Bernard|St Bernard", "Cocker Spaniel", "Akita", "Bernese Mountain Dog", "Whippet", "Maltese", "Samoyed", "Basset Hound", "Bloodhound", "Pit Bull|Pitbull|American Pit Bull Terrier", "Schnauzer", "Weimaraner", "Jack Russell|Jack Russell Terrier"],
    longShot: ["Puli", "Borzoi", "Saluki", "Vizsla", "Leonberger", "Otterhound", "Lagotto Romagnolo", "Bedlington Terrier", "Affenpinscher", "Chinook", "Azawakh", "Kooikerhondje", "Norwegian Lundehund", "Catahoula|Catahoula Leopard Dog", "Plott Hound|Plott"],
    pearl: "Komondor",
  },
  {
    category: "Science",
    prompt: "Name a chemical element",
    obvious: ["Oxygen", "Hydrogen", "Carbon", "Gold", "Iron", "Helium"],
    cliche: ["Ytterbium", "Praseodymium", "Oganesson"],
    solid: ["Nitrogen", "Silver", "Copper", "Sodium", "Calcium", "Lead", "Uranium", "Aluminium|Aluminum", "Zinc", "Neon", "Chlorine", "Potassium"],
    rare: ["Mercury", "Magnesium", "Platinum", "Titanium", "Sulfur|Sulphur", "Phosphorus", "Lithium", "Tin", "Silicon", "Plutonium", "Argon", "Nickel", "Cobalt", "Fluorine", "Iodine", "Radon", "Tungsten"],
    longShot: ["Hafnium", "Rhenium", "Osmium", "Technetium", "Promethium", "Gadolinium", "Lutetium", "Seaborgium", "Tennessine", "Moscovium", "Nihonium", "Thulium", "Holmium", "Samarium", "Europium", "Rubidium", "Scandium", "Tellurium", "Bismuth", "Antimony"],
    pearl: "Dysprosium",
  },
  {
    category: "Music",
    prompt: "Name a musical instrument",
    obvious: ["Guitar", "Piano", "Drums|Drum", "Violin", "Flute", "Trumpet"],
    cliche: ["Theremin", "Didgeridoo", "Kazoo"],
    solid: ["Saxophone|Sax", "Cello", "Bass|Bass guitar", "Clarinet", "Harp", "Ukulele", "Keyboard", "Trombone", "Harmonica", "Tuba", "Banjo", "Xylophone"],
    rare: ["Oboe", "Bassoon", "French horn|Horn", "Viola", "Double bass|Contrabass|Upright bass", "Accordion", "Mandolin", "Tambourine", "Bagpipes|Bagpipe", "Sitar", "Organ", "Triangle", "Piccolo", "Marimba", "Synthesizer|Synth"],
    longShot: ["Glockenspiel", "Celesta", "Bandoneon", "Erhu", "Oud", "Koto", "Shamisen", "Kalimba|Mbira|Thumb piano", "Hang drum|Handpan", "Zither", "Dulcimer", "Sackbut", "Ocarina", "Tabla", "Balalaika", "Bouzouki", "Cajon", "Sousaphone", "Glass harmonica|Armonica", "Duduk", "Shakuhachi"],
    pearl: "Hurdy-gurdy|Hurdy gurdy",
  },
  {
    category: "Space",
    prompt: "Name a planet or moon in our solar system",
    obvious: ["Earth", "Mars", "Jupiter", "Saturn", "The Moon|Moon|Luna"],
    cliche: ["Pluto", "Europa", "Titan"],
    solid: ["Venus", "Mercury", "Neptune", "Uranus"],
    rare: ["Io", "Ganymede", "Callisto", "Phobos", "Deimos", "Enceladus", "Triton", "Charon"],
    longShot: ["Oberon", "Titania", "Ariel", "Umbriel", "Iapetus", "Rhea", "Dione", "Tethys", "Mimas", "Hyperion", "Phoebe", "Amalthea", "Proteus", "Nereid", "Himalia", "Pandora", "Prometheus", "Janus", "Epimetheus", "Metis", "Thebe", "Larissa", "Puck"],
    pearl: "Miranda",
  },
  {
    category: "Food",
    prompt: "Name a kind of cheese",
    obvious: ["Cheddar", "Mozzarella", "Parmesan|Parmigiano Reggiano|Parmigiano", "Swiss"],
    cliche: ["Casu marzu", "Limburger", "Roquefort"],
    solid: ["Brie", "Feta", "Gouda", "Camembert", "Blue cheese|Blue", "Ricotta", "Cream cheese", "Provolone", "Monterey Jack|Jack", "American", "Colby", "Goat cheese|Chevre"],
    rare: ["Gruyere", "Emmental|Emmentaler", "Gorgonzola", "Stilton", "Halloumi", "Manchego", "Mascarpone", "Pecorino|Pecorino Romano", "Havarti", "Edam", "Cottage cheese", "Paneer", "Burrata", "Muenster|Munster", "Pepper Jack"],
    longShot: ["Taleggio", "Raclette", "Comte", "Reblochon", "Wensleydale", "Red Leicester", "Caciocavallo", "Asiago", "Fontina", "Jarlsberg", "Queso Oaxaca|Oaxaca", "Cotija", "Morbier", "Stracchino", "Scamorza", "Labneh", "Mimolette", "Leyden", "Brunost|Gjetost", "Lancashire", "Port Salut"],
    pearl: "Epoisses",
  },
  {
    category: "Animals",
    prompt: "Name a bird",
    obvious: ["Eagle", "Penguin", "Parrot", "Owl", "Pigeon", "Chicken", "Crow"],
    cliche: ["Kiwi", "Dodo", "Cassowary"],
    solid: ["Robin", "Sparrow", "Flamingo", "Duck", "Swan", "Hawk", "Ostrich", "Peacock|Peafowl", "Seagull|Gull", "Hummingbird", "Turkey", "Blue jay|Jay", "Falcon"],
    rare: ["Pelican", "Toucan", "Woodpecker", "Cardinal", "Goose", "Stork", "Heron", "Emu", "Vulture", "Raven", "Magpie", "Kingfisher", "Albatross", "Puffin", "Canary", "Finch", "Starling", "Cockatoo"],
    longShot: ["Hoatzin", "Kakapo", "Lyrebird", "Bowerbird", "Oystercatcher", "Nightjar", "Potoo", "Frigatebird", "Hoopoe", "Bee-eater|Bee eater", "Wryneck", "Dipper", "Kea", "Quetzal", "Tui", "Takahe", "Roadrunner", "Secretary bird", "Ibis", "Spoonbill", "Bittern", "Avocet", "Shrike", "Waxwing"],
    pearl: "Shoebill",
  },
  {
    category: "Tech",
    prompt: "Name a programming language",
    obvious: ["Python", "JavaScript|JS", "Java", "C++|C plus plus|cpp", "C"],
    cliche: ["Brainfuck", "COBOL", "Haskell"],
    solid: ["C#|C sharp|csharp", "TypeScript|TS", "Ruby", "PHP", "Swift", "Go|Golang", "Rust", "Kotlin", "SQL", "HTML"],
    rare: ["Perl", "Scala", "R", "MATLAB", "Lua", "Dart", "Objective-C|Objective C|ObjC", "Assembly|Asm", "Bash|Shell", "Visual Basic|VB|VBA", "Fortran", "Pascal", "Elixir", "Julia", "Groovy"],
    longShot: ["Erlang", "OCaml", "Prolog", "Lisp|Common Lisp", "Clojure", "Scheme", "Racket", "Smalltalk", "Ada", "Zig", "Nim", "Crystal", "Elm", "F#|F sharp", "Forth", "Haxe", "Solidity", "Simula", "ALGOL", "BASIC", "Delphi", "Raku", "Gleam", "Odin", "Idris", "Agda", "Coq|Rocq"],
    pearl: "APL",
  },
  {
    category: "Games",
    prompt: "Name a board game",
    obvious: ["Monopoly", "Chess", "Scrabble", "Checkers|Draughts", "Clue|Cluedo"],
    cliche: ["Go", "Mancala", "Senet"],
    solid: ["Risk", "Catan|Settlers of Catan", "Battleship", "Connect Four|Connect 4", "Snakes and Ladders|Chutes and Ladders", "Trivial Pursuit", "Operation", "Candy Land|Candyland", "Guess Who", "Backgammon", "Sorry", "Game of Life|The Game of Life|Life"],
    rare: ["Ticket to Ride", "Pandemic", "Mahjong", "Stratego", "Othello|Reversi", "Carcassonne", "Ludo", "Pictionary", "Mouse Trap", "Jenga", "Codenames", "Dominoes", "Chinese Checkers", "Yahtzee"],
    longShot: ["Azul", "Wingspan", "Gloomhaven", "Terraforming Mars", "Agricola", "Puerto Rico", "Twilight Struggle", "Dominion", "Splendor", "Diplomacy", "Hive", "Blokus", "Tsuro", "Power Grid", "Brass", "Root", "Spirit Island", "Arkham Horror", "Small World", "Patchwork", "Shogi", "Xiangqi", "Nine Men's Morris|Nine Mens Morris", "Crokinole", "Kingdomino"],
    pearl: "Hnefatafl",
  },
  {
    category: "Mythology",
    prompt: "Name a Greek god, goddess or Titan",
    obvious: ["Zeus", "Poseidon", "Hades", "Athena", "Aphrodite"],
    cliche: ["Nyx", "Chaos", "Nemesis"],
    solid: ["Apollo", "Ares", "Hermes", "Hera", "Artemis", "Demeter", "Dionysus", "Hephaestus", "Kronos|Cronus"],
    rare: ["Persephone", "Hestia", "Eros", "Nike", "Gaia|Gaea", "Atlas", "Prometheus", "Hecate|Hekate", "Pan", "Helios", "Selene", "Eos", "Rhea", "Uranus|Ouranos", "Hypnos", "Thanatos"],
    longShot: ["Mnemosyne", "Tyche", "Hyperion", "Themis", "Oceanus", "Tethys", "Iapetus", "Coeus", "Crius", "Theia", "Phoebe", "Erebus", "Eris", "Asclepius", "Hebe", "Iris", "Morpheus", "Nereus", "Triton", "Boreas", "Zephyrus", "Aeolus", "Metis", "Styx", "Chronos"],
    pearl: "Ananke",
  },
  {
    category: "Geography",
    prompt: "Name a European capital city",
    obvious: ["London", "Paris", "Rome", "Berlin", "Madrid"],
    cliche: ["Reykjavik", "Vaduz", "Valletta"],
    solid: ["Amsterdam", "Lisbon", "Dublin", "Athens", "Vienna", "Brussels", "Moscow", "Stockholm", "Oslo", "Copenhagen", "Prague", "Warsaw"],
    rare: ["Budapest", "Helsinki", "Edinburgh", "Bern", "Kyiv|Kiev", "Bucharest", "Belgrade", "Zagreb", "Sofia", "Cardiff", "Bratislava", "Monaco"],
    longShot: ["Ljubljana", "Tallinn", "Riga", "Vilnius", "Chisinau", "Minsk", "Tirana", "Skopje", "Podgorica", "Sarajevo", "San Marino", "Luxembourg", "Nicosia", "Pristina", "Tbilisi", "Yerevan", "Baku", "Belfast", "Vatican City"],
    pearl: "Andorra la Vella",
  },
  {
    category: "Nature",
    prompt: "Name a gemstone",
    obvious: ["Diamond", "Ruby", "Emerald", "Sapphire"],
    cliche: ["Tanzanite", "Alexandrite", "Moonstone"],
    solid: ["Amethyst", "Pearl", "Opal", "Topaz", "Jade", "Garnet", "Turquoise", "Aquamarine"],
    rare: ["Onyx", "Quartz|Rose quartz", "Peridot", "Citrine", "Amber", "Lapis lazuli|Lapis", "Tourmaline", "Jasper", "Agate", "Obsidian", "Malachite"],
    longShot: ["Tsavorite", "Spinel", "Zircon", "Kunzite", "Morganite", "Iolite", "Beryl", "Chrysoberyl", "Sunstone", "Labradorite", "Rhodochrosite", "Sodalite", "Benitoite", "Taaffeite", "Jet", "Carnelian", "Bloodstone|Heliotrope", "Hematite", "Kyanite", "Chrysoprase", "Larimar", "Sugilite"],
    pearl: "Painite",
  },
  {
    category: "Food",
    prompt: "Name a vegetable",
    obvious: ["Carrot", "Broccoli", "Potato", "Tomato", "Lettuce", "Onion", "Cucumber"],
    cliche: ["Kohlrabi", "Romanesco", "Jicama"],
    solid: ["Spinach", "Corn", "Peas|Pea", "Pepper|Bell pepper", "Cabbage", "Cauliflower", "Celery", "Garlic", "Mushroom", "Zucchini|Courgette", "Green beans|Green bean", "Sweet potato"],
    rare: ["Eggplant|Aubergine", "Asparagus", "Kale", "Brussels sprouts|Brussels sprout", "Beetroot|Beet", "Radish", "Leek", "Artichoke", "Squash|Butternut squash", "Pumpkin", "Turnip", "Okra", "Parsnip", "Bok choy|Pak choi", "Arugula|Rocket"],
    longShot: ["Celeriac", "Fennel", "Rutabaga|Swede", "Chayote", "Daikon", "Taro", "Cassava|Yuca", "Burdock", "Sunchoke|Jerusalem artichoke", "Endive", "Radicchio", "Watercress", "Samphire", "Fiddlehead|Fiddleheads", "Lotus root", "Bitter melon|Bitter gourd", "Cardoon", "Mizuna", "Tomatillo", "Chard|Swiss chard"],
    pearl: "Salsify",
  },
  {
    category: "Sport",
    prompt: "Name a sport played with a ball",
    obvious: ["Soccer|Football", "Basketball", "Tennis", "Baseball", "Golf", "Volleyball"],
    cliche: ["Sepak takraw", "Jai alai|Pelota", "Lacrosse"],
    solid: ["American football", "Rugby", "Cricket", "Hockey|Field hockey", "Table tennis|Ping pong", "Bowling", "Handball", "Softball", "Water polo"],
    rare: ["Squash", "Polo", "Dodgeball", "Netball", "Racquetball", "Billiards|Pool|Snooker", "Croquet", "Kickball", "Pickleball", "Bocce", "Futsal", "Beach volleyball"],
    longShot: ["Hurling", "Gaelic football", "Korfball", "Bandy", "Shinty", "Pesapallo", "Rounders", "Goalball", "Petanque|Boules", "Fistball", "Teqball", "Footvolley", "Camogie", "Underwater rugby", "Cuju", "Tchoukball", "Padel", "Kemari"],
    pearl: "Bossaball",
  },
  {
    category: "Colours",
    prompt: "Name a colour",
    obvious: ["Red", "Blue", "Green", "Yellow", "Black", "White", "Purple"],
    cliche: ["Chartreuse", "Puce", "Vermilion"],
    solid: ["Orange", "Pink", "Brown", "Grey|Gray", "Gold", "Silver", "Navy", "Teal", "Turquoise"],
    rare: ["Magenta", "Cyan", "Maroon", "Beige", "Lavender", "Violet", "Indigo", "Crimson", "Coral", "Olive", "Burgundy", "Mint", "Ivory", "Lime", "Peach", "Tan"],
    longShot: ["Cerulean", "Mauve", "Ochre", "Sienna", "Umber", "Taupe", "Celadon", "Fuchsia", "Periwinkle", "Aubergine", "Viridian", "Cobalt", "Ultramarine", "Saffron", "Sepia", "Amaranth", "Cinnabar", "Heliotrope", "Wenge", "Glaucous", "Smaragdine", "Xanadu"],
    pearl: "Gamboge",
  },
];

export const LONG_SHOT_TIER_POINTS: Record<LongShotTier, number> = {
  obvious: 100,
  cliche: 150,
  solid: 300,
  rare: 600,
  longShot: 850,
  pearl: 1000,
};

export const LONG_SHOT_TIERS: LongShotTier[] = ["obvious", "cliche", "solid", "rare", "longShot", "pearl"];

export const LONG_SHOT_LIST_TIERS: LongShotListTier[] = ["obvious", "cliche", "solid", "rare", "longShot"];

const LEADING_ARTICLE = /^(the|a|an)\s+/;

export const normalizeAnswer = (raw: string): string => {
  let text = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/\+\+/g, " plusplus ")
    .replace(/#/g, " sharp ")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(LEADING_ARTICLE, "");
  if (text.length > 4 && text.endsWith("ies")) text = `${text.slice(0, -3)}y`;
  else if (text.length > 4 && /(sh|ch|x|ss)es$/.test(text)) text = text.slice(0, -2);
  else if (text.length > 3 && text.endsWith("s") && !text.endsWith("ss") && !text.endsWith("us")) {
    text = text.slice(0, -1);
  }
  return text;
};

const editDistance = (a: string, b: string, cap: number): number => {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2][j - 2] + 1);
      }
      d[i][j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length][b.length];
};

const typoAllowance = (length: number): number => (length >= 9 ? 2 : length >= 5 ? 1 : 0);

export type CompiledAnswer = {
  id: string;
  display: string;
  tier: LongShotTier;
  keys: string[];
  judged?: boolean;
};

export type CompiledPrompt = {
  category: string;
  prompt: string;
  answers: CompiledAnswer[];
};

export const compilePrompt = (raw: LongShotPrompt): CompiledPrompt => {
  const answers: CompiledAnswer[] = [];
  const seenKeys = new Set<string>();
  const lists: [LongShotTier, string[]][] = [
    ["pearl", raw.pearl ? [raw.pearl] : []],
    ...LONG_SHOT_LIST_TIERS.map((tier): [LongShotTier, string[]] => [tier, raw[tier] ?? []]),
  ];
  for (const [tier, entries] of lists) {
    for (const entry of entries) {
      const names = entry
        .split("|")
        .map((name) => name.trim())
        .filter(Boolean);
      if (names.length === 0) continue;
      const keys = names.map(normalizeAnswer).filter((key) => key && !seenKeys.has(key));
      if (keys.length === 0) continue;
      for (const key of keys) seenKeys.add(key);
      answers.push({ id: keys[0], display: names[0], tier, keys });
    }
  }
  return { category: raw.category, prompt: raw.prompt, answers };
};

export const matchAnswer = (
  prompt: CompiledPrompt,
  guess: string,
): CompiledAnswer | null => {
  const key = normalizeAnswer(guess);
  if (!key) return null;
  for (const answer of prompt.answers) {
    if (answer.keys.includes(key)) return answer;
  }
  const allowance = typoAllowance(key.length);
  if (allowance === 0) return null;
  let best: CompiledAnswer | null = null;
  let bestDistance = allowance + 1;
  for (const answer of prompt.answers) {
    for (const candidate of answer.keys) {
      if (typoAllowance(candidate.length) === 0) continue;
      const distance = editDistance(key, candidate, allowance);
      if (distance < bestDistance) {
        best = answer;
        bestDistance = distance;
      }
    }
  }
  return best;
};
