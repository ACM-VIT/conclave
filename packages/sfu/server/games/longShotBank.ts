export type LongShotTier = "obvious" | "solid" | "rare" | "longShot";

export type LongShotPrompt = {
  category: string;
  prompt: string;
  obvious: string[];
  solid: string[];
  rare: string[];
  longShot: string[];
};

export const LONG_SHOT_BANK: LongShotPrompt[] = [
  {
    category: "Food",
    prompt: "Name a fruit",
    obvious: ["Apple", "Banana", "Orange", "Strawberry", "Grape", "Mango", "Watermelon"],
    solid: ["Pineapple", "Peach", "Pear", "Cherry", "Kiwi|Kiwifruit", "Blueberry", "Lemon", "Lime", "Plum", "Raspberry", "Coconut", "Papaya"],
    rare: ["Pomegranate", "Apricot", "Fig", "Guava", "Lychee|Litchi", "Passion fruit|Passionfruit", "Cantaloupe", "Nectarine", "Cranberry", "Blackberry", "Grapefruit", "Persimmon", "Date", "Tangerine|Mandarin", "Avocado", "Tomato"],
    longShot: ["Durian", "Rambutan", "Mangosteen", "Jackfruit", "Quince", "Kumquat", "Feijoa", "Salak|Snake fruit", "Cherimoya|Custard apple", "Loquat", "Soursop|Guanabana", "Physalis|Cape gooseberry", "Ackee", "Longan", "Medlar", "Pawpaw", "Olive", "Breadfruit", "Tamarind", "Dragon fruit|Pitaya|Pitahaya", "Star fruit|Carambola"],
  },
  {
    category: "Geography",
    prompt: "Name a country in Africa",
    obvious: ["Egypt", "Nigeria", "South Africa", "Kenya", "Morocco"],
    solid: ["Ethiopia", "Ghana", "Algeria", "Tanzania", "Uganda", "Libya", "Tunisia", "Somalia", "Sudan", "Zimbabwe", "Madagascar", "Senegal"],
    rare: ["Rwanda", "Namibia", "Botswana", "Angola", "Cameroon", "Mali", "Zambia", "Mozambique", "Ivory Coast|Cote d'Ivoire", "Niger", "Chad", "Congo|Republic of the Congo", "Democratic Republic of the Congo|DRC|DR Congo", "Malawi", "South Sudan"],
    longShot: ["Eswatini|Swaziland", "Lesotho", "Djibouti", "Eritrea", "Comoros", "Sao Tome and Principe|Sao Tome", "Cape Verde|Cabo Verde", "Equatorial Guinea", "Guinea-Bissau|Guinea Bissau", "Burundi", "Gabon", "Togo", "Benin", "Burkina Faso", "Mauritania", "Seychelles", "Mauritius", "Gambia|The Gambia", "Sierra Leone", "Liberia", "Guinea", "Central African Republic|CAR"],
  },
  {
    category: "Animals",
    prompt: "Name a dog breed",
    obvious: ["Labrador|Labrador Retriever|Lab", "Golden Retriever", "German Shepherd", "Poodle", "Bulldog", "Chihuahua"],
    solid: ["Beagle", "Pug", "Husky|Siberian Husky", "Dachshund", "Rottweiler", "Boxer", "Corgi|Welsh Corgi", "Shih Tzu", "Border Collie", "Great Dane", "Dalmatian", "Pomeranian", "Yorkshire Terrier|Yorkie"],
    rare: ["Doberman|Dobermann|Doberman Pinscher", "Greyhound", "Saint Bernard|St Bernard", "Cocker Spaniel", "Shiba Inu", "Akita", "Bernese Mountain Dog", "Whippet", "Maltese", "Samoyed", "Basset Hound", "Bloodhound", "Pit Bull|Pitbull|American Pit Bull Terrier", "Schnauzer", "Weimaraner", "Jack Russell|Jack Russell Terrier"],
    longShot: ["Xoloitzcuintli|Xolo", "Basenji", "Komondor", "Puli", "Borzoi", "Saluki", "Vizsla", "Leonberger", "Otterhound", "Lagotto Romagnolo", "Bedlington Terrier", "Affenpinscher", "Chinook", "Azawakh", "Kooikerhondje", "Norwegian Lundehund", "Catahoula|Catahoula Leopard Dog", "Plott Hound|Plott"],
  },
  {
    category: "Science",
    prompt: "Name a chemical element",
    obvious: ["Oxygen", "Hydrogen", "Carbon", "Gold", "Iron", "Helium"],
    solid: ["Nitrogen", "Silver", "Copper", "Sodium", "Calcium", "Lead", "Uranium", "Aluminium|Aluminum", "Zinc", "Neon", "Chlorine", "Potassium"],
    rare: ["Mercury", "Magnesium", "Platinum", "Titanium", "Sulfur|Sulphur", "Phosphorus", "Lithium", "Tin", "Silicon", "Plutonium", "Argon", "Nickel", "Cobalt", "Fluorine", "Iodine", "Radon", "Tungsten"],
    longShot: ["Praseodymium", "Ytterbium", "Dysprosium", "Hafnium", "Rhenium", "Osmium", "Technetium", "Promethium", "Gadolinium", "Lutetium", "Seaborgium", "Oganesson", "Tennessine", "Moscovium", "Nihonium", "Thulium", "Holmium", "Samarium", "Europium", "Rubidium", "Scandium", "Tellurium", "Bismuth", "Antimony"],
  },
  {
    category: "Music",
    prompt: "Name a musical instrument",
    obvious: ["Guitar", "Piano", "Drums|Drum", "Violin", "Flute", "Trumpet"],
    solid: ["Saxophone|Sax", "Cello", "Bass|Bass guitar", "Clarinet", "Harp", "Ukulele", "Keyboard", "Trombone", "Harmonica", "Tuba", "Banjo", "Xylophone"],
    rare: ["Oboe", "Bassoon", "French horn|Horn", "Viola", "Double bass|Contrabass|Upright bass", "Accordion", "Mandolin", "Tambourine", "Bagpipes|Bagpipe", "Sitar", "Organ", "Triangle", "Piccolo", "Marimba", "Synthesizer|Synth", "Didgeridoo"],
    longShot: ["Theremin", "Hurdy-gurdy|Hurdy gurdy", "Glockenspiel", "Celesta", "Bandoneon", "Erhu", "Oud", "Koto", "Shamisen", "Kalimba|Mbira|Thumb piano", "Hang drum|Handpan", "Zither", "Dulcimer", "Sackbut", "Ocarina", "Tabla", "Balalaika", "Bouzouki", "Cajon", "Sousaphone", "Glass harmonica|Armonica", "Duduk", "Shakuhachi"],
  },
  {
    category: "Space",
    prompt: "Name a planet or moon in our solar system",
    obvious: ["Earth", "Mars", "Jupiter", "Saturn", "The Moon|Moon|Luna"],
    solid: ["Venus", "Mercury", "Neptune", "Uranus", "Pluto"],
    rare: ["Titan", "Europa", "Io", "Ganymede", "Callisto", "Phobos", "Deimos", "Enceladus", "Triton", "Charon"],
    longShot: ["Miranda", "Oberon", "Titania", "Ariel", "Umbriel", "Iapetus", "Rhea", "Dione", "Tethys", "Mimas", "Hyperion", "Phoebe", "Amalthea", "Proteus", "Nereid", "Himalia", "Pandora", "Prometheus", "Janus", "Epimetheus", "Metis", "Thebe", "Larissa", "Puck"],
  },
  {
    category: "Food",
    prompt: "Name a kind of cheese",
    obvious: ["Cheddar", "Mozzarella", "Parmesan|Parmigiano Reggiano|Parmigiano", "Swiss"],
    solid: ["Brie", "Feta", "Gouda", "Camembert", "Blue cheese|Blue", "Ricotta", "Cream cheese", "Provolone", "Monterey Jack|Jack", "American", "Colby", "Goat cheese|Chevre"],
    rare: ["Gruyere", "Emmental|Emmentaler", "Roquefort", "Gorgonzola", "Stilton", "Halloumi", "Manchego", "Mascarpone", "Pecorino|Pecorino Romano", "Havarti", "Edam", "Cottage cheese", "Paneer", "Burrata", "Muenster|Munster", "Pepper Jack"],
    longShot: ["Taleggio", "Epoisses", "Raclette", "Comte", "Reblochon", "Limburger", "Wensleydale", "Red Leicester", "Caciocavallo", "Asiago", "Fontina", "Jarlsberg", "Queso Oaxaca|Oaxaca", "Cotija", "Casu marzu", "Morbier", "Stracchino", "Scamorza", "Labneh", "Mimolette", "Leyden", "Brunost|Gjetost", "Lancashire", "Port Salut"],
  },
  {
    category: "Animals",
    prompt: "Name a bird",
    obvious: ["Eagle", "Penguin", "Parrot", "Owl", "Pigeon", "Chicken", "Crow"],
    solid: ["Robin", "Sparrow", "Flamingo", "Duck", "Swan", "Hawk", "Ostrich", "Peacock|Peafowl", "Seagull|Gull", "Hummingbird", "Turkey", "Blue jay|Jay", "Falcon"],
    rare: ["Pelican", "Toucan", "Woodpecker", "Cardinal", "Goose", "Stork", "Heron", "Kiwi", "Emu", "Vulture", "Raven", "Magpie", "Kingfisher", "Albatross", "Puffin", "Canary", "Finch", "Starling", "Cockatoo"],
    longShot: ["Shoebill", "Hoatzin", "Cassowary", "Kakapo", "Lyrebird", "Bowerbird", "Oystercatcher", "Nightjar", "Potoo", "Frigatebird", "Hoopoe", "Bee-eater|Bee eater", "Wryneck", "Dipper", "Kea", "Quetzal", "Tui", "Takahe", "Roadrunner", "Secretary bird", "Ibis", "Spoonbill", "Bittern", "Avocet", "Shrike", "Waxwing"],
  },
  {
    category: "Tech",
    prompt: "Name a programming language",
    obvious: ["Python", "JavaScript|JS", "Java", "C++|C plus plus|cpp", "C"],
    solid: ["C#|C sharp|csharp", "TypeScript|TS", "Ruby", "PHP", "Swift", "Go|Golang", "Rust", "Kotlin", "SQL", "HTML"],
    rare: ["Perl", "Scala", "R", "MATLAB", "Lua", "Haskell", "Dart", "Objective-C|Objective C|ObjC", "Assembly|Asm", "Bash|Shell", "Visual Basic|VB|VBA", "Fortran", "COBOL", "Pascal", "Elixir", "Julia", "Groovy"],
    longShot: ["Erlang", "OCaml", "Prolog", "Lisp|Common Lisp", "Clojure", "Scheme", "Racket", "Smalltalk", "Ada", "Zig", "Nim", "Crystal", "Elm", "F#|F sharp", "APL", "Forth", "Brainfuck", "Haxe", "Solidity", "Simula", "ALGOL", "BASIC", "Delphi", "Raku", "Gleam", "Odin", "Idris", "Agda", "Coq|Rocq"],
  },
  {
    category: "Games",
    prompt: "Name a board game",
    obvious: ["Monopoly", "Chess", "Scrabble", "Checkers|Draughts", "Clue|Cluedo"],
    solid: ["Risk", "Catan|Settlers of Catan", "Battleship", "Connect Four|Connect 4", "Snakes and Ladders|Chutes and Ladders", "Trivial Pursuit", "Operation", "Candy Land|Candyland", "Guess Who", "Backgammon", "Sorry", "Game of Life|The Game of Life|Life"],
    rare: ["Ticket to Ride", "Pandemic", "Go", "Mahjong", "Stratego", "Othello|Reversi", "Carcassonne", "Ludo", "Pictionary", "Mouse Trap", "Jenga", "Codenames", "Dominoes", "Chinese Checkers", "Yahtzee", "Mancala"],
    longShot: ["Azul", "Wingspan", "Gloomhaven", "Terraforming Mars", "Agricola", "Puerto Rico", "Twilight Struggle", "Dominion", "Splendor", "Diplomacy", "Hive", "Blokus", "Tsuro", "Power Grid", "Brass", "Root", "Spirit Island", "Arkham Horror", "Small World", "Patchwork", "Shogi", "Xiangqi", "Senet", "Hnefatafl", "Nine Men's Morris|Nine Mens Morris", "Crokinole", "Kingdomino"],
  },
  {
    category: "Mythology",
    prompt: "Name a Greek god, goddess or Titan",
    obvious: ["Zeus", "Poseidon", "Hades", "Athena", "Aphrodite"],
    solid: ["Apollo", "Ares", "Hermes", "Hera", "Artemis", "Demeter", "Dionysus", "Hephaestus", "Kronos|Cronus"],
    rare: ["Persephone", "Hestia", "Eros", "Nike", "Gaia|Gaea", "Atlas", "Prometheus", "Nemesis", "Hecate|Hekate", "Pan", "Helios", "Selene", "Eos", "Rhea", "Uranus|Ouranos", "Hypnos", "Thanatos"],
    longShot: ["Mnemosyne", "Tyche", "Hyperion", "Themis", "Oceanus", "Tethys", "Iapetus", "Coeus", "Crius", "Theia", "Phoebe", "Erebus", "Nyx", "Chaos", "Eris", "Asclepius", "Hebe", "Iris", "Morpheus", "Nereus", "Triton", "Boreas", "Zephyrus", "Aeolus", "Metis", "Styx", "Ananke", "Chronos"],
  },
  {
    category: "Geography",
    prompt: "Name a European capital city",
    obvious: ["London", "Paris", "Rome", "Berlin", "Madrid"],
    solid: ["Amsterdam", "Lisbon", "Dublin", "Athens", "Vienna", "Brussels", "Moscow", "Stockholm", "Oslo", "Copenhagen", "Prague", "Warsaw"],
    rare: ["Budapest", "Helsinki", "Edinburgh", "Bern", "Kyiv|Kiev", "Bucharest", "Belgrade", "Reykjavik", "Zagreb", "Sofia", "Cardiff", "Bratislava", "Monaco"],
    longShot: ["Vaduz", "Valletta", "Ljubljana", "Tallinn", "Riga", "Vilnius", "Chisinau", "Minsk", "Tirana", "Skopje", "Podgorica", "Sarajevo", "Andorra la Vella", "San Marino", "Luxembourg", "Nicosia", "Pristina", "Tbilisi", "Yerevan", "Baku", "Belfast", "Vatican City"],
  },
  {
    category: "Nature",
    prompt: "Name a gemstone",
    obvious: ["Diamond", "Ruby", "Emerald", "Sapphire"],
    solid: ["Amethyst", "Pearl", "Opal", "Topaz", "Jade", "Garnet", "Turquoise", "Aquamarine"],
    rare: ["Onyx", "Quartz|Rose quartz", "Peridot", "Citrine", "Tanzanite", "Moonstone", "Amber", "Lapis lazuli|Lapis", "Tourmaline", "Jasper", "Agate", "Obsidian", "Malachite"],
    longShot: ["Alexandrite", "Tsavorite", "Spinel", "Zircon", "Kunzite", "Morganite", "Iolite", "Beryl", "Chrysoberyl", "Sunstone", "Labradorite", "Rhodochrosite", "Sodalite", "Benitoite", "Painite", "Taaffeite", "Jet", "Carnelian", "Bloodstone|Heliotrope", "Hematite", "Kyanite", "Chrysoprase", "Larimar", "Sugilite"],
  },
  {
    category: "Food",
    prompt: "Name a vegetable",
    obvious: ["Carrot", "Broccoli", "Potato", "Tomato", "Lettuce", "Onion", "Cucumber"],
    solid: ["Spinach", "Corn", "Peas|Pea", "Pepper|Bell pepper", "Cabbage", "Cauliflower", "Celery", "Garlic", "Mushroom", "Zucchini|Courgette", "Green beans|Green bean", "Sweet potato"],
    rare: ["Eggplant|Aubergine", "Asparagus", "Kale", "Brussels sprouts|Brussels sprout", "Beetroot|Beet", "Radish", "Leek", "Artichoke", "Squash|Butternut squash", "Pumpkin", "Turnip", "Okra", "Parsnip", "Bok choy|Pak choi", "Arugula|Rocket"],
    longShot: ["Kohlrabi", "Celeriac", "Salsify", "Jicama", "Fennel", "Rutabaga|Swede", "Chayote", "Romanesco", "Daikon", "Taro", "Cassava|Yuca", "Burdock", "Sunchoke|Jerusalem artichoke", "Endive", "Radicchio", "Watercress", "Samphire", "Fiddlehead|Fiddleheads", "Lotus root", "Bitter melon|Bitter gourd", "Cardoon", "Mizuna", "Tomatillo", "Chard|Swiss chard"],
  },
  {
    category: "Sport",
    prompt: "Name a sport played with a ball",
    obvious: ["Soccer|Football", "Basketball", "Tennis", "Baseball", "Golf", "Volleyball"],
    solid: ["American football", "Rugby", "Cricket", "Hockey|Field hockey", "Table tennis|Ping pong", "Bowling", "Handball", "Softball", "Water polo", "Badminton"],
    rare: ["Lacrosse", "Squash", "Polo", "Dodgeball", "Netball", "Racquetball", "Billiards|Pool|Snooker", "Croquet", "Kickball", "Pickleball", "Bocce", "Futsal", "Beach volleyball"],
    longShot: ["Sepak takraw", "Hurling", "Gaelic football", "Jai alai|Pelota", "Korfball", "Bandy", "Shinty", "Pesapallo", "Rounders", "Kabaddi", "Goalball", "Petanque|Boules", "Fistball", "Teqball", "Footvolley", "Camogie", "Roller derby", "Underwater rugby", "Cuju", "Tchoukball", "Padel", "Bossaball", "Kemari"],
  },
  {
    category: "Colours",
    prompt: "Name a colour",
    obvious: ["Red", "Blue", "Green", "Yellow", "Black", "White", "Purple"],
    solid: ["Orange", "Pink", "Brown", "Grey|Gray", "Gold", "Silver", "Navy", "Teal", "Turquoise"],
    rare: ["Magenta", "Cyan", "Maroon", "Beige", "Lavender", "Violet", "Indigo", "Crimson", "Coral", "Olive", "Burgundy", "Mint", "Ivory", "Lime", "Peach", "Tan"],
    longShot: ["Chartreuse", "Vermilion", "Cerulean", "Puce", "Mauve", "Ochre", "Sienna", "Umber", "Taupe", "Celadon", "Fuchsia", "Periwinkle", "Aubergine", "Gamboge", "Viridian", "Cobalt", "Ultramarine", "Saffron", "Sepia", "Amaranth", "Cinnabar", "Heliotrope", "Wenge", "Glaucous", "Smaragdine", "Xanadu"],
  },
];

export const LONG_SHOT_TIER_POINTS: Record<LongShotTier, number> = {
  obvious: 100,
  solid: 300,
  rare: 600,
  longShot: 1000,
};

export const LONG_SHOT_TIERS: LongShotTier[] = ["obvious", "solid", "rare", "longShot"];

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
};

export type CompiledPrompt = {
  category: string;
  prompt: string;
  answers: CompiledAnswer[];
};

export const compilePrompt = (raw: LongShotPrompt): CompiledPrompt => {
  const answers: CompiledAnswer[] = [];
  const seenKeys = new Set<string>();
  for (const tier of LONG_SHOT_TIERS) {
    for (const entry of raw[tier]) {
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
